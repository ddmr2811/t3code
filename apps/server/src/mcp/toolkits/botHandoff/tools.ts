import {
  FORK_BOTS_HANDOFF_MAX_HOPS,
  ForkBotHandle,
  ForkBotHandoffId,
  ForkBotMessage,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ForkBots from "../../../fork/bots/ForkBots.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

// Fork: only a bot's own thread sees it, so other threads pay nothing for it.
const BotHandoffTool = Tool.make("bot_handoff", {
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ForkBots.ForkBots,
  ],
  description: `Hand work to another bot by its @handle when it belongs to that bot's role. \`text\` is queued in that bot's own thread and no answer comes back here, so say what you need and where to leave the result. A repeated call is ignored, a chain between bots stops after ${FORK_BOTS_HANDOFF_MAX_HOPS} hops and goes to the user, and a bot with broader permissions than yours is refused.`,
  parameters: Schema.Struct({
    handle: ForkBotHandle.annotate({ description: "Without the @." }),
    text: ForkBotMessage,
  }),
  success: Schema.Struct({
    id: ForkBotHandoffId,
    status: Schema.Literals(["delivered", "cut", "duplicate"]),
    hops: Schema.Number,
  }),
})
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenOutsideBotThreads);

export const BotHandoffToolkit = Toolkit.make(BotHandoffTool);
