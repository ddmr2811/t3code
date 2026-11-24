import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ForkBots from "../../../fork/bots/ForkBots.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as BotHandoffHandlers from "./handlers.ts";
import { BotHandoffToolkit } from "./tools.ts";

const caller = ThreadId.make("thread:not-a-bot");

it.effect("refuses a thread that is not a bot's own, whatever bot it names", () =>
  Effect.gen(function* () {
    const toolkit = yield* BotHandoffToolkit;
    const result = yield* toolkit.handle("bot_handoff", { handle: "beto", text: "hazlo" }).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((parts) => parts.at(-1)?.result),
    );
    expect(result).toMatchObject({ code: "capability_denied" });
  }).pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(BotHandoffHandlers.layer).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.succeed(McpInvocationContext.McpInvocationContext, {
              environmentId: EnvironmentId.make("environment:handoff"),
              requestNamespace: "provider:handoff",
              thread: {
                threadId: caller,
                providerSessionId: "provider:handoff",
                providerInstanceId: ProviderInstanceId.make("codex"),
              },
              client: undefined,
              capabilities: new Set(["orchestration" as const]),
              issuedAt: 0,
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadShell: () => Effect.succeed(liveThreadShell(caller)),
            }),
            // Bots exist, but none of them owns the calling thread.
            Layer.mock(ForkBots.ForkBots)({
              list: () =>
                Effect.succeed({
                  bots: [{ id: "bot:ana", handle: "ana", threadId: ThreadId.make("thread:ana") }],
                  handoffs: [],
                  updatedAt: null,
                } as never),
              handoff: () => Effect.die("a refused caller must never hand work over"),
            }),
          ),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  ),
);
