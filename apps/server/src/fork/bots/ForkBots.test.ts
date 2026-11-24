import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettingsService from "../../serverSettings.ts";
import * as ForkBots from "./ForkBots.ts";

const codex = ProviderInstanceId.make("codex");
const projectA = ProjectId.make("proj-a");

const provider: ServerProvider = {
  instanceId: codex,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-24T00:00:00.000Z",
  models: [
    { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: null },
    { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
};

const withBots = <A, E, R>(
  use: (harness: {
    readonly service: ForkBots.ForkBots["Service"];
    readonly botsFile: string;
    readonly forkDir: string;
    readonly stateDir: string;
    readonly fs: FileSystem.FileSystem;
    readonly launched: Array<ThreadId>;
    readonly sentTo: Array<ThreadId>;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const launched: Array<ThreadId> = [];
      const sentTo: Array<ThreadId> = [];
      const liveThreads = new Set<ThreadId>();

      const mocks = Layer.mergeAll(
        Layer.mock(ProjectService.ProjectService)({
          getById: (projectId) =>
            Effect.succeed(
              projectId === projectA ? Option.some({ id: projectA } as never) : Option.none(),
            ),
        }),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({
          launch: () =>
            Effect.sync(() => {
              const threadId = ThreadId.make(`thread-bot-${launched.length + 1}`);
              launched.push(threadId);
              liveThreads.add(threadId);
              return { threadId } as never;
            }),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadRecords: ((threadId: ThreadId) =>
            liveThreads.has(threadId)
              ? Effect.succeed({
                  thread: {
                    id: threadId,
                    projectId: projectA,
                    archivedAt: null,
                    deletedAt: null,
                    lineage: { parentThreadId: null, relationshipToParent: null },
                  },
                } as never)
              : Effect.fail({
                  _tag: "OrchestratorThreadNotFoundError",
                  threadId,
                } as never)) as ThreadManagement.ThreadManagementServiceShape["getThreadRecords"],
          sendToThread: ((input: { threadId: ThreadId }) =>
            Effect.sync(() => {
              sentTo.push(input.threadId);
              return { delivery: "started" } as never;
            })) as ThreadManagement.ThreadManagementServiceShape["sendToThread"],
        }),
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          listInstances: Effect.succeed([{ instanceId: codex }] as never),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([provider]),
        }),
        Layer.mock(ServerSettingsService.ServerSettingsService)({
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        }),
      );

      const testLayer = ForkBots.layer.pipe(
        Layer.provideMerge(
          ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-fork-bots-test-" }),
        ),
        Layer.provideMerge(mocks),
        Layer.provideMerge(NodeServices.layer),
      );

      return yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const path = yield* Path.Path;
        const forkDir = path.join(config.stateDir, "fork");
        return yield* use({
          service: yield* ForkBots.ForkBots,
          botsFile: path.join(forkDir, "bots.json"),
          forkDir,
          stateDir: config.stateDir,
          fs: yield* FileSystem.FileSystem,
          launched,
          sentTo,
        });
      }).pipe(Effect.provide(testLayer));
    }),
  );

const baseBot = {
  handle: "revisor",
  name: "Revisor",
  role: "Revisa diffs",
  instructions: "Sé breve.",
  projectId: projectA,
  modelSelection: { instanceId: codex, model: "gpt-5.4" },
};

describe("ForkBots", () => {
  it.effect("keeps one conversation per bot until its prompt, mode, or model changes", () =>
    withBots(({ service, launched, sentTo }) =>
      Effect.gen(function* () {
        const created = yield* service.upsert({ ...baseBot, runtimeMode: "auto" });
        const first = yield* service.sendMessage({ id: created.id, text: "hola" });
        yield* service.sendMessage({ id: created.id, text: "otra" });
        expect(launched).toEqual([first.threadId]);
        expect(sentTo).toEqual([first.threadId]);

        // A new handle does not reach the thread; an omitted mode keeps the stored one.
        const renamed = yield* service.upsert({ ...baseBot, id: created.id, handle: "revisora" });
        expect(renamed.threadId).toBe(first.threadId);
        expect(renamed.runtimeMode).toBe("auto");

        for (const change of [
          { instructions: "Sé exhaustivo." },
          { runtimeMode: "full-access" as const },
          { modelSelection: { instanceId: codex, model: "gpt-5.5" } },
        ]) {
          const linked = yield* service.sendMessage({ id: created.id, text: "sigue" });
          const edited = yield* service.upsert({ ...baseBot, id: created.id, ...change });
          expect(edited.threadId).toBeNull();
          const next = yield* service.sendMessage({ id: created.id, text: "de nuevo" });
          expect(next.threadId).not.toBe(linked.threadId);
        }
        expect(launched).toHaveLength(4);
      }),
    ),
  );

  it.effect("rejects a handle another bot already uses", () =>
    withBots(({ service }) =>
      Effect.gen(function* () {
        const first = yield* service.upsert(baseBot);
        const second = yield* service.upsert({ ...baseBot, handle: "otro" });
        for (const attempt of [baseBot, { ...baseBot, id: second.id, handle: "revisor" }]) {
          expect(yield* service.upsert(attempt).pipe(Effect.flip)).toMatchObject({
            reason: "conflict",
          });
        }
        expect((yield* service.list({})).bots.map((bot) => bot.id).toSorted()).toEqual(
          [first.id, second.id].toSorted(),
        );
      }),
    ),
  );

  it.effect(
    "stores the directory owner-only and refuses a corrupt file without leaking its path",
    () =>
      withBots(({ service, botsFile, forkDir, stateDir, fs }) =>
        Effect.gen(function* () {
          yield* service.upsert(baseBot);
          if ((yield* HostProcess.Platform) !== "win32") {
            expect((yield* fs.stat(forkDir)).mode & 0o777).toBe(0o700);
            expect((yield* fs.stat(botsFile)).mode & 0o777).toBe(0o600);
          }

          yield* fs.writeFileString(botsFile, "{not-json");
          const corrupt = yield* service.list({}).pipe(Effect.flip);
          expect(corrupt).toMatchObject({ reason: "storageFailed" });
          expect(corrupt.message).not.toContain(stateDir);
        }),
      ),
  );
});
