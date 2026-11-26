import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { actsOutsideWithoutApproval, DispatchModeLimit } from "./DispatchModeLimit.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for metadata commands"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "dispatch-mode-limit" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const supervised = { runtimeMode: "approval-required", interactionMode: "default" } as const;

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:dispatch-mode-limit"),
      title: "Before",
      modelSelection: { instanceId, model: "gpt-5" },
      ...supervised,
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

it.layer(layerTest)("DispatchModeLimit", (it) => {
  it.effect("refuses a limited command on a thread its user raised, and records nothing", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:limit-raised");
      yield* createThread(threadId);
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("raise"),
        threadId,
        runtimeMode: "full-access",
      });
      const rename = {
        type: "thread.metadata.update",
        commandId: CommandId.make("rename"),
        threadId,
        title: "After",
      } as const;
      const refused = yield* orchestrator
        .dispatch(rename)
        .pipe(Effect.provideService(DispatchModeLimit, supervised), Effect.flip);
      assert.equal(refused._tag, "OrchestratorThreadAboveModeLimitError");
      assert.equal((yield* projections.getThreadShell(threadId))?.title, "Before");

      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("lower"),
        threadId,
        runtimeMode: "approval-required",
      });
      yield* orchestrator
        .dispatch(rename)
        .pipe(Effect.provideService(DispatchModeLimit, supervised));
      assert.equal((yield* projections.getThreadShell(threadId))?.title, "After");
    }),
  );

  it.effect("refuses to fork a source thread its user raised", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sourceThreadId = ThreadId.make("thread:limit-fork-source");
      const targetThreadId = ThreadId.make("thread:limit-fork-target");
      yield* createThread(sourceThreadId);
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("raise-source"),
        threadId: sourceThreadId,
        runtimeMode: "full-access",
      });
      const fork = {
        type: "thread.fork",
        commandId: CommandId.make("fork"),
        sourceThreadId,
        targetThreadId,
        sourcePoint: { type: "latest_stable" },
        createdBy: "agent",
        creationSource: "mcp",
      } as const;
      const refused = yield* orchestrator
        .dispatch(fork)
        .pipe(Effect.provideService(DispatchModeLimit, supervised), Effect.flip);
      assert.ok(refused._tag === "OrchestratorThreadAboveModeLimitError");
      assert.equal(refused.threadId, sourceThreadId);
      assert.isNull(yield* projections.getThreadShell(targetThreadId));

      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("lower-source"),
        threadId: sourceThreadId,
        runtimeMode: "approval-required",
      });
      const retried = yield* orchestrator
        .dispatch(fork)
        .pipe(Effect.provideService(DispatchModeLimit, supervised), Effect.flip);
      assert.equal(retried._tag, "OrchestratorDispatchError");
    }),
  );
});

/**
 * A running turn, then `queued` behind it (sent under `supervised` where listed in `limited`),
 * and the thread raised by its user while they wait.
 */
