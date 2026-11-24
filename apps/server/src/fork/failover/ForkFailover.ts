// @effect-diagnostics nodeBuiltinImport:off -- O_NOFOLLOW, O_NONBLOCK, lstat, realpath, and O_CREAT|O_EXCL 0600 require direct fs flags.
// Fork-only: quota model failover config, recent events, and automatic/manual switch service
// persisted atomically in `<stateDir>/fork/failover.json`.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import {
  CommandId,
  FORK_FAILOVER_DETAIL_MAX_LENGTH,
  FORK_FAILOVER_MAX_FILE_BYTES,
  FORK_FAILOVER_MAX_OPTIONS,
  FORK_FAILOVER_MODEL_MAX_LENGTH,
  FORK_FAILOVER_OPTION_KEY_MAX_LENGTH,
  FORK_FAILOVER_OPTION_VALUE_MAX_LENGTH,
  FORK_FAILOVER_REASON_MAX_LENGTH,
  type ForkFailoverConfig,
  ForkFailoverError,
  type ForkFailoverEvent,
  ForkFailoverSetConfigInput,
  type ForkFailoverState,
  ForkFailoverSwitchThreadInput,
  type ForkFailoverSwitchThreadResult,
  type ForkFailoverTarget,
  isProviderNativeSubagentThread,
  MessageId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type ProjectId,
  type ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  type ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { latestRootProviderFailure } from "@t3tools/shared/orchestrationV2ThreadError";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import { forkParked } from "../../serverActivation.ts";
import * as ServerSettings from "../../serverSettings.ts";
import {
  type AvailableProviderCatalog,
  buildFailoverResumePrompt,
  isUsageLimitFailure,
  selectFailoverTarget,
} from "./policy.ts";
import {
  decodeStoredFailoverState,
  EMPTY_FAILOVER_STATE,
  serializeFailoverState,
  type StoredFailoverState,
  toPublicFailoverState,
  validateFailoverConfigBytes,
  withAppendedEvent,
  withUpdatedConfig,
} from "./store.ts";

export class ForkFailover extends Context.Service<
  ForkFailover,
  {
    readonly getState: Effect.Effect<ForkFailoverState, ForkFailoverError>;
    readonly setConfig: (
      input: ForkFailoverSetConfigInput,
    ) => Effect.Effect<ForkFailoverConfig, ForkFailoverError>;
    readonly switchThread: (
      input: ForkFailoverSwitchThreadInput,
    ) => Effect.Effect<ForkFailoverSwitchThreadResult, ForkFailoverError>;
    readonly handleDomainEvent: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/fork/failover/ForkFailover") {}

const decodeSetConfigInput = Schema.decodeUnknownEffect(ForkFailoverSetConfigInput);
const decodeSwitchThreadInput = Schema.decodeUnknownEffect(ForkFailoverSwitchThreadInput);

const READ_FLAGS =
  NodeFS.constants.O_RDONLY |
  (NodeFS.constants.O_NOFOLLOW ?? 0) |
  (NodeFS.constants.O_NONBLOCK ?? 0);

const WRITE_TEMP_FLAGS =
  NodeFS.constants.O_CREAT |
  NodeFS.constants.O_EXCL |
  NodeFS.constants.O_WRONLY |
  (NodeFS.constants.O_NOFOLLOW ?? 0);

const MAX_HANDLED_RUN_KEYS = 2048;
const MAX_MEMORY_EVENTS_PER_THREAD = 32;
const MAX_MEMORY_THREADS = 512;

const MANUAL_SWITCH_BLOCKED_RUN_STATUSES = new Set<OrchestrationV2Run["status"]>([
  "preparing",
  "starting",
  "running",
  "waiting",
]);
const BUSY_OR_QUEUED_RUN_STATUSES = new Set<OrchestrationV2Run["status"]>([
  "preparing",
  "starting",
  "running",
  "waiting",
  "queued",
]);

const streamRetryBackoff = Schedule.exponential("5 seconds").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.minutes(10))),
  ),
);

