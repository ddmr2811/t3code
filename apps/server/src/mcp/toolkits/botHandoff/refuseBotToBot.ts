import { OrchestratorMcpFailure, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ForkBots from "../../../fork/bots/ForkBots.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/** Fork: a bot writing straight into another bot's thread skips the hop limit, so only `bot_handoff` may. */
export const refuseBotToBot = Effect.fnUntraced(function* (target: ThreadId | undefined) {
  const forkBots = yield* Effect.serviceOption(ForkBots.ForkBots);
  const caller = (yield* McpInvocationContext.McpInvocationContext).thread?.threadId;
  if (Option.isNone(forkBots) || caller === undefined || target === undefined || caller === target)
    return;
  if ((yield* forkBots.value.isBotThread(caller)) && (yield* forkBots.value.isBotThread(target))) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Para pasar trabajo a otro bot usa bot_handoff, que cuenta saltos y deja traza.",
    });
  }
});
