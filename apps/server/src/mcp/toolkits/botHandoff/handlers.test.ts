import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ForkBots from "../../../fork/bots/ForkBots.ts";
import * as ForkGaps from "../../../fork/gaps/ForkGaps.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as BotHandoffHandlers from "./handlers.ts";
import { BotHandoffToolkit } from "./tools.ts";

const caller = ThreadId.make("thread:not-a-bot");

const proposal = {
  handle: "editor",
  name: "Editor",
  role: "Edita vídeo",
  instructions: "Edita.",
  routine: "a demanda",
  reason: "Lo pediste tres veces.",
};
type GapSteps = ReadonlyArray<{ rung: string; result: string }>;

/** The handlers for a thread climbing a gap with these steps, or none when null. */
const handlersFor = (gapSteps: GapSteps | null, proposed: Array<string>) =>
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
          propose: (draft) =>
            Effect.sync(() => {
              proposed.push(draft.handle);
              return { id: "proposal:1" } as never;
            }),
        }),
        Layer.mock(ForkGaps.ForkGaps)({
          openGap: () =>
            Effect.succeed(
              gapSteps === null ? null : ({ name: "vídeo", steps: gapSteps } as never),
            ),
        }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

it.effect("refuses a thread that is not a bot's own, whatever bot it names", () =>
  Effect.gen(function* () {
    const toolkit = yield* BotHandoffToolkit;
    const result = yield* toolkit.handle("bot_handoff", { handle: "beto", text: "hazlo" }).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((parts) => parts.at(-1)?.result),
    );
    expect(result).toMatchObject({ code: "capability_denied" });
  }).pipe(Effect.provide(handlersFor(null, [])), Effect.scoped),
);

const propose = (gapSteps: GapSteps | null) => {
  const proposed: Array<string> = [];
  return Effect.gen(function* () {
    const toolkit = yield* BotHandoffToolkit;
    const result = yield* toolkit.handle("bot_propose", proposal).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((parts) => parts.at(-1)?.result),
    );
    return { result, proposed };
  }).pipe(Effect.provide(handlersFor(gapSteps, proposed)), Effect.scoped);
};

it.effect("a thread climbing a gap proposes a bot only while its hire rung is in progress", () =>
  Effect.gen(function* () {
    const building = yield* propose([{ rung: "build", result: "trying" }]);
    expect(building.result).toMatchObject({ code: "capability_denied" });
    expect(building.proposed).toEqual([]);
    const hiring = [
      { rung: "build", result: "failed" },
      { rung: "hire", result: "trying" },
    ];
    expect((yield* propose(hiring)).proposed).toEqual(["editor"]);
    expect((yield* propose(null)).proposed).toEqual(["editor"]);
    const gaveUp = [...hiring, { rung: "hire", result: "failed" }];
    expect((yield* propose(gaveUp)).proposed).toEqual([]);
  }),
);