const invalidInput = (message: string) =>
  new ForkFailoverError({ reason: "invalidInput", message });

const storageFailed = (message: string) =>
  new ForkFailoverError({ reason: "storageFailed", message });

class FailoverFsError extends Schema.TaggedError<FailoverFsError>()("FailoverFsError", {
  code: Schema.UndefinedOr(Schema.String),
  cause: Schema.Defect(),
}) {}

const errnoCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : undefined
    : undefined;

const attemptFs = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new FailoverFsError({ code: errnoCode(cause), cause }),
  });

const failStorageWithLog = (publicMessage: string, logMessage: string, cause: unknown) =>
  Effect.logWarning(logMessage, { cause }).pipe(
    Effect.andThen(Effect.fail(storageFailed(publicMessage))),
  );

const tryFs = <A>(run: () => Promise<A>, publicMessage: string, logMessage: string) =>
  attemptFs(run).pipe(
    Effect.catch((error) => failStorageWithLog(publicMessage, logMessage, error.cause)),
  );

const sanitizeSingleLine = (text: string, maxLength: number): string =>
  text
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);

function toFailoverTarget(selection: ModelSelection): ForkFailoverTarget {
  const model = sanitizeSingleLine(selection.model, FORK_FAILOVER_MODEL_MAX_LENGTH) || "default";
  const rawOptions = Array.isArray(selection.options) ? selection.options : [];
  const seen = new Set<string>();
  const options: Array<{ readonly id: string; readonly value: string | boolean }> = [];
  for (const option of rawOptions) {
    if (options.length >= FORK_FAILOVER_MAX_OPTIONS) break;
    const id = sanitizeSingleLine(option.id, FORK_FAILOVER_OPTION_KEY_MAX_LENGTH);
    if (id.length === 0 || seen.has(id)) continue;
    if (typeof option.value === "boolean") {
      seen.add(id);
      options.push({ id, value: option.value });
    } else {
      const value = sanitizeSingleLine(option.value, FORK_FAILOVER_OPTION_VALUE_MAX_LENGTH);
      if (value.length === 0) continue;
      seen.add(id);
      options.push({ id, value });
    }
  }
  return {
    instanceId: selection.instanceId,
    model,
    ...(options.length === 0 ? {} : { options }),
  };
}

function toModelSelection(target: ForkFailoverTarget): ModelSelection {
  return {
    instanceId: target.instanceId,
    model: target.model,
    ...(target.options === undefined ? {} : { options: target.options }),
  };
}

async function readRegularBounded(
  handle: NodeFSP.FileHandle,
  maxBytes: number,
): Promise<
  | { readonly kind: "ok"; readonly text: string }
  | { readonly kind: "notFile" }
  | { readonly kind: "tooLarge" }
> {
  const info = await handle.stat();
  if (!info.isFile()) return { kind: "notFile" };
  if (info.size > maxBytes) return { kind: "tooLarge" };
  // Read up to maxBytes + 1 so concurrent growth past the cap is caught without trusting stat alone.
  const buffer = new Uint8Array(maxBytes + 1);
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  if (total > maxBytes) return { kind: "tooLarge" };
  return { kind: "ok", text: new TextDecoder("utf-8").decode(buffer.subarray(0, total)) };
}

async function writeAll(handle: NodeFSP.FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
    if (bytesWritten <= 0) throw new Error("Short write while persisting failover store.");
    offset += bytesWritten;
  }
}

async function syncDirectoryBestEffort(dirPath: string): Promise<void> {
  let handle: NodeFSP.FileHandle | undefined;
  try {
    handle = await NodeFSP.open(
      dirPath,
      NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
    );
    await handle.sync();
  } catch {
    // Some filesystems disallow directory fsync; the atomic rename already landed.
  } finally {
    await handle?.close().catch(() => {});
  }
}

function isThreadNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    ((error as { _tag?: unknown })._tag === "OrchestratorThreadNotFoundError" ||
      (error as { _tag?: unknown })._tag === "ProjectionStoreThreadNotFoundError" ||
      (error as { _tag?: unknown })._tag === "ThreadManagementThreadNotFoundError")
  );
}

/** @public */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const instanceRegistry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  const storeLock = yield* Semaphore.make(1);
  const threadLocks = yield* KeyedLock.make<ThreadId>();
  const handledRuns = new Set<string>();
  const memoryEventsByThread = new Map<ThreadId, ReadonlyArray<ForkFailoverEvent>>();

  const resolvedStateDir = path.resolve(config.stateDir);
  const forkDir = path.resolve(resolvedStateDir, "fork");
  const filePath = path.resolve(forkDir, "failover.json");
  if (path.dirname(filePath) !== forkDir || path.dirname(forkDir) !== resolvedStateDir) {
    return yield* storageFailed("Failover store path is invalid.");
  }

  const rememberHandledRun = (key: string) => {
    handledRuns.add(key);
    if (handledRuns.size > MAX_HANDLED_RUN_KEYS) {
      const oldest = handledRuns.values().next().value;
      if (oldest !== undefined) handledRuns.delete(oldest);
    }
  };

  const recordMemoryEvent = (event: ForkFailoverEvent) => {
    const existing = memoryEventsByThread.get(event.threadId) ?? [];
    const next = [event, ...existing.filter((item) => item.id !== event.id)].slice(
      0,
      MAX_MEMORY_EVENTS_PER_THREAD,
    );
    memoryEventsByThread.delete(event.threadId);
    memoryEventsByThread.set(event.threadId, next);
    if (memoryEventsByThread.size > MAX_MEMORY_THREADS) {
      const oldest = memoryEventsByThread.keys().next().value;
      if (oldest !== undefined) memoryEventsByThread.delete(oldest);
    }
  };

  const mergedRecentEventsForThread = (
    threadId: ThreadId,
    persisted: ReadonlyArray<ForkFailoverEvent>,
  ): ReadonlyArray<ForkFailoverEvent> => {
    const memory = memoryEventsByThread.get(threadId);
    if (memory === undefined || memory.length === 0) return persisted;
    const seen = new Set<string>();
    const combined: ForkFailoverEvent[] = [];
    for (const event of memory) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      combined.push(event);
    }
    for (const event of persisted) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      combined.push(event);
    }
    return combined;
  };

  const ensureSafeForkDir = Effect.fn("ForkFailover.ensureSafeForkDir")(function* (options: {
    readonly create: boolean;
  }) {
    const existing = yield* attemptFs(() => NodeFSP.lstat(forkDir)).pipe(
      Effect.catch((error) =>
        error.code === "ENOENT"
          ? Effect.succeed(null)
          : failStorageWithLog(
              "Could not access failover store directory.",
              "fork failover lstat failed on fork directory",
              error.cause,
            ),
      ),
    );

    if (existing === null) {
      if (!options.create) return false;
      yield* tryFs(
        () => NodeFSP.mkdir(resolvedStateDir, { recursive: true }),
        "Could not prepare failover store directory.",
        "fork failover mkdir failed on stateDir",
      );
      yield* attemptFs(() => NodeFSP.mkdir(forkDir, { mode: 0o700 })).pipe(
        Effect.catch((error) =>
          error.code === "EEXIST"
            ? Effect.void
            : failStorageWithLog(
                "Could not prepare failover store directory.",
                "fork failover mkdir failed on fork directory",
                error.cause,
              ),
        ),
      );
    }

    const dirInfo = yield* tryFs(
      () => NodeFSP.lstat(forkDir),
      "Could not inspect failover store directory.",
      "fork failover lstat failed after preparing fork directory",
    );
    if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) {
      return yield* failStorageWithLog(
        "Failover store directory is invalid.",
        "fork failover refused non-directory or symlink fork directory",
        { isSymlink: dirInfo.isSymbolicLink(), isDirectory: dirInfo.isDirectory() },
      );
    }

    const [realState, realFork] = yield* tryFs(
      () => Promise.all([NodeFSP.realpath(resolvedStateDir), NodeFSP.realpath(forkDir)]),
      "Could not verify failover store directory.",
      "fork failover realpath check failed",
    );
    if (path.dirname(realFork) !== realState || path.basename(realFork) !== "fork") {
      return yield* failStorageWithLog(
        "Failover store directory is invalid.",
        "fork failover resolved fork directory escaped state directory",
        { realState, realFork },
      );
    }

    if (options.create && platform !== "win32") {
      yield* tryFs(
        () => NodeFSP.chmod(forkDir, 0o700),
        "Could not secure failover store directory.",
        "fork failover chmod 0700 failed on fork directory",
      );
    }

    return true;
  });

  const readState = Effect.fn("ForkFailover.readState")(function* () {
    const dirExists = yield* ensureSafeForkDir({ create: false });
    if (!dirExists) return EMPTY_FAILOVER_STATE;

    const opened = yield* attemptFs(() => NodeFSP.open(filePath, READ_FLAGS)).pipe(
      Effect.catch((error) =>
        error.code === "ENOENT"
          ? Effect.succeed(null)
          : failStorageWithLog(
              "Could not read failover store.",
              "fork failover open failed for read",
              error.cause,
            ),
      ),
    );
    if (opened === null) return EMPTY_FAILOVER_STATE;

    const readResult = yield* Effect.ensuring(
      tryFs(
        () => readRegularBounded(opened, FORK_FAILOVER_MAX_FILE_BYTES),
        "Could not read failover store.",
        "fork failover bounded read failed",
      ),
      Effect.promise(() => opened.close().catch(() => {})),
    );

    if (readResult.kind === "notFile") {
      return yield* failStorageWithLog(
        "Failover store is not a regular file.",
        "fork failover refused non-regular file on read",
        { kind: readResult.kind },
      );
    }
    if (readResult.kind === "tooLarge") {
      return yield* new ForkFailoverError({
        reason: "limitExceeded",
        message: `Failover store exceeds the ${FORK_FAILOVER_MAX_FILE_BYTES}-byte limit.`,
      });
    }

    return yield* decodeStoredFailoverState(readResult.text).pipe(
      Effect.catch((error) =>
        failStorageWithLog(
          "Failover store is invalid.",
          "fork failover store decode failed",
          error,
        ),
      ),
    );
  });

  const writeState = Effect.fn("ForkFailover.writeState")(function* (state: StoredFailoverState) {
    const serialized = serializeFailoverState(state);
    if (!serialized.ok) return yield* serialized.error;

    yield* ensureSafeForkDir({ create: true });

    const existingFile = yield* attemptFs(() => NodeFSP.lstat(filePath)).pipe(
      Effect.catch((error) =>
        error.code === "ENOENT"
          ? Effect.succeed(null)
          : failStorageWithLog(
              "Could not inspect failover store.",
              "fork failover lstat failed on target file",
              error.cause,
            ),
      ),
    );
    if (existingFile !== null && (existingFile.isSymbolicLink() || !existingFile.isFile())) {
      return yield* failStorageWithLog(
        "Failover store target is not a regular file.",
        "fork failover refused symlink or non-regular file on write",
        { isSymlink: existingFile.isSymbolicLink(), isFile: existingFile.isFile() },
      );
    }

    const tempPath = path.join(forkDir, `.failover.${SecureRandom.uuidV4Unsafe()}.tmp`);
    const bytes = new TextEncoder().encode(serialized.json);
    let renamed = false;

    yield* Effect.ensuring(
      Effect.gen(function* () {
        const handle = yield* tryFs(
          () => NodeFSP.open(tempPath, WRITE_TEMP_FLAGS, 0o600),
          "Could not persist failover store.",
          "fork failover open temp file failed",
        );
        yield* Effect.ensuring(
          tryFs(
            async () => {
              if (platform !== "win32") {
                await handle.chmod(0o600);
              }
              await writeAll(handle, bytes);
              await handle.sync();
            },
            "Could not persist failover store.",
            "fork failover temp file write/sync failed",
          ),
          Effect.promise(() => handle.close().catch(() => {})),
        );
        yield* tryFs(
          () => NodeFSP.rename(tempPath, filePath),
          "Could not persist failover store.",
          "fork failover atomic rename failed",
        );
        renamed = true;
        if (platform !== "win32") {
          yield* Effect.promise(() => syncDirectoryBestEffort(forkDir));
        }
      }),
      Effect.suspend(() =>
        renamed ? Effect.void : Effect.promise(() => NodeFSP.unlink(tempPath).catch(() => {})),
      ),
    );
  });

  const appendEventLocked = Effect.fn("ForkFailover.appendEventLocked")(function* (
    event: ForkFailoverEvent,
  ) {
    yield* storeLock.withPermits(1)(
      Effect.gen(function* () {
        const state = yield* readState();
        const updated = withAppendedEvent(state, event, event.occurredAt);
        yield* writeState(updated);
      }),
    );
  });

  const resolveAvailableProviders = Effect.fn("ForkFailover.resolveAvailableProviders")(function* (
    projectId: ProjectId,
  ): Effect.fn.Return<AvailableProviderCatalog, ForkFailoverError> {
    const [liveInstances, providers, settings] = yield* Effect.all([
      instanceRegistry.listInstances,
      providerRegistry.getProviders,
      serverSettings.getSettings.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("fork failover failed to read server settings", { cause }).pipe(
            Effect.andThen(
              Effect.fail(
                new ForkFailoverError({
                  reason: "switchFailed",
                  message: "Could not read provider availability settings.",
                }),
              ),
            ),
          ),
        ),
      ),
    ]);
    const liveIds = new Set(liveInstances.map((instance) => instance.instanceId));
    const available = new Map<ProviderInstanceId, ReadonlySet<string> | null>();
    for (const provider of providers) {
      if (
        liveIds.has(provider.instanceId) &&
        provider.enabled &&
        provider.installed &&
        provider.status !== "disabled" &&
        provider.status !== "error" &&
        provider.availability !== "unavailable" &&
        provider.auth.status !== "unauthenticated" &&
        resolveProjectProviderInstanceEnabled(settings, projectId, provider.instanceId)
      ) {
        const knownModels =
          provider.models.length === 0
            ? null
            : new Set(
                provider.models
                  .filter((model) => model.isLegacy !== true)
                  .map((model) => model.slug),
              );
        available.set(provider.instanceId, knownModels);
      }
    }
    return available;
  });

  const executeFailover = Effect.fn("ForkFailover.executeFailover")(function* (input: {
    readonly trigger: "auto_usage_limit" | "manual";
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly fromSelection: ForkFailoverTarget;
    readonly failure?: {
      readonly class:
        | "usage_limit"
        | "provider_error"
        | "transport_error"
        | "permission_error"
        | "validation_error"
        | "unknown";
      readonly code: string | null;
      readonly resetAt?: string | null | undefined;
    } | null;
    readonly failedRunId?: string;
    readonly explicitTarget?: ForkFailoverTarget;
    readonly resume: boolean;
  }) {
    const state = yield* storeLock.withPermits(1)(readState());
    const availableProviders = yield* resolveAvailableProviders(input.projectId);
    const nowMs = yield* Clock.currentTimeMillis;
    const nowIso = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
    const reason = sanitizeSingleLine(
      input.trigger === "auto_usage_limit" ? "usage_limit" : "manual",
      FORK_FAILOVER_REASON_MAX_LENGTH,
    );
    const resetAt = input.failure?.resetAt ?? null;
    const recentEvents = mergedRecentEventsForThread(input.threadId, state.recentEvents);

    const decision = selectFailoverTarget({
      config: state.config,
      trigger: input.trigger,
      ...(input.failure === undefined ? {} : { failure: input.failure }),
      threadId: input.threadId,
      currentSelection: input.fromSelection,
      availableProviders,
      recentEvents,
      nowMs,
      ...(input.explicitTarget === undefined ? {} : { explicitTarget: input.explicitTarget }),
    });

    if (decision.decision === "skip") {
      if (
        input.trigger === "auto_usage_limit" &&
        (decision.skipReason === "loop_guard" || decision.skipReason === "no_eligible_target")
      ) {
        const skippedEvent: ForkFailoverEvent = {
          id: `failover:${SecureRandom.uuidV4Unsafe()}`,
          threadId: input.threadId,
          fromSelection: input.fromSelection,
          toSelection: null,
          reason,
          resetAt,
          status: "skipped",
          detail: sanitizeSingleLine(decision.detail, FORK_FAILOVER_DETAIL_MAX_LENGTH),
          occurredAt: nowIso,
        };
        // Do not push `skipped` events into the in-memory anti-loop ring so repeated skips cannot
        // evict real `switched`/`failed` records when disk persistence is degraded.
        yield* appendEventLocked(skippedEvent).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("fork failover failed to record skipped event", {
              threadId: input.threadId,
              cause,
            }),
          ),
        );
      }
      if (input.trigger === "manual") {
        return yield* new ForkFailoverError({
          reason: "noCandidate",
          message: decision.detail,
        });
      }
      return null;
    }

    const nextSelection = toModelSelection(decision.target);
    const commandKey =
      input.trigger === "auto_usage_limit" && input.failedRunId !== undefined
        ? `${input.threadId}:${input.failedRunId}`
        : `${input.threadId}:${SecureRandom.uuidV4Unsafe()}`;

    const setSelectionOutcome = yield* threads
      .dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make(`fork-failover-set:${commandKey}`),
        threadId: input.threadId,
        modelSelection: nextSelection,
      })
      .pipe(Effect.result);

    let dispatchFailure: unknown | null =
      setSelectionOutcome._tag === "Failure" ? setSelectionOutcome.failure : null;

    if (dispatchFailure === null && input.resume) {
      const resumeId = `fork-failover-resume:${commandKey}`;
      const resumeOutcome = yield* threads
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(resumeId),
          messageId: MessageId.make(resumeId),
          threadId: input.threadId,
          text: buildFailoverResumePrompt(input.fromSelection, decision.target),
          attachments: [],
          modelSelection: nextSelection,
          dispatchMode: { type: "start_immediately" },
          createdBy: "agent",
          creationSource: "server",
        })
        .pipe(Effect.result);

      if (resumeOutcome._tag === "Failure") {
        dispatchFailure = resumeOutcome.failure;
        // Compensate so a failed resume never leaves the thread mutated onto the backup model.
        yield* threads
          .dispatch({
            type: "thread.model-selection.set",
            commandId: CommandId.make(`fork-failover-rollback:${commandKey}`),
            threadId: input.threadId,
            modelSelection: toModelSelection(input.fromSelection),
          })
          .pipe(
            Effect.catchCause((rollbackCause) =>
              Effect.logWarning("fork failover rollback after resume failure failed", {
                threadId: input.threadId,
                fromInstanceId: input.fromSelection.instanceId,
                fromModel: input.fromSelection.model,
                cause: rollbackCause,
              }),
            ),
          );
      }
    }

    if (dispatchFailure !== null) {
      yield* Effect.logWarning("fork failover command dispatch failed", {
        threadId: input.threadId,
        trigger: input.trigger,
        targetInstanceId: decision.target.instanceId,
        targetModel: decision.target.model,
        cause: dispatchFailure,
      });
      const failedEvent: ForkFailoverEvent = {
        id: `failover:${SecureRandom.uuidV4Unsafe()}`,
        threadId: input.threadId,
        fromSelection: input.fromSelection,
        toSelection: decision.target,
        reason,
        resetAt,
        status: "failed",
        detail: "Could not switch the thread to the backup model.",
        occurredAt: nowIso,
      };
      recordMemoryEvent(failedEvent);
      yield* appendEventLocked(failedEvent).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("fork failover failed to record failed event", {
            threadId: input.threadId,
            cause,
          }),
        ),
      );
      if (input.trigger === "manual") {
        return yield* new ForkFailoverError({
          reason: "switchFailed",
          message: "Could not switch the thread to the backup model.",
        });
      }
      return null;
    }

    const detail = sanitizeSingleLine(
      input.resume
        ? `Switched to ${decision.target.instanceId}/${decision.target.model} and resumed interrupted turn.`
        : `Switched to ${decision.target.instanceId}/${decision.target.model}.`,
      FORK_FAILOVER_DETAIL_MAX_LENGTH,
    );
    const switchedEvent: ForkFailoverEvent = {
      id: `failover:${SecureRandom.uuidV4Unsafe()}`,
      threadId: input.threadId,
      fromSelection: input.fromSelection,
      toSelection: decision.target,
      reason,
      resetAt,
      status: "switched",
      detail,
      occurredAt: nowIso,
    };
    recordMemoryEvent(switchedEvent);
    yield* appendEventLocked(switchedEvent).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("fork failover failed to persist switched event", {
          threadId: input.threadId,
          cause,
        }),
      ),
    );

    return {
      event: switchedEvent,
      selection: decision.target,
      resumed: input.resume,
    } satisfies ForkFailoverSwitchThreadResult;
  });

  const getState = Effect.fn("ForkFailover.getState")(function* () {
    const state = yield* storeLock.withPermits(1)(readState());
    return toPublicFailoverState(state);
  });

  const setConfig = Effect.fn("ForkFailover.setConfig")(function* (
    input: ForkFailoverSetConfigInput,
  ) {
    const parsed = yield* decodeSetConfigInput(input).pipe(
      Effect.mapError(() => invalidInput("Invalid failover configuration.")),
    );
    const sizeCheck = validateFailoverConfigBytes(parsed.config);
    if (!sizeCheck.ok) return yield* sizeCheck.error;

    return yield* storeLock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* readState();
        const nowMs = yield* Clock.currentTimeMillis;
        const nowIso = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
        const next = withUpdatedConfig(current, parsed.config, nowIso);
        yield* writeState(next);
        return next.config;
      }),
    );
  });

  const switchThread = Effect.fn("ForkFailover.switchThread")(function* (
    input: ForkFailoverSwitchThreadInput,
  ) {
    const parsed = yield* decodeSwitchThreadInput(input).pipe(
      Effect.mapError(() => invalidInput("Invalid failover switch request.")),
    );
    return yield* threadLocks.withLock(
      parsed.threadId,
      Effect.gen(function* () {
        const projection = yield* threads
          .getThreadRecords(parsed.threadId, ["runs", "turnItems", "runtimeRequests"])
          .pipe(
            Effect.mapError((error) =>
              isThreadNotFoundError(error)
                ? new ForkFailoverError({ reason: "notFound", message: "Thread was not found." })
                : new ForkFailoverError({
                    reason: "switchFailed",
                    message: "Could not load thread state.",
                  }),
            ),
          );
        const { thread, runs, runtimeRequests } = projection;
        if (thread.archivedAt !== null || thread.deletedAt !== null) {
          return yield* new ForkFailoverError({
            reason: "notFound",
            message: "Thread is archived or deleted.",
          });
        }
        if (isProviderNativeSubagentThread(thread)) {
          return yield* invalidInput("Provider-native subagent threads cannot be switched.");
        }
        if (runtimeRequests.some((request) => request.status === "pending")) {
          return yield* new ForkFailoverError({
            reason: "threadBusy",
            message: "Cannot switch model while the thread has pending approval or input requests.",
          });
        }
        if (
          runs.some(
            (run) =>
              MANUAL_SWITCH_BLOCKED_RUN_STATUSES.has(run.status) ||
              (parsed.resume === true && run.status === "queued"),
          )
        ) {
          return yield* new ForkFailoverError({
            reason: "threadBusy",
            message: "Cannot switch model while a turn is active or waiting.",
          });
        }
        const result = yield* executeFailover({
          trigger: "manual",
          threadId: thread.id,
          projectId: thread.projectId,
          fromSelection: toFailoverTarget(thread.modelSelection),
          ...(parsed.target === undefined ? {} : { explicitTarget: parsed.target }),
          resume: parsed.resume === true,
        });
        if (result === null) {
          return yield* new ForkFailoverError({
            reason: "noCandidate",
            message: "No eligible backup model is available for this thread.",
          });
        }
        return result;
      }),
    );
  });

  const handleDomainEvent = Effect.fn("ForkFailover.handleDomainEvent")(function* (
    event: OrchestrationV2DomainEvent,
  ) {
    if (event.type !== "run.updated" || event.payload.status !== "failed") return;
    const failedRunId = event.payload.id;
    const runKey = `${event.threadId}:${failedRunId}`;
    if (handledRuns.has(runKey)) return;

    yield* threadLocks.withLock(
      event.threadId,
      Effect.gen(function* () {
        if (handledRuns.has(runKey)) return;
        const stored = yield* storeLock
          .withPermits(1)(readState())
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("fork failover could not read store on domain event", {
                threadId: event.threadId,
                cause,
              }).pipe(Effect.as(null)),
            ),
          );
        if (stored === null || !stored.config.enabled) return;

        const projection = yield* threads
          .getThreadRecords(event.threadId, ["runs", "turnItems", "runtimeRequests"])
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("fork failover could not inspect failed thread", {
                threadId: event.threadId,
                cause,
              }).pipe(Effect.as(null)),
            ),
          );
        if (projection === null) return;
        const { thread, runs, turnItems, runtimeRequests } = projection;
        if (
          thread.archivedAt !== null ||
          thread.deletedAt !== null ||
          thread.settledOverride === "settled" ||
          isProviderNativeSubagentThread(thread) ||
          runtimeRequests.some((request) => request.status === "pending")
        ) {
          return;
        }
        const failedRun = runs.find((candidate) => candidate.id === failedRunId);
        if (failedRun === undefined || failedRun.status !== "failed") return;
        const latestRun = runs.toSorted((left, right) => right.ordinal - left.ordinal)[0];
        if (latestRun?.id !== failedRun.id) return;
        if (runs.some((run) => BUSY_OR_QUEUED_RUN_STATUSES.has(run.status))) return;

        // If the user already switched the thread's model manually after the failure, respect it.
        if (
          failedRun.modelSelection != null &&
          (thread.modelSelection.instanceId !== failedRun.modelSelection.instanceId ||
            thread.modelSelection.model !== failedRun.modelSelection.model)
        ) {
          rememberHandledRun(runKey);
          return;
        }

        const failure = latestRootProviderFailure(failedRun, turnItems);
        if (!isUsageLimitFailure(failure)) return;

        rememberHandledRun(runKey);
        yield* executeFailover({
          trigger: "auto_usage_limit",
          threadId: thread.id,
          projectId: thread.projectId,
          fromSelection: toFailoverTarget(failedRun.modelSelection ?? thread.modelSelection),
          failure,
          failedRunId: failedRun.id,
          resume: true,
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("fork failover automatic switch failed", {
              threadId: thread.id,
              runId: failedRun.id,
              cause,
            }),
          ),
        );
      }),
    );
  });

  yield* forkParked(
    orchestrator.streamDomainEvents.pipe(
      Stream.mapEffect((event) =>
        handleDomainEvent(event).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("fork failover domain event handler failed", {
              threadId: event.threadId,
              cause,
            }),
          ),
        ),
      ),
      Stream.tapCause((cause) =>
        Effect.logWarning("fork failover domain event stream failed; retrying", { cause }),
      ),
      Stream.retry(streamRetryBackoff),
      Stream.runDrain,
    ),
  );

  return ForkFailover.of({
    getState: getState(),
    setConfig,
    switchThread,
    handleDomainEvent,
  });
});

export const layer = Layer.effect(ForkFailover, make);
