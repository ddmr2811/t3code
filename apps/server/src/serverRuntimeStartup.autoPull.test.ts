import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { DEFAULT_SIGNAL_EXPORT } from "@t3tools/shared/observability";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./cloud/serviceProtocol.ts";
import * as ServerConfig from "./config.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as Keybindings from "./keybindings.ts";
import * as EffectWorker from "./orchestration-v2/EffectWorker.ts";
import * as LegacyV1ThreadImporter from "./orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ProviderRuntimeRecovery from "./orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as ThreadLaunch from "./orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as ProjectService from "./project/ProjectService.ts";
import * as AgentAwarenessRelay from "./relay/AgentAwarenessRelay.ts";
import { ServerActivation } from "./serverActivation.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

it.effect("parks automatic pull until activation without delaying command readiness", () =>
  Effect.gen(function* () {
    const activation = yield* Deferred.make<void>();
    const prepared = yield* Deferred.make<void>();
    const commitTrial = yield* Deferred.make<void>();
    const statusCalled = yield* Deferred.make<string>();
    const statusInterrupted = yield* Deferred.make<void>();
    const cwd = "/auto-pull-project";
    const updatedAt = "2026-01-01T00:00:00.000Z";
    const snapshot = {
      projects: [
        {
          id: ProjectId.make("auto-pull-project"),
          title: "Auto pull project",
          workspaceRoot: cwd,
          repositoryIdentity: null,
          defaultModelSelection: null,
          scripts: [],
          createdAt: updatedAt,
          updatedAt,
          deletedAt: null,
        },
      ],
      updatedAt,
    };
    const recovery = {
      terminalizedRuns: 0,
      stoppedSessions: 0,
      closedRequests: 0,
      retiredEffects: 0,
      requeuedEffects: 0,
    };
    const importSummary = { importedThreadCount: 0, importedMessageCount: 0 };
    const dependencies: Layer.Layer<
      Layer.Services<ReturnType<typeof ServerRuntimeStartup.layerWithOptions>>
    > = Layer.mergeAll(
      Layer.mock(ServerConfig.ServerConfig)({
        ...(yield* ServerConfig.deriveServerPaths(cwd, undefined).pipe(Effect.provide(Path.layer))),
        baseDir: cwd,
        logLevel: "Error",
        traceMinLevel: "Info",
        traceTimingEnabled: false,
        traceBatchWindowMs: 200,
        traceMaxBytes: 1024,
        traceMaxFiles: 1,
        otlpTracesUrl: undefined,
        otlpMetricsUrl: undefined,
        otlpLogsUrl: undefined,
        otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
        otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
        otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
        otelEnvironment: OtelEnvironment.none,
        staticDir: undefined,
        devAllowedOrigins: [],
        desktopBootstrapToken: undefined,
        logWebSocketEvents: false,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
        mode: "desktop",
        cwd,
        host: "localhost",
        port: 3773,
        devUrl: undefined,
        noBrowser: true,
        startupPresentation: "browser",
        autoBootstrapProjectFromCwd: false,
      }),
      Layer.mock(Keybindings.Keybindings)({ start: Effect.void }),
      Layer.mock(LegacyV1ThreadImporter.LegacyV1ThreadImporter)({
        pendingThreadCount: Effect.succeed(0),
        reconcileShells: Effect.succeed(importSummary),
        importPendingTranscripts: Effect.succeed(importSummary),
      }),
      Layer.mock(ProviderRuntimeRecovery.ProviderRuntimeRecoveryService)({
        recover: Effect.succeed(recovery),
        prepareForShutdown: Effect.void,
        reconcile: () => Effect.succeed(recovery),
      }),
      Layer.mock(Orchestrator.OrchestratorV2)({ recoverDelegatedTasks: Effect.void }),
      Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({ shutdown: Effect.void }),
      Layer.mock(AgentAwarenessRelay.AgentAwarenessRelay)({ start: () => Effect.void }),
      Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({ runOnce: () => Effect.never }),
      Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({
        publish: (event) => Effect.succeed({ ...event, sequence: 1 }),
      }),
      Layer.mock(ServerSettings.ServerSettingsService)({
        start: Effect.void,
        getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, defaultAutoPull: true }),
      }),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getDescriptor: Effect.succeed({
          environmentId: EnvironmentId.make("auto-pull-environment"),
          label: "Test environment",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.0.0-test",
          capabilities: { repositoryIdentity: true },
        }),
      }),
      Layer.mock(ProjectStore.ProjectStoreV2)({
        listShells: () => Effect.succeed(snapshot.projects),
      }),
      Layer.mock(ProjectService.ProjectService)({ snapshot: Effect.succeed(snapshot) }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        countThreads: () => Effect.succeed(0),
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({}),
      Layer.mock(ServiceLauncherClient.ServiceLauncherClient)({
        managed: true,
        protocol: SERVICE_LAUNCHER_PROTOCOL,
        prepareTrial: () =>
          Deferred.succeed(prepared, undefined).pipe(
            Effect.andThen(Deferred.await(commitTrial)),
            Effect.as(undefined),
          ),
      }),
      Layer.mock(GitVcsDriver.GitVcsDriver)({
        statusDetails: (root) =>
          Deferred.succeed(statusCalled, root).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(statusInterrupted, undefined)),
          ),
      }),
      Layer.mock(AnalyticsService.AnalyticsService)({ record: () => Effect.void }),
      // No provider logins or Connect link, so startup records no owners.
      FileSystem.layerNoop({}),
      Layer.mock(ServerSecretStore.ServerSecretStore)({ get: () => Effect.succeedNone }),
      NodeCrypto.layer,
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
      Layer.mock(ExternalLauncher.ExternalLauncher)({}),
      Layer.mock(HttpServer.HttpServer)({
        address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 3773),
      }),
      Path.layer,
    );

    yield* Effect.gen(function* () {
      const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
      yield* startup.markHttpListening;

      yield* Effect.raceFirst(Deferred.await(prepared), Deferred.await(statusCalled));
      expect(yield* Deferred.isDone(activation)).toBe(false);
      expect(yield* Deferred.isDone(statusCalled)).toBe(false);
      expect(yield* Deferred.isDone(prepared)).toBe(true);

      yield* Deferred.succeed(commitTrial, undefined);
      yield* Deferred.await(activation);
      expect(yield* Deferred.await(statusCalled)).toBe(cwd);
      yield* startup.awaitCommandReady;
    }).pipe(
      Effect.provide(
        ServerRuntimeStartup.layerWithOptions({
          activate: Deferred.succeed(activation, undefined).pipe(Effect.asVoid),
          awaitAuxiliaryParked: Effect.void,
        }).pipe(Layer.provide(dependencies)),
      ),
      Effect.provideService(ServerActivation, Deferred.await(activation)),
    );
    expect(yield* Deferred.isDone(statusInterrupted)).toBe(true);
  }),
);

