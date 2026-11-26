import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";

import WorkflowsMigration from "../../persistence/Migrations/110_Workflows.ts";
import WorkflowSkippedRunsMigration from "../../persistence/Migrations/113_WorkflowSkippedRuns.ts";
import WorkflowRunTagsMigration from "../../persistence/Migrations/115_WorkflowRunTags.ts";
import WorkflowMailSenderMigration from "../../persistence/Migrations/117_WorkflowMailSender.ts";
import WorkflowPoolsMigration from "../../persistence/Migrations/118_WorkflowPools.ts";
import WorkflowRunSubjectMigration from "../../persistence/Migrations/119_WorkflowRunSubject.ts";
import type { WorkflowDefinition } from "../../workflows/workflow.ts";
import { type AgentResult, WorkflowAgents } from "../../workflows/WorkflowAgents.ts";
import * as WorkflowEngine from "../../workflows/WorkflowEngine.ts";
import * as WorkflowRuntime from "../../workflows/WorkflowRuntime.ts";
import * as Workflows from "../../workflows/Workflows.ts";
import * as ForkWorkflowAgents from "./ForkWorkflowAgents.ts";
import * as ForkWorkflowLink from "./ForkWorkflowLink.ts";

/** One step for a bot, taken as an answer whatever happens to it. */
const botStep = `const { workflow, agent } = T3;
workflow("paso-de-bot", { version: 1, payload: Schema.Struct({}), returns: Schema.String }, () =>
  Effect.map(agent.try("clasificar", { bot: "triaje", brief: "clasifica" }), (step) => step.outcome),
);
`;

/**
 * The workflow runtime as the server runs it, over a fresh database and `botStep`, with its turn
 * behind the fork's gate. `ended` settles the bot's turn; until then it is still working, and
 * `watched` and `stopping` tell when the engine starts waiting on it and when it stops waiting.
 */
const setup = Effect.fn("setup")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-fork-link-" });
  const directory = path.join(home, "workflows");
  yield* fileSystem.makeDirectory(directory);
  yield* fileSystem.writeFileString(path.join(directory, "paso-de-bot.ts"), botStep);
  const database = NodeSqliteClient.layer({ filename: path.join(home, "state.sqlite") });
  yield* Effect.provide(
    Effect.all(
      [
        WorkflowsMigration,
        WorkflowSkippedRunsMigration,
        WorkflowRunTagsMigration,
        WorkflowMailSenderMigration,
        WorkflowPoolsMigration,
        WorkflowRunSubjectMigration,
      ],
      { discard: true },
    ),
    database,
  );
  const ended = yield* Deferred.make<AgentResult>();
  const watched = yield* Deferred.make<void>();
  const stopping = yield* Deferred.make<void>();
  // Upstream's threads, which only report how the bot's turn ended.
  const upstream = WorkflowAgents.of({
    start: () => Effect.die("A bot's step starts through the bot."),
    result: () =>
      Deferred.succeed(watched, undefined).pipe(
        Effect.andThen(Deferred.await(ended)),
        Effect.onInterrupt(() => Deferred.succeed(stopping, undefined)),
      ),
    interrupt: () => Effect.succeed("ended"),
  });
  const link: ForkWorkflowLink.ForkWorkflowLink["Service"] = { current: undefined };
  const made = WorkflowRuntime.make(
    Effect.succeed((definitions: ReadonlyArray<WorkflowDefinition>) =>
      WorkflowEngine.layer(definitions).pipe(
        Layer.provide(ForkWorkflowAgents.layer),
        Layer.provide(Layer.succeed(WorkflowAgents, upstream)),
        Layer.provide(Layer.succeed(ForkWorkflowLink.ForkWorkflowLink, link)),
        Layer.provide(database),
        Layer.provide(NodeCrypto.layer),
      ),
    ),
    directory,
    Effect.succeed(true),
  );
  const gated = yield* WorkflowRuntime.gate(made, directory);
  const turn = yield* ForkWorkflowLink.gateTurn(gated.turn).pipe(
    Effect.provideService(ForkWorkflowLink.ForkWorkflowLink, link),
  );
  const hooks: ForkWorkflowLink.ForkWorkflowHooks = {
    workflowTurn: (input) =>
      Effect.succeed({ threadId: ThreadId.make("fork-bot-thread:1"), turnId: input.messageId }),
    wasBotThread: () => Effect.succeed(false),
    callAsBot: () => Effect.die("No integration here."),
  };
  /** The fork's services coming up, for as long as the returned scope stays open. */
  const forkUp = Effect.gen(function* () {
    const scope = yield* Scope.make();
    yield* ForkWorkflowLink.attach(link, hooks).pipe(Effect.provideService(Scope.Scope, scope));
    return scope;
  });
  return {
    turn,
    forkUp,
    ended,
    watched,
    stopping,
    workflows: Context.get(gated.context, Workflows.Workflows),
  };
});

it.live("a bot's step waits for the fork to be up when workflows come on before it", () =>
  Effect.gen(function* () {
    const { turn, forkUp, ended, workflows } = yield* setup();
    yield* Deferred.succeed(ended, { ending: "completed", detail: "", reply: "hecho" });
    // The settings turn workflows on while the server is still building the fork's services.
    yield* turn(true);
    const start = workflows.start("paso-de-bot", {}, { idempotencyKey: "1" });
    const early = yield* Effect.exit(start);
    // A run the engine took before the fork was up has done what it would without it.
    if (Exit.isSuccess(early)) {
      yield* workflows.waitFor(early.value.runId, (run) => run.status === "completed");
    }
    yield* forkUp;
    const { runId } = Exit.isSuccess(early) ? early.value : yield* start;
    const done = yield* workflows.waitFor(runId, (run) => run.status === "completed");
    expect(done.result).toBe("done");
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.live("the fork going down stops workflows first, and its bot's step resumes unfailed", () =>
  Effect.gen(function* () {
    const { turn, forkUp, ended, watched, workflows } = yield* setup();
    yield* turn(true);
    const fork = yield* forkUp;
    const { runId } = yield* workflows.start("paso-de-bot", {}, { idempotencyKey: "1" });
    // The bot's turn is under way and the engine waits on it.
    yield* Deferred.await(watched);
    yield* Scope.close(fork, Exit.void);
    // Nothing runs on with the fork gone.
    expect((yield* Effect.flip(workflows.list())).message).toBe(Workflows.OFF);
    yield* Deferred.succeed(ended, { ending: "completed", detail: "", reply: "hecho" });
    yield* forkUp;
    const done = yield* workflows.waitFor(runId, (run) => run.status === "completed");
    expect(done.result).toBe("done");
    const steps = (yield* workflows.get(runId)).steps;
    expect(steps.filter((step) => step.status === "failed")).toEqual([]);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.live("settings turned on while the fork goes down leave workflows off", () =>
  Effect.gen(function* () {
    const { turn, forkUp, watched, stopping, workflows } = yield* setup();
    yield* turn(true);
    const fork = yield* forkUp;
    yield* workflows.start("paso-de-bot", {}, { idempotencyKey: "1" });
    yield* Deferred.await(watched);
    const down = yield* Effect.forkChild(Scope.close(fork, Exit.void));
    // The engine is stopping for the fork when the settings say on again.
    yield* Deferred.await(stopping);
    yield* turn(true);
    yield* Fiber.join(down);
    expect((yield* Effect.flip(workflows.list())).message).toBe(Workflows.OFF);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
