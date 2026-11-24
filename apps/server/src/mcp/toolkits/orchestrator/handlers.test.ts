import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, MessageId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ForkBots from "../../../fork/bots/ForkBots.ts";
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

const send = (from: ThreadId, to: ThreadId) => {
  const sent: Array<ThreadId> = [];
  return Effect.gen(function* () {
    const toolkit = yield* OrchestratorToolkit;
    const result = yield* toolkit.handle("t3_thread_send", { threadId: to, message: "hazlo" }).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((parts) => parts.at(-1)?.result),
    );
    return { result, sent };
  }).pipe(
    Effect.provide(
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
            Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
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
      ),
    ),
    Effect.scoped,
  );
};

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