const targetProject = (id: string, workspaceRoot: string) => ({
  id: ProjectId.make(id),
  workspaceRoot,
  autoPull: true,
});

const runAutoPull = (
  status: Record<string, unknown>,
  settings: typeof DEFAULT_SERVER_SETTINGS,
  projects = [targetProject("target-project", "/target-project")],
) => {
  const pulls: string[] = [];
  return ServerRuntimeStartup.autoPullProjects(projects, settings).pipe(
    Effect.provide(
      Layer.mock(GitVcsDriver.GitVcsDriver)({
        statusDetails: () =>
          Effect.succeed({
            isRepo: true,
            hasUpstream: true,
            hasWorkingTreeChanges: false,
            aheadCount: 0,
            behindCount: 2,
            ...status,
          } as never),
        pullCurrentBranch: (cwd) =>
          Effect.sync(() => {
            pulls.push(cwd);
            return { status: "pulled", refName: "dev", upstreamRef: "origin/dev" } as never;
          }),
      }),
    ),
    Effect.as(pulls),
  );
};

const withTarget = (forkTargetBranch: string, projectId = "target-project") => ({
  ...DEFAULT_SERVER_SETTINGS,
  defaultAutoPull: true,
  projectSettingsOverrides: { [ProjectId.make(projectId)]: { forkTargetBranch } },
});
const noTarget = { ...DEFAULT_SERVER_SETTINGS, defaultAutoPull: true };
const onDev = { branch: "dev", isDefaultBranch: false };

it.effect("auto pull follows the target branch when the folder is on it", () =>
  Effect.gen(function* () {
    expect(yield* runAutoPull(onDev, withTarget("dev"))).toEqual(["/target-project"]);
  }),
);

it.effect("auto pull skips a non-default folder when there is no target", () =>
  Effect.gen(function* () {
    expect(yield* runAutoPull(onDev, noTarget)).toEqual([]);
  }),
);

it.effect("auto pull skips the default branch when the target is another branch", () =>
  Effect.gen(function* () {
    const main = { branch: "main", isDefaultBranch: true };
    expect(yield* runAutoPull(main, withTarget("dev"))).toEqual([]);
  }),
);

it.effect("auto pull skips the target branch with working tree changes or local commits", () =>
  Effect.gen(function* () {
    expect(
      yield* runAutoPull({ ...onDev, hasWorkingTreeChanges: true }, withTarget("dev")),
    ).toEqual([]);
    expect(yield* runAutoPull({ ...onDev, aheadCount: 1 }, withTarget("dev"))).toEqual([]);
  }),
);

it.effect("auto pull uses the first non-null target among projects sharing a folder", () =>
  Effect.gen(function* () {
    const projects = [
      targetProject("plain-project", "/shared"),
      targetProject("target-project", "/shared"),
    ];
    expect(yield* runAutoPull(onDev, withTarget("dev"), projects)).toEqual(["/shared"]);
  }),
);
