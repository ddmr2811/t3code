// @effect-diagnostics nodeBuiltinImport:off -- Symlink, chmod, and mkfifo security fixtures require node:fs/promises and node:child_process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  DEFAULT_FORK_FAILOVER_CONFIG,
  DEFAULT_SERVER_SETTINGS,
  FORK_FAILOVER_MAX_FILE_BYTES,
  type ForkFailoverConfig,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  type ServerSettings,
  ThreadId,
  TurnItemId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as RpcAuthorization from "../../auth/RpcAuthorization.ts";
import * as ServerConfig from "../../config.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettingsService from "../../serverSettings.ts";
import * as ForkFailover from "./ForkFailover.ts";

const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");
const cursor = ProviderInstanceId.make("cursor");
const projectA = ProjectId.make("proj-a");
const thread1 = ThreadId.make("thread-failover-1");
const run1 = RunId.make("run-failover-1");
const run2 = RunId.make("run-failover-2");
const run3 = RunId.make("run-failover-3");

const makeServerProvider = (
  instanceId: ProviderInstanceId,
  driver: string,
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId,
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-24T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

interface MockThreadState {
  id: ThreadId;
  projectId: ProjectId;
  modelSelection: { instanceId: ProviderInstanceId; model: string };
  runtimeMode: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
  worktreePath: string | null;
  branch: string | null;
  archivedAt: DateTime.Utc | null;
  deletedAt: DateTime.Utc | null;
  settledOverride: "settled" | "active" | null;
  runs: Array<OrchestrationV2Run>;
  turnItems: Array<OrchestrationV2TurnItem>;
}

const makeRun = (
  id: RunId,
  ordinal: number,
  status: OrchestrationV2Run["status"],
  modelSelection: { instanceId: ProviderInstanceId; model: string },
): OrchestrationV2Run =>
  ({
    id,
    threadId: thread1,
    ordinal,
    status,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
  }) as unknown as OrchestrationV2Run;

const makeErrorItem = (
  runId: RunId,
  failureClass: "usage_limit" | "provider_error" | "permission_error",
  code: string | null = null,
  resetAt: string | null = "2026-11-24T13:00:00.000Z",
): OrchestrationV2TurnItem =>
  ({
    id: TurnItemId.make(`err:${runId}`),
    type: "error",
    threadId: thread1,
    runId,
    ordinal: 1,
    status: "failed",
    failure: {
      class: failureClass,
      message: "Quota exhausted",
      code,
      retryable: true,
      resetAt,
    },
  }) as unknown as OrchestrationV2TurnItem;

interface TestHarness {
  readonly stateDir: string;
  readonly forkDir: string;
  readonly failoverFile: string;
  readonly service: ForkFailover.ForkFailover["Service"];
  readonly fs: FileSystem.FileSystem;
  readonly dispatched: Array<OrchestrationV2Command>;
  readonly threadsById: Map<ThreadId, MockThreadState>;
  readonly domainEvents: Queue.Queue<OrchestrationV2DomainEvent>;
  readonly setSettings: (next: ServerSettings) => void;
  readonly setProviders: (next: ReadonlyArray<ServerProvider>) => void;
}

const withTempFailover = <A, E, R>(
  use: (harness: TestHarness) => Effect.Effect<A, E, R>,
  options?: {
    readonly initialProviders?: ReadonlyArray<ServerProvider>;
    readonly initialSettings?: ServerSettings;
  },
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const dispatched: Array<OrchestrationV2Command> = [];
      const domainEvents = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      let providers: ReadonlyArray<ServerProvider> = options?.initialProviders ?? [
        makeServerProvider(codex, "codex"),
        makeServerProvider(claude, "claudeAgent"),
        makeServerProvider(cursor, "cursor"),
      ];
      let settings: ServerSettings = options?.initialSettings ?? {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          ...DEFAULT_SERVER_SETTINGS.providerInstances,
          [cursor]: {
            driver: ProviderDriverKind.make("cursor"),
            enabled: true,
          },
        },
      };

      const threadsById = new Map<ThreadId, MockThreadState>([
        [
          thread1,
          {
            id: thread1,
            projectId: projectA,
            modelSelection: { instanceId: codex, model: "gpt-5.4" },
            runtimeMode: "approval-required",
            worktreePath: "/worktrees/feature-a",
            branch: "feat/a",
            archivedAt: null,
            deletedAt: null,
            settledOverride: null,
            runs: [],
            turnItems: [],
          },
        ],
      ]);

      const mockOrchestrator = Layer.mock(Orchestrator.OrchestratorV2)({
        streamDomainEvents: Stream.fromQueue(domainEvents),
      });

      const mockThreads = Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadRecords: ((threadId: ThreadId) => {
          const entry = threadsById.get(threadId);
          if (entry === undefined) {
            return Effect.fail({
              _tag: "OrchestratorThreadNotFoundError",
              threadId,
            } as never);
          }
          return Effect.succeed({
            thread: {
              id: entry.id,
              projectId: entry.projectId,
              providerInstanceId: entry.modelSelection.instanceId,
              modelSelection: entry.modelSelection,
              runtimeMode: entry.runtimeMode,
              worktreePath: entry.worktreePath,
              branch: entry.branch,
              archivedAt: entry.archivedAt,
              deletedAt: entry.deletedAt,
              settledOverride: entry.settledOverride,
              lineage: {
                parentThreadId: null,
                relationshipToParent: null,
                rootThreadId: entry.id,
              },
              creationSource: "web",
            },
            runs: entry.runs,
            turnItems: entry.turnItems,
            runtimeRequests: [],
          } as never);
        }) as ThreadManagement.ThreadManagementServiceShape["getThreadRecords"],
        dispatch: ((command: OrchestrationV2Command) =>
          Effect.sync(() => {
            dispatched.push(command);
            if (command.type === "thread.model-selection.set") {
              const entry = threadsById.get(command.threadId);
              if (entry !== undefined) {
                entry.modelSelection = {
                  instanceId: command.modelSelection.instanceId,
                  model: command.modelSelection.model,
                };
              }
            }
            return { sequence: dispatched.length } as never;
          })) as ThreadManagement.ThreadManagementServiceShape["dispatch"],
      });

      const mockInstanceRegistry = Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
        listInstances: Effect.sync(
          () =>
            providers.map((provider) => ({
              instanceId: provider.instanceId,
              driverKind: provider.driver,
            })) as never,
        ),
      });

      const mockProviderRegistry = Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.sync(() => providers),
      });

      const mockServerSettings = Layer.mock(ServerSettingsService.ServerSettingsService)({
        getSettings: Effect.sync(() => settings),
      });

      const testLayer = ForkFailover.layer.pipe(
        Layer.provideMerge(
          ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-fork-failover-test-" }),
        ),
        Layer.provideMerge(mockOrchestrator),
        Layer.provideMerge(mockThreads),
        Layer.provideMerge(mockInstanceRegistry),
        Layer.provideMerge(mockProviderRegistry),
        Layer.provideMerge(mockServerSettings),
        Layer.provideMerge(NodeServices.layer),
      );

      return yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const service = yield* ForkFailover.ForkFailover;
        const forkDir = path.join(config.stateDir, "fork");
        return yield* use({
          stateDir: config.stateDir,
          forkDir,
          failoverFile: path.join(forkDir, "failover.json"),
          service,
          fs,
          dispatched,
          threadsById,
          domainEvents,
          setSettings: (next) => {
            settings = next;
          },
          setProviders: (next) => {
            providers = next;
          },
        });
      }).pipe(Effect.provide(testLayer));
    }),
  );

