import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type ForkBotUpsertInput,
  ProjectId,
  type RuntimeMode,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";

import * as ServerConfig from "../../config.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ScheduledTasks from "../../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettingsService from "../../serverSettings.ts";
import * as ForkCoordination from "../coordination/ForkCoordination.ts";
import * as ForkProjectMemory from "../memory/ForkProjectMemory.ts";
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
    /** Scheduled tasks on the server, as the routines the ADE creates for a bot's thread. */
    readonly routines: Array<{ id: string; threadId: ThreadId; enabled: boolean }>;
    readonly sentTo: Array<ThreadId>;
    /** Every message text the provider received, launches and sends alike, in order. */
    readonly texts: Array<string>;
    /** Each live thread's model, which a failover or the composer may change under the bot. */
    readonly threadModels: Map<ThreadId, { instanceId: ProviderInstanceId; model: string }>;
    /** Each live thread's runtime mode, which its user may raise above the bot's. */
    readonly threadModes: Map<ThreadId, RuntimeMode>;
    readonly board: ForkCoordination.ForkCoordination["Service"];
    readonly memory: ForkProjectMemory.ForkProjectMemory["Service"];
    /** A fresh service over the same state directory, as after a server restart. */
    readonly reopen: Effect.Effect<ForkBots.ForkBots["Service"], never, Scope.Scope>;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const launched: Array<ThreadId> = [];
      const sentTo: Array<ThreadId> = [];
      const texts: Array<string> = [];
      const liveThreads = new Set<ThreadId>();
      const threadModels = new Map<ThreadId, { instanceId: ProviderInstanceId; model: string }>();
      const threadModes = new Map<ThreadId, RuntimeMode>();
      const routines: Array<{ id: string; threadId: ThreadId; enabled: boolean }> = [];

      const mocks = Layer.mergeAll(
        Layer.mock(ProjectService.ProjectService)({
          getById: (projectId) =>
            Effect.succeed(
              projectId === projectA
                ? Option.some({ id: projectA, title: "Proyecto A" } as never)
                : Option.none(),
            ),
        }),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({
          launch: (input) =>
            Effect.sync(() => {
              texts.push(input.initialMessage?.text ?? "");
              const threadId = ThreadId.make(`thread-bot-${launched.length + 1}`);
              launched.push(threadId);
              liveThreads.add(threadId);
              threadModels.set(threadId, input.modelSelection);
              threadModes.set(threadId, input.runtimeMode);
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
                    modelSelection: threadModels.get(threadId),
                    runtimeMode: threadModes.get(threadId),
                    interactionMode: "default",
                    archivedAt: null,
                    deletedAt: null,
                    lineage: { parentThreadId: null, relationshipToParent: null },
                  },
                } as never)
              : Effect.fail({
                  _tag: "OrchestratorThreadNotFoundError",
                  threadId,
                } as never)) as ThreadManagement.ThreadManagementServiceShape["getThreadRecords"],
          sendToThread: ((input: { threadId: ThreadId; text: string }) =>
            Effect.sync(() => {
              sentTo.push(input.threadId);
              texts.push(input.text);
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
        Layer.mock(ScheduledTasks.ScheduledTaskService)({
          list: () =>
            Effect.sync(() => ({ tasks: routines.map((task) => ({ ...task })) }) as never),
          setEnabled: (input) =>
            Effect.sync(() => {
              const task = routines.find((candidate) => candidate.id === input.id);
              if (task !== undefined) task.enabled = input.enabled;
              return {} as never;
            }),
        }),
      );

      const services = ForkBots.layer.pipe(
        Layer.provideMerge(Layer.merge(ForkProjectMemory.layer, ForkCoordination.layer)),
      );
      const testLayer = services.pipe(
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
          routines,
          sentTo,
          texts,
          threadModels,
          threadModes,
          board: yield* ForkCoordination.ForkCoordination,
          memory: yield* ForkProjectMemory.ForkProjectMemory,
          reopen: Layer.build(
            services.pipe(
              Layer.provide(Layer.succeed(ServerConfig.ServerConfig, config)),
              Layer.provide(mocks),
              Layer.provide(NodeServices.layer),
            ),
          ).pipe(
            Effect.map((context) => Context.get(context, ForkBots.ForkBots)),
            Effect.orDie,
          ),
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

        // Each edit changes one more field on top of the previous one, so each reset has one cause.
        const renamedInput = { ...baseBot, id: created.id, handle: "revisora" };
        const newPrompt: ForkBotUpsertInput = { ...renamedInput, instructions: "Sé exhaustivo." };
        const newMode: ForkBotUpsertInput = { ...newPrompt, runtimeMode: "full-access" };
        const newModel: ForkBotUpsertInput = {
          ...newMode,
          modelSelection: { instanceId: codex, model: "gpt-5.5" },
        };
        for (const edit of [newPrompt, newMode, newModel]) {
          const linked = yield* service.sendMessage({ id: created.id, text: "sigue" });
          const edited = yield* service.upsert(edit);
          expect(edited.threadId).toBeNull();
          const next = yield* service.sendMessage({ id: created.id, text: "de nuevo" });
          expect(next.threadId).not.toBe(linked.threadId);
        }
        expect(launched).toHaveLength(4);
      }),
    ),
  );

  it.effect("pauses the routines of a thread the bot leaves, so none keeps its old mode", () =>
    withBots(({ service, routines }) =>
      Effect.gen(function* () {
        const bot = yield* service.upsert({ ...baseBot, runtimeMode: "full-access" });
        const { threadId } = yield* service.sendMessage({ id: bot.id, text: "hola" });
        routines.push(
          { id: "nightly", threadId, enabled: true },
          { id: "other-thread", threadId: ThreadId.make("thread-ajeno"), enabled: true },
        );

        yield* service.upsert({ ...baseBot, id: bot.id, runtimeMode: "approval-required" });
        expect(routines.map((task) => [task.id, task.enabled])).toEqual([
          ["nightly", false],
          ["other-thread", true],
        ]);

        // Removing the bot pauses the routines of its current thread too.
        const next = yield* service.sendMessage({ id: bot.id, text: "otra vez" });
        routines.push({ id: "daily", threadId: next.threadId, enabled: true });
        yield* service.remove({ id: bot.id });
        expect(routines.find((task) => task.id === "daily")?.enabled).toBe(false);
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

  it.effect("queues two simultaneous messages to one bot in one thread, in order", () =>
    withBots(({ service, launched, sentTo, texts }) =>
      Effect.gen(function* () {
        const bot = yield* service.upsert(baseBot);
        yield* Effect.all(
          [
            service.sendMessage({ id: bot.id, text: "primero" }),
            service.sendMessage({ id: bot.id, text: "segundo" }),
          ],
          { concurrency: "unbounded" },
        );
        expect(launched).toHaveLength(1);
        expect(sentTo).toEqual(launched);
        expect(texts[0]).toContain("primero");
        expect(texts[1]).toBe("segundo");
      }),
    ),
  );

  it.effect("allows one coordinator per project", () =>
    withBots(({ service }) =>
      Effect.gen(function* () {
        const first = yield* service.upsert({ ...baseBot, coordinator: true });
        expect(
          yield* service
            .upsert({ ...baseBot, handle: "otro", coordinator: true })
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "conflict" });
        // An edit that omits the flag keeps it, so the first stays the coordinator.
        expect((yield* service.upsert({ ...baseBot, id: first.id })).coordinator).toBe(true);
        yield* service.upsert({ ...baseBot, id: first.id, coordinator: false });
        expect(
          (yield* service.upsert({ ...baseBot, handle: "otro", coordinator: true })).coordinator,
        ).toBe(true);
      }),
    ),
  );

  it.effect(
    "sends the coordinator's essential memory again only when it changed or a new thread starts",
    () =>
      withBots(({ service, memory, texts, threadModels }) =>
        Effect.gen(function* () {
          const essential = yield* memory.upsert(
            { projectId: projectA, text: "Despliega solo los viernes.", inclusion: "essential" },
            "user",
          );
          yield* memory.upsert(
            { projectId: projectA, text: "Nota que se busca.", inclusion: "searchable" },
            "agent",
          );
          const plain = yield* service.upsert({ ...baseBot, handle: "plano" });
          yield* service.sendMessage({ id: plain.id, text: "hola" });
          expect(texts.at(-1)).not.toContain("<project_memory>");

          const coordinator = yield* service.upsert({ ...baseBot, coordinator: true });
          yield* service.sendMessage({ id: coordinator.id, text: "uno" });
          expect(texts.at(-1)).toContain("<project_memory>");
          expect(texts.at(-1)).toContain("Despliega solo los viernes.");
          expect(texts.at(-1)).not.toContain("Nota que se busca.");

          const second = yield* service.sendMessage({ id: coordinator.id, text: "dos" });
          expect(texts.at(-1)).toBe("dos");

          // A failover moved the same thread to another model, which has not seen the memory.
          threadModels.set(second.threadId, { instanceId: codex, model: "gpt-5.5" });
          yield* service.sendMessage({ id: coordinator.id, text: "dos-b" });
          expect(texts.at(-1)).toContain("Despliega solo los viernes.");
          yield* service.sendMessage({ id: coordinator.id, text: "dos-c" });
          expect(texts.at(-1)).toBe("dos-c");

          yield* memory.upsert(
            { ...essential, text: "Despliega los martes.", inclusion: "essential" },
            "user",
          );
          yield* service.sendMessage({ id: coordinator.id, text: "tres" });
          expect(texts.at(-1)).toContain("Despliega los martes.");

          // Another model means another provider conversation, which has seen no memory.
          yield* service.upsert({
            ...baseBot,
            id: coordinator.id,
            modelSelection: { instanceId: codex, model: "gpt-5.5" },
          });
          yield* service.sendMessage({ id: coordinator.id, text: "cuatro" });
          expect(texts.at(-1)).toContain("Despliega los martes.");

          // The last essential going away is a change too.
          yield* memory.remove({ projectId: projectA, id: essential.id });
          yield* service.sendMessage({ id: coordinator.id, text: "cinco" });
          expect(texts.at(-1)).toContain("<project_memory>");
          expect(texts.at(-1)).not.toContain("Despliega");
        }),
      ),
  );

  it.effect("keeps bots, memory and what was injected across a restart", () =>
    withBots(({ service, memory, texts, reopen }) =>
      Effect.gen(function* () {
        yield* memory.upsert(
          { projectId: projectA, text: "Usa pnpm.", inclusion: "essential" },
          "user",
        );
        const coordinator = yield* service.upsert({ ...baseBot, coordinator: true });
        const first = yield* service.sendMessage({ id: coordinator.id, text: "uno" });

        const restarted = yield* reopen;
        expect((yield* restarted.list({})).bots).toMatchObject([
          { id: coordinator.id, coordinator: true, threadId: first.threadId },
        ]);
        const again = yield* restarted.sendMessage({ id: coordinator.id, text: "dos" });
        expect(again.threadId).toBe(first.threadId);
        expect(texts.at(-1)).toBe("dos");
      }),
    ),
  );

  describe("handoffs", () => {
    const fullAccess = { runtimeMode: "full-access", interactionMode: "default" } as const;
    const asAgent = { kind: "agent", limits: fullAccess } as const;
    const twoBots = (service: ForkBots.ForkBots["Service"]) =>
      Effect.all([
        service.upsert({ ...baseBot, handle: "ana", name: "Ana" }),
        service.upsert({ ...baseBot, handle: "beto", name: "Beto" }),
      ]);

    it.effect("waits in the receiving bot's one queue with the user's messages", () =>
      withBots(({ service, launched, sentTo, texts }) =>
        Effect.gen(function* () {
          const [ana, beto] = yield* twoBots(service);
          yield* Effect.all(
            [
              service.handoff(
                { id: "handoff:1", fromId: ana.id, toHandle: "beto", text: "de Ana" },
                { kind: "user" },
              ),
              service.sendMessage({ id: beto.id, text: "del usuario" }),
            ],
            { concurrency: "unbounded" },
          );
          expect(launched).toHaveLength(1);
          expect(sentTo).toEqual(launched);
          expect(texts.join("\n")).toContain("TRASPASO de @ana");
        }),
      ),
    );

    it.effect("ignores a repeated id, also after a restart", () =>
      withBots(({ service, texts, reopen }) =>
        Effect.gen(function* () {
          const [ana] = yield* twoBots(service);
          const input = { id: "handoff:once", fromId: ana.id, toHandle: "beto", text: "hazlo" };
          const first = yield* service.handoff(input, { kind: "user" });
          expect(first.duplicate).toBe(false);
          const restarted = yield* reopen;
          const again = yield* restarted.handoff(input, { kind: "user" });
          expect(again).toMatchObject({ duplicate: true, threadId: first.threadId });
          expect(texts).toHaveLength(1);
        }),
      ),
    );

    it.effect("cuts a chain past the hop limit, across a restart, and never to the same bot", () =>
      withBots(({ service, texts, board, reopen }) =>
        Effect.gen(function* () {
          const [ana, beto] = yield* twoBots(service);
          const pass = (
            bots: ForkBots.ForkBots["Service"],
            hop: number,
            from: typeof ana,
            to: string,
          ) =>
            bots.handoff(
              { id: `handoff:${hop}`, fromId: from.id, toHandle: to, text: `vuelta ${hop}` },
              hop === 1 ? { kind: "user" } : asAgent,
            );
          expect((yield* pass(service, 1, ana, "beto")).handoff.hops).toBe(1);
          expect((yield* pass(service, 2, beto, "ana")).handoff.hops).toBe(2);
          const restarted = yield* reopen;
          expect((yield* pass(restarted, 3, ana, "beto")).handoff.hops).toBe(3);
          expect((yield* pass(restarted, 4, beto, "ana")).handoff.status).toBe("delivered");
          const cut = yield* pass(restarted, 5, ana, "beto");
          expect(cut).toMatchObject({ threadId: null, handoff: { status: "cut", hops: 5 } });
          expect(texts.some((text) => text.includes("vuelta 5"))).toBe(false);
          expect(
            (yield* board.list({})).entries.find((entry) => entry.id === "handoff:5"),
          ).toMatchObject({
            status: "blocked",
          });

          // The user stepping in starts the chain again.
          yield* restarted.sendMessage({ id: ana.id, text: "sigue tú" });
          expect((yield* pass(restarted, 6, ana, "beto")).handoff).toMatchObject({
            status: "delivered",
            hops: 1,
          });
          expect(
            yield* restarted
              .handoff({ id: "handoff:self", fromId: ana.id, toHandle: "ana", text: "yo" }, asAgent)
              .pipe(Effect.flip),
          ).toMatchObject({ reason: "invalidInput" });
        }),
      ),
    );

    it.effect("refuses an agent whose modes are narrower than the receiving bot's thread", () =>
      withBots(({ service, texts, threadModes }) =>
        Effect.gen(function* () {
          const ana = yield* service.upsert({ ...baseBot, handle: "ana", runtimeMode: "auto" });
          const beto = yield* service.upsert({ ...baseBot, handle: "beto", runtimeMode: "auto" });
          const auto = {
            kind: "agent",
            limits: { runtimeMode: "auto", interactionMode: "default" },
          } as const;
          const sent = yield* service.handoff(
            { id: "handoff:ok", fromId: ana.id, toHandle: "beto", text: "uno" },
            auto,
          );
          // Its user raised the receiving thread above what the sender runs with.
          threadModes.set(sent.threadId!, "full-access");
          const refused = yield* service
            .handoff({ id: "handoff:raised", fromId: ana.id, toHandle: "beto", text: "dos" }, auto)
            .pipe(Effect.flip);
          expect(refused).toMatchObject({ reason: "permissionDenied" });
          const planMode = yield* service
            .handoff(
              { id: "handoff:plan", fromId: beto.id, toHandle: "ana", text: "tres" },
              { kind: "agent", limits: { runtimeMode: "full-access", interactionMode: "plan" } },
            )
            .pipe(Effect.flip);
          expect(planMode).toMatchObject({ reason: "permissionDenied" });
          expect(texts.filter((text) => /dos|tres/.test(text))).toEqual([]);
        }),
      ),
    );
  });
});