const raisedBehindActive = (name: string, queued: ReadonlyArray<string>, limited: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make(`thread:${name}`);
    yield* createThread(threadId);
    for (const key of ["active", ...queued]) {
      yield* orchestrator
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${name}-${key}`),
          threadId,
          messageId: MessageId.make(`${name}-${key}`),
          text: key,
          attachments: [],
          modelSelection: { instanceId, model: "gpt-5" },
          dispatchMode: { type: key === "active" ? "start_immediately" : "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        })
        .pipe(Effect.provideService(DispatchModeLimit, key === limited ? supervised : undefined));
    }
    yield* orchestrator.dispatch({
      type: "thread.runtime-mode.set",
      commandId: CommandId.make(`${name}-raise`),
      threadId,
      runtimeMode: "full-access",
    });
    const runs = (yield* orchestrator.getThreadProjection(threadId)).runs;
    const run = (key: string) =>
      runs.find((candidate) => candidate.userMessageId === `${name}-${key}`)!;
    const statusOf = (key: string) =>
      Effect.map(
        orchestrator.getThreadProjection(threadId),
        (projection) => projection.runs.find((candidate) => candidate.id === run(key).id)?.status,
      );
    return { orchestrator, threadId, run, statusOf };
  });

it.layer(layerTest)("DispatchModeLimit on a queued run", (it) => {
  it.effect("cancels a limited sender's queued run once its user raised the thread", () =>
    Effect.gen(function* () {
      const { orchestrator, threadId, run, statusOf } = yield* raisedBehindActive(
        "limit-queued",
        ["queued"],
        "queued",
      );
      const active = run("active");
      const queued = run("queued");
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("limit-queued-interrupt"),
        threadId,
        runId: active.id,
      });
      assert.equal(yield* statusOf("queued"), "cancelled");
      assert.equal(queued.status, "queued");
    }),
  );

  it.effect("steers no turn with a limited sender's queued message above its limit", () =>
    Effect.gen(function* () {
      const { orchestrator, threadId, run, statusOf } = yield* raisedBehindActive(
        "limit-steer",
        ["queued"],
        "queued",
      );
      const refused = yield* orchestrator
        .dispatch({
          type: "queued-message.promote-to-steer",
          commandId: CommandId.make("limit-steer-promote"),
          threadId,
          queuedRunId: run("queued").id,
          targetRunId: run("active").id,
        })
        .pipe(Effect.flip);
      assert.equal(refused._tag, "OrchestratorDispatchError");
      assert.equal(yield* statusOf("queued"), "queued");
    }),
  );

  it.effect("a start asked for a limited run it cancels starts no other in its place", () =>
    Effect.gen(function* () {
      const { orchestrator, threadId, run, statusOf } = yield* raisedBehindActive(
        "limit-start",
        ["mine", "limited"],
        "limited",
      );
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("limit-start-stop"),
        threadId,
        runId: run("active").id,
        holdQueue: true,
      });
      yield* orchestrator.dispatch({
        type: "queued-run.start",
        commandId: CommandId.make("limit-start-start"),
        threadId,
        runId: run("limited").id,
      });
      assert.equal(yield* statusOf("limited"), "cancelled");
      assert.equal(yield* statusOf("mine"), "queued");
    }),
  );
});

const layerPolicyDatabase = SqlitePersistence.layerMemory;
const layerWithCeiling = Layer.mergeAll(
  layerPolicyDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerPolicyDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "runtime-mode-ceiling" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    {
      databaseLayer: layerPolicyDatabase,
      runEffectWorker: false,
      managedPolicy: {
        schemaVersion: 1,
        organization: "Example Corp",
        limits: { maxRuntimeMode: "auto-accept-edits" },
      },
    },
  ),
);

const sendMessage = (threadId: ThreadId, id: string) => ({
  type: "message.dispatch" as const,
  commandId: CommandId.make(`send:${id}`),
  threadId,
  messageId: MessageId.make(`message:${id}`),
  text: id,
  attachments: [],
  dispatchMode: { type: "start_immediately" as const },
  createdBy: "user" as const,
  creationSource: "web" as const,
});

/** A thread that ran in full access before the policy arrived, as an import or an older build leaves it. */
const raiseBehindPolicy = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    yield* createThread(threadId);
    const { thread } = yield* orchestrator.getThreadRecords(threadId, []);
    yield* sink.write({
      events: [
        {
          id: EventId.make(`event:raise-behind-policy:${threadId}`),
          type: "thread.runtime-mode-updated",
          threadId,
          occurredAt: yield* DateTime.now,
          payload: { ...thread, runtimeMode: "full-access" },
        },
      ],
    });
  });

it.layer(layerWithCeiling)("runtime mode ceiling", (it) => {
  it.effect("refuses the user's own thread and mode changes above the ceiling", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:ceiling-user");
      const create = {
        type: "thread.create",
        commandId: CommandId.make("create:ceiling-user:full"),
        threadId,
        projectId: ProjectId.make("project:dispatch-mode-limit"),
        title: "Full",
        modelSelection: { instanceId, model: "gpt-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      } as const;
      const refusedCreate = yield* orchestrator.dispatch(create).pipe(Effect.flip);
      assert.ok(refusedCreate._tag === "OrchestratorRuntimeModeAboveCeilingError");
      assert.equal(refusedCreate.refused, "mode");
      assert.equal(refusedCreate.message, "Example Corp limits threads to Auto-accept edits.");
      assert.isNull(yield* projections.getThreadShell(threadId));

      yield* createThread(threadId);
      const raise = yield* orchestrator
        .dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("raise:ceiling-user"),
          threadId,
          runtimeMode: "auto",
        })
        .pipe(Effect.flip);
      assert.equal(raise._tag, "OrchestratorRuntimeModeAboveCeilingError");
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("raise-to-ceiling:ceiling-user"),
        threadId,
        runtimeMode: "auto-accept-edits",
      });
      assert.equal((yield* projections.getThreadShell(threadId))?.runtimeMode, "auto-accept-edits");
    }),
  );

  it.effect("narrows an MCP caller's limit to the ceiling inside the lock", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:ceiling-mcp");
      yield* createThread(threadId);
      const fullAccessCaller = { runtimeMode: "full-access", interactionMode: "default" } as const;
      const raise = yield* orchestrator
        .dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("raise:ceiling-mcp"),
          threadId,
          runtimeMode: "full-access",
        })
        .pipe(Effect.provideService(DispatchModeLimit, fullAccessCaller), Effect.flip);
      assert.equal(raise._tag, "OrchestratorRuntimeModeAboveCeilingError");

      const raisedThreadId = ThreadId.make("thread:ceiling-mcp-raised");
      yield* raiseBehindPolicy(raisedThreadId);
      const rename = yield* orchestrator
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("rename:ceiling-mcp"),
          threadId: raisedThreadId,
          title: "After",
        })
        .pipe(Effect.provideService(DispatchModeLimit, fullAccessCaller), Effect.flip);
      assert.equal(rename._tag, "OrchestratorThreadAboveModeLimitError");
      assert.equal((yield* projections.getThreadShell(raisedThreadId))?.title, "Before");
    }),
  );

  it.effect("refuses turns on a thread above the ceiling until its mode is lowered", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:ceiling-raised");
      yield* raiseBehindPolicy(threadId);

      const refused = yield* orchestrator
        .dispatch(sendMessage(threadId, "first"))
        .pipe(Effect.flip);
      assert.ok(refused._tag === "OrchestratorRuntimeModeAboveCeilingError");
      assert.equal(refused.refused, "turn");
      assert.equal(
        refused.message,
        "Example Corp limits threads to Auto-accept edits. Switch this thread's mode to continue.",
      );
      assert.lengthOf((yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs, 0);

      // The user's own housekeeping and the way back down stay open.
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("rename:ceiling-raised"),
        threadId,
        title: "After",
      });
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("lower:ceiling-raised"),
        threadId,
        runtimeMode: "approval-required",
      });
      // Refusals record no receipt, so the same command goes through once the mode is lowered.
      yield* orchestrator.dispatch(sendMessage(threadId, "first"));
      assert.lengthOf((yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs, 1);
      assert.equal((yield* projections.getThreadShell(threadId))?.title, "After");
    }),
  );

  it.effect("starts a queue that waited above the ceiling once the mode is lowered", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("thread:ceiling-queue");
      yield* createThread(threadId);
      yield* orchestrator.dispatch(sendMessage(threadId, "running"));
      yield* orchestrator.dispatch({
        ...sendMessage(threadId, "waiting"),
        dispatchMode: { type: "queue_after_active" },
      });
      // The policy arrives with the thread above it and its first run ending.
      const { thread, runs } = yield* orchestrator.getThreadRecords(threadId, ["runs"]);
      const [running, waiting] = runs;
      const occurredAt = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:ceiling-queue:raise"),
            type: "thread.runtime-mode-updated",
            threadId,
            occurredAt,
            payload: { ...thread, runtimeMode: "full-access" },
          },
          {
            id: EventId.make("event:ceiling-queue:complete"),
            type: "run.updated",
            threadId,
            runId: running!.id,
            providerInstanceId: running!.providerInstanceId,
            occurredAt,
            payload: { ...running!, status: "completed" },
          },
        ],
      });

      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("lower:ceiling-queue"),
        threadId,
        runtimeMode: "approval-required",
      });
      const started = (yield* orchestrator.getThreadRecords(threadId, ["runs"])).runs.find(
        (run) => run.id === waiting!.id,
      );
      assert.notEqual(started?.status, "queued");
    }),
  );
});

it.each([
  ["approval-required", "default", false],
  ["auto-accept-edits", "default", false],
  ["auto", "default", true],
  ["full-access", "default", true],
  ["approval-required", "plan", false],
  ["auto", "plan", false],
  ["full-access", "plan", false],
] as const)(
  "a %s/%s caller acts outside T3 without approval: %s",
  (runtimeMode, interactionMode, expected) => {
    assert.strictEqual(actsOutsideWithoutApproval({ runtimeMode, interactionMode }), expected);
  },
);
