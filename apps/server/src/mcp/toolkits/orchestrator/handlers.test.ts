import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, MessageId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ForkBots from "../../../fork/bots/ForkBots.ts";
import * as ForkGaps from "../../../fork/gaps/ForkGaps.ts";
import * as RemoteDelegation from "../../../peer/RemoteDelegation.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as OrchestratorHandlers from "./handlers.ts";
import { OrchestratorToolkit } from "./tools.ts";

const ana = ThreadId.make("thread:bot-ana");
const beto = ThreadId.make("thread:bot-beto");
const plain = ThreadId.make("thread:plain");

interface Seen {
  readonly sent: Array<ThreadId>;
  readonly delegated: Array<{
    isolation?: string | undefined;
    runtimeMode?: string | undefined;
  }>;
}

/** The handlers as `from` calls them. Ana's thread is climbing a gap; nobody else is. */
const handlersFor = (from: ThreadId, { sent, delegated }: Seen) =>
  McpToolAccess.HandlersLayer.layer(OrchestratorHandlers.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId: EnvironmentId.make("environment:bot-to-bot"),
          requestNamespace: "provider:bot-to-bot",
          thread: {
            threadId: from,
            providerSessionId: "provider:bot-to-bot",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["orchestration" as const]),
          issuedAt: 0,
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
        }),
        Layer.mock(RemoteDelegation.RemoteDelegation)({}),
        Layer.mock(ForkBots.ForkBots)({
          isBotThread: (id) => Effect.succeed(id === ana || id === beto),
        }),
        Layer.mock(ForkGaps.ForkGaps)({
          openGap: (id) =>
            Effect.succeed(id === ana ? ({ name: "vídeo", steps: [] } as never) : null),
        }),
        Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
          delegateTask: (_scope, input) =>
            Effect.sync(() => {
              delegated.push(input);
              return {} as never;
            }),
          sendToThread: (_scope, input) =>
            Effect.sync(() => {
              sent.push(input.threadId);
              return {
                threadId: input.threadId,
                messageId: MessageId.make("message:sent"),
                runId: RunId.make("run:sent"),
                status: "running" as const,
                delivery: "started" as const,
              };
            }),
        }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const send = (from: ThreadId, to: ThreadId) => {
  const seen: Seen = { sent: [], delegated: [] };
  return Effect.gen(function* () {
    const toolkit = yield* OrchestratorToolkit;
    const result = yield* toolkit.handle("t3_thread_send", { threadId: to, message: "hazlo" }).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((parts) => parts.at(-1)?.result),
    );
    return { result, sent: seen.sent };
  }).pipe(Effect.provide(handlersFor(from, seen)), Effect.scoped);
};

const delegate = (from: ThreadId) => {
  const seen: Seen = { sent: [], delegated: [] };
  return Effect.gen(function* () {
    const toolkit = yield* OrchestratorToolkit;
    yield* toolkit
      .handle("delegate_task", { task: "hazlo", isolation: "shared", runtimeMode: "full-access" })
      // The stand-in service returns no task, so only what reached it matters.
      .pipe(Stream.unwrap, Stream.runCollect, Effect.exit);
    return seen.delegated;
  }).pipe(Effect.provide(handlersFor(from, seen)), Effect.scoped);
};

it.effect("a thread climbing a gap builds only in a new worktree that asks for everything", () =>
  Effect.gen(function* () {
    expect(yield* delegate(ana)).toMatchObject([
      { isolation: "worktree", runtimeMode: "approval-required" },
    ]);
    expect(yield* delegate(plain)).toMatchObject([
      { isolation: "shared", runtimeMode: "full-access" },
    ]);
  }),
);

it.effect("a bot reaches another bot's thread only through bot_handoff", () =>
  Effect.gen(function* () {
    const botToBot = yield* send(ana, beto);
    expect(botToBot.result).toMatchObject({ code: "capability_denied" });
    expect(botToBot.sent).toEqual([]);

    expect((yield* send(plain, ana)).sent).toEqual([ana]);
    expect((yield* send(ana, plain)).sent).toEqual([plain]);
    expect((yield* send(ana, ana)).sent).toEqual([ana]);
  }),
);
