// Fork-only: quota model failover config, recent events, and automatic/manual switch service
// persisted atomically in `<stateDir>/fork/failover.json`.
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
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { latestRootProviderFailure } from "@t3tools/shared/orchestrationV2ThreadError";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import { forkParked } from "../../serverActivation.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { makeForkJsonFileStore } from "../jsonFileStore.ts";
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
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const instanceRegistry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  const storeLock = yield* Semaphore.make(1);
  const threadLocks = yield* KeyedLock.make<ThreadId>();
  const handledRuns = new Set<string>();
  const memoryEventsByThread = new Map<ThreadId, ReadonlyArray<ForkFailoverEvent>>();

  const store = yield* makeForkJsonFileStore({
    fileName: "failover.json",
    label: "Failover store",
    maxBytes: FORK_FAILOVER_MAX_FILE_BYTES,
    empty: EMPTY_FAILOVER_STATE,
    decode: decodeStoredFailoverState,
    makeError: (reason, message) => new ForkFailoverError({ reason, message }),
  });
  // Old events are dropped first, so a long history never blocks a config change.
  const writeState = Effect.fn("ForkFailover.writeState")(function* (state: StoredFailoverState) {
    const pruned = serializeFailoverState(state);
    if (!pruned.ok) return yield* pruned.error;
    yield* store.write(pruned.state);
  });

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

  const appendEventLocked = Effect.fn("ForkFailover.appendEventLocked")(function* (
    event: ForkFailoverEvent,
  ) {
    yield* storeLock.withPermits(1)(
      Effect.gen(function* () {
        const state = yield* store.read();
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
    const state = yield* storeLock.withPermits(1)(store.read());
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
    const state = yield* storeLock.withPermits(1)(store.read());
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
        const current = yield* store.read();
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
          .withPermits(1)(store.read())
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