const sampleConfig: ForkFailoverConfig = {
  ...DEFAULT_FORK_FAILOVER_CONFIG,
  enabled: true,
  cooldownSeconds: 600,
  maxSwitchesPerWindow: 2,
  chains: [
    {
      id: "chain:primary",
      name: "Principal",
      targets: [
        { instanceId: codex, model: "gpt-5.4" },
        { instanceId: claude, model: "claude-sonnet-4-6" },
        { instanceId: cursor, model: "composer-2" },
      ],
    },
  ],
};

describe("ForkFailover", () => {
  it.effect("persists config atomically with 0700/0600 modes and tightens looser permissions", () =>
    withTempFailover(({ forkDir, failoverFile, service, fs }) =>
      Effect.gen(function* () {
        const initial = yield* service.getState;
        expect(initial).toEqual({
          config: DEFAULT_FORK_FAILOVER_CONFIG,
          recentEvents: [],
          updatedAt: null,
        });

        yield* TestClock.setTime(Date.parse("2026-11-24T10:00:00.000Z"));
        const saved = yield* service.setConfig({ config: sampleConfig });
        expect(saved).toEqual(sampleConfig);

        const platform = yield* HostProcess.Platform;
        if (platform !== "win32") {
          const dirStat = yield* fs.stat(forkDir);
          const fileStat = yield* fs.stat(failoverFile);
          expect(dirStat.mode & 0o777).toBe(0o700);
          expect(fileStat.mode & 0o777).toBe(0o600);

          yield* Effect.promise(() => NodeFSP.chmod(forkDir, 0o755));
          yield* Effect.promise(() => NodeFSP.chmod(failoverFile, 0o644));
          yield* service.setConfig({ config: { ...sampleConfig, cooldownSeconds: 300 } });
          expect((yield* fs.stat(forkDir)).mode & 0o777).toBe(0o700);
          expect((yield* fs.stat(failoverFile)).mode & 0o777).toBe(0o600);
        }
      }),
    ),
  );

  it.effect(
    "automatically fails over on usage_limit preserving thread, worktree, and runtimeMode",
    () =>
      withTempFailover(({ service, threadsById, dispatched }) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse("2026-11-24T11:00:00.000Z"));
          yield* service.setConfig({ config: sampleConfig });

          const thread = threadsById.get(thread1)!;
          const failedRun = makeRun(run1, 1, "failed", { instanceId: codex, model: "gpt-5.4" });
          thread.runs = [failedRun];
          thread.turnItems = [makeErrorItem(run1, "usage_limit", "429")];

          const domainEvent = {
            type: "run.updated",
            threadId: thread1,
            payload: failedRun,
          } as unknown as OrchestrationV2DomainEvent;

          yield* service.handleDomainEvent(domainEvent);
          // Re-delivering the exact same failed run event must not duplicate commands.
          yield* service.handleDomainEvent(domainEvent);

          expect(dispatched).toHaveLength(2);
          expect(dispatched[0]).toMatchObject({
            type: "thread.model-selection.set",
            threadId: thread1,
            modelSelection: { instanceId: claude, model: "claude-sonnet-4-6" },
          });
          expect(dispatched[1]).toMatchObject({
            type: "message.dispatch",
            threadId: thread1,
            modelSelection: { instanceId: claude, model: "claude-sonnet-4-6" },
            dispatchMode: { type: "start_immediately" },
          });
          // Never touches runtimeMode or worktreePath.
          expect(dispatched.some((cmd) => cmd.type === "thread.runtime-mode.set")).toBe(false);
          expect(thread.worktreePath).toBe("/worktrees/feature-a");
          expect(thread.runtimeMode).toBe("approval-required");

          const state = yield* service.getState;
          expect(state.recentEvents).toHaveLength(1);
          expect(state.recentEvents[0]).toMatchObject({
            threadId: thread1,
            fromSelection: { instanceId: codex, model: "gpt-5.4" },
            toSelection: { instanceId: claude, model: "claude-sonnet-4-6" },
            reason: "usage_limit",
            status: "switched",
          });

          // Second usage_limit on Claude advances to Cursor (does not bounce back to Codex).
          yield* TestClock.setTime(Date.parse("2026-11-24T11:02:00.000Z"));
          const failedRun2 = makeRun(run2, 2, "failed", {
            instanceId: claude,
            model: "claude-sonnet-4-6",
          });
          thread.runs = [failedRun, failedRun2];
          thread.turnItems = [...thread.turnItems, makeErrorItem(run2, "usage_limit", "429")];
          yield* service.handleDomainEvent({
            type: "run.updated",
            threadId: thread1,
            payload: failedRun2,
          } as unknown as OrchestrationV2DomainEvent);

          expect(thread.modelSelection).toEqual({ instanceId: cursor, model: "composer-2" });

          // Third usage_limit within cooldown is stopped by anti-loop guard and recorded as skipped.
          yield* TestClock.setTime(Date.parse("2026-11-24T11:04:00.000Z"));
          const failedRun3 = makeRun(run3, 3, "failed", {
            instanceId: cursor,
            model: "composer-2",
          });
          thread.runs = [failedRun, failedRun2, failedRun3];
          thread.turnItems = [...thread.turnItems, makeErrorItem(run3, "usage_limit", "429")];
          yield* service.handleDomainEvent({
            type: "run.updated",
            threadId: thread1,
            payload: failedRun3,
          } as unknown as OrchestrationV2DomainEvent);

          expect(dispatched).toHaveLength(4);
          const afterLoopGuard = yield* service.getState;
          expect(afterLoopGuard.recentEvents[0]).toMatchObject({
            threadId: thread1,
            status: "skipped",
            toSelection: null,
          });
        }),
      ),
  );

  it.effect("ignores non-usage_limit failures and respects disabled instances", () =>
    withTempFailover(({ service, threadsById, dispatched, setProviders }) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-11-24T11:00:00.000Z"));
        yield* service.setConfig({ config: sampleConfig });

        const thread = threadsById.get(thread1)!;
        const authFailureRun = makeRun(run1, 1, "failed", { instanceId: codex, model: "gpt-5.4" });
        thread.runs = [authFailureRun];
        thread.turnItems = [makeErrorItem(run1, "permission_error", "401")];

        yield* service.handleDomainEvent({
          type: "run.updated",
          threadId: thread1,
          payload: authFailureRun,
        } as unknown as OrchestrationV2DomainEvent);
        expect(dispatched).toHaveLength(0);

        // Disable claude; usage_limit on codex should jump straight to cursor.
        setProviders([
          makeServerProvider(codex, "codex"),
          makeServerProvider(claude, "claudeAgent", { enabled: false, status: "disabled" }),
          makeServerProvider(cursor, "cursor"),
        ]);
        const quotaRun = makeRun(run2, 2, "failed", { instanceId: codex, model: "gpt-5.4" });
        thread.runs = [authFailureRun, quotaRun];
        thread.turnItems = [...thread.turnItems, makeErrorItem(run2, "usage_limit", "429")];
        yield* service.handleDomainEvent({
          type: "run.updated",
          threadId: thread1,
          payload: quotaRun,
        } as unknown as OrchestrationV2DomainEvent);

        expect(dispatched).toHaveLength(2);
        expect(dispatched[0]).toMatchObject({
          type: "thread.model-selection.set",
          modelSelection: { instanceId: cursor, model: "composer-2" },
        });
      }),
    ),
  );

  it.effect(
    "switches thread manually via switchThread preserving worktree and rejecting busy threads",
    () =>
      withTempFailover(({ service, threadsById, dispatched }) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse("2026-11-24T11:10:00.000Z"));
          // Even when automatic failover is off, manual 1-tap switch uses the configured chain.
          yield* service.setConfig({ config: { ...sampleConfig, enabled: false } });

          const thread = threadsById.get(thread1)!;
          thread.runs = [makeRun(run1, 1, "running", { instanceId: codex, model: "gpt-5.4" })];
          const busyError = yield* service.switchThread({ threadId: thread1 }).pipe(Effect.flip);
          expect(busyError).toMatchObject({ _tag: "ForkFailoverError", reason: "threadBusy" });

          thread.runs = [makeRun(run1, 1, "completed", { instanceId: codex, model: "gpt-5.4" })];
          const switched = yield* service.switchThread({ threadId: thread1, resume: false });
          expect(switched.selection).toEqual({ instanceId: claude, model: "claude-sonnet-4-6" });
          expect(switched.resumed).toBe(false);
          expect(dispatched).toHaveLength(1);
          expect(dispatched[0]).toMatchObject({
            type: "thread.model-selection.set",
            threadId: thread1,
            modelSelection: { instanceId: claude, model: "claude-sonnet-4-6" },
          });
          expect(thread.worktreePath).toBe("/worktrees/feature-a");
          expect(thread.runtimeMode).toBe("approval-required");

          const missing = yield* service
            .switchThread({ threadId: ThreadId.make("missing-thread") })
            .pipe(Effect.flip);
          expect(missing).toMatchObject({ _tag: "ForkFailoverError", reason: "notFound" });
        }),
      ),
  );

  it.effect("refuses symlinks and FIFOs without blocking or leaking host paths", () =>
    withTempFailover(({ stateDir, forkDir, failoverFile, service }) =>
      Effect.gen(function* () {
        const platform = yield* HostProcess.Platform;
        if (platform === "win32") return;

        const path = yield* Path.Path;
        const outsideTarget = path.join(stateDir, "outside-failover.txt");
        yield* Effect.promise(() => NodeFSP.writeFile(outsideTarget, "DO_NOT_OVERWRITE", "utf8"));
        yield* Effect.promise(() => NodeFSP.mkdir(forkDir, { recursive: true, mode: 0o700 }));
        yield* Effect.promise(() => NodeFSP.symlink(outsideTarget, failoverFile));

        const readSymlink = yield* service.getState.pipe(Effect.flip);
        expect(readSymlink).toMatchObject({ _tag: "ForkFailoverError", reason: "storageFailed" });
        expect(readSymlink.message).not.toContain(stateDir);
        expect(readSymlink.message).not.toContain("failover.json");

        const writeSymlink = yield* service.setConfig({ config: sampleConfig }).pipe(Effect.flip);
        expect(writeSymlink).toMatchObject({ _tag: "ForkFailoverError", reason: "storageFailed" });
        expect(writeSymlink.message).not.toContain(stateDir);
        expect(yield* Effect.promise(() => NodeFSP.readFile(outsideTarget, "utf8"))).toBe(
          "DO_NOT_OVERWRITE",
        );

        // Replace with FIFO and verify both read and write refuse without blocking.
        yield* Effect.promise(() => NodeFSP.unlink(failoverFile));
        NodeChildProcess.execFileSync("mkfifo", [failoverFile]);

        const readFifo = yield* service.getState.pipe(Effect.flip);
        expect(readFifo).toMatchObject({ _tag: "ForkFailoverError", reason: "storageFailed" });
        const writeFifo = yield* service.setConfig({ config: sampleConfig }).pipe(Effect.flip);
        expect(writeFifo).toMatchObject({ _tag: "ForkFailoverError", reason: "storageFailed" });

        // Replace fork/ directory with symlink.
        const outsideDir = path.join(stateDir, "outside-dir");
        yield* Effect.promise(() => NodeFSP.mkdir(outsideDir, { recursive: true }));
        yield* Effect.promise(() => NodeFSP.rm(forkDir, { recursive: true, force: true }));
        yield* Effect.promise(() => NodeFSP.symlink(outsideDir, forkDir));

        const readSymDir = yield* service.getState.pipe(Effect.flip);
        expect(readSymDir).toMatchObject({ _tag: "ForkFailoverError", reason: "storageFailed" });
        expect(readSymDir.message).not.toContain(stateDir);
      }),
    ),
  );

  it.effect(
    "rejects invalid configs, oversized files, and corrupted stores without leaking paths",
    () =>
      withTempFailover(({ stateDir, forkDir, failoverFile, service, fs }) =>
        Effect.gen(function* () {
          const badConfigs = [
            { ...sampleConfig, cooldownSeconds: 5 },
            { ...sampleConfig, maxSwitchesPerWindow: 99 },
            {
              ...sampleConfig,
              chains: [
                {
                  id: "../escape",
                  name: "Bad",
                  targets: [{ instanceId: codex, model: "gpt-5.4" }],
                },
              ],
            },
            {
              ...sampleConfig,
              chains: [
                {
                  id: "dup",
                  name: "Dup targets",
                  targets: [
                    { instanceId: codex, model: "gpt-5.4" },
                    { instanceId: codex, model: "gpt-5.4" },
                  ],
                },
              ],
            },
            {
              ...sampleConfig,
              chains: [
                {
                  id: "ctrl",
                  name: "Bad\u0007Name",
                  targets: [{ instanceId: codex, model: "gpt-5.4" }],
                },
              ],
            },
          ];

          for (const bad of badConfigs) {
            const error = yield* service
              .setConfig({ config: bad as ForkFailoverConfig })
              .pipe(Effect.flip);
            expect(error).toMatchObject({ _tag: "ForkFailoverError", reason: "invalidInput" });
          }

          yield* fs.makeDirectory(forkDir, { recursive: true });
          yield* fs.writeFileString(failoverFile, "{bad-json");
          const corrupt = yield* service.getState.pipe(Effect.flip);
          expect(corrupt).toMatchObject({ _tag: "ForkFailoverError", reason: "storageFailed" });
          expect(corrupt.message).not.toContain(stateDir);
          expect(corrupt.message).not.toContain("failover.json");

          yield* fs.writeFileString(failoverFile, " ".repeat(FORK_FAILOVER_MAX_FILE_BYTES + 32));
          const oversized = yield* service.getState.pipe(Effect.flip);
          expect(oversized).toMatchObject({ _tag: "ForkFailoverError", reason: "limitExceeded" });
        }),
      ),
  );

  it.effect("enforces read, providers:manage, and operate scopes across failover RPCs", () =>
    withTempFailover(({ service }) =>
      Effect.gen(function* () {
        const tested = [
          WS_METHODS.forkFailoverGetState,
          WS_METHODS.forkFailoverSetConfig,
          WS_METHODS.forkFailoverSwitchThread,
        ] as const;
        const group = WsRpcGroup.omit(
          ...[...WsRpcGroup.requests.keys()].filter(
            (
              tag,
            ): tag is Exclude<
              keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES,
              (typeof tested)[number]
            > => !(tested as ReadonlyArray<string>).includes(tag),
          ),
        );

        const handlers = Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.forkFailoverGetState, () => service.getState),
          group.toLayerHandler(WS_METHODS.forkFailoverSetConfig, (input) =>
            service.setConfig(input),
          ),
          group.toLayerHandler(WS_METHODS.forkFailoverSwitchThread, (input) =>
            service.switchThread(input),
          ),
        );

        const reader = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(handlers, RpcAuthorization.layer([AuthOrchestrationReadScope])),
          ),
        );
        expect((yield* reader[WS_METHODS.forkFailoverGetState]({})).config).toEqual(
          DEFAULT_FORK_FAILOVER_CONFIG,
        );
        expect(
          yield* reader[WS_METHODS.forkFailoverSetConfig]({ config: sampleConfig }).pipe(
            Effect.flip,
          ),
        ).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
          requiredPermission: AuthProvidersManageScope,
        });
        expect(
          yield* reader[WS_METHODS.forkFailoverSwitchThread]({ threadId: thread1 }).pipe(
            Effect.flip,
          ),
        ).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
          requiredPermission: AuthOrchestrationOperateScope,
        });

        const providerManager = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(
              handlers,
              RpcAuthorization.layer([AuthOrchestrationReadScope, AuthProvidersManageScope]),
            ),
          ),
        );
        expect(
          yield* providerManager[WS_METHODS.forkFailoverSetConfig]({ config: sampleConfig }),
        ).toEqual(sampleConfig);

        const operator = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(
              handlers,
              RpcAuthorization.layer([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]),
            ),
          ),
        );
        const switched = yield* operator[WS_METHODS.forkFailoverSwitchThread]({
          threadId: thread1,
        });
        expect(switched.selection).toEqual({ instanceId: claude, model: "claude-sonnet-4-6" });
      }),
    ),
  );
});
