import {
  FORK_BOTS_HANDOFF_MAX_HOPS,
  ForkBotHandle,
  ForkBotHandoffId,
  ForkBotMessage,
  ForkBotName,
  ForkBotProposalInstructions,
  ForkBotProposalId,
  ForkBotProposalNote,
  ForkBotRole,
  ForkGapId,
  ForkGapInstallDraft,
  ForkGapInstallId,
  ForkGapName,
  ForkGapNote,
  ForkGapResult,
  ForkGapRung,
  OrchestratorMcpFailure,
  RuntimeMode,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ForkBots from "../../../fork/bots/ForkBots.ts";
import * as ForkGaps from "../../../fork/gaps/ForkGaps.ts";
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
  description: `Hand work to another bot by its @handle when it belongs to that bot's role. \`text\` is queued in that bot's own thread and no answer comes back here, so say what you need and where to leave the result. A repeated call is ignored, a chain between bots stops after ${FORK_BOTS_HANDOFF_MAX_HOPS} hops and goes to the user, and a bot with broader permissions than yours is refused. Writing to a bot's thread with other T3 tools does not reset the hop count.`,
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

const BotProposeTool = Tool.make("bot_propose", {
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ForkBots.ForkBots,
  ],
  description:
    "Coordinator only. Propose a new bot to the user when they asked for the same kind of work at least 3 times in the last 30 days and no bot covers it. Nothing is created: the proposal waits in the user's inbox for yes or no. At most one proposal per project and week; a bot the user said no to is refused, and project_memory_search lists those refusals, so do not propose anything similar.",
  parameters: Schema.Struct({
    handle: ForkBotHandle.annotate({ description: "Without the @." }),
    name: ForkBotName,
    role: ForkBotRole,
    instructions: ForkBotProposalInstructions,
    routine: ForkBotProposalNote.annotate({
      description: "When it should run on its own, e.g. «cada lunes a las 09:00», or «a demanda».",
    }),
    reason: ForkBotProposalNote.annotate({
      description: "The repeated requests that led to it, with their dates.",
    }),
    runtimeMode: Schema.optionalKey(RuntimeMode).annotate({
      description: "Defaults to approval-required; never above your own.",
    }),
    model: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))).annotate({
      description: "A model of your own provider; defaults to yours.",
    }),
  }),
  success: Schema.Struct({ id: ForkBotProposalId }),
})
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenOutsideBotThreads);

const BotGapStepTool = Tool.make("bot_gap_step", {
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ForkGaps.ForkGaps,
  ],
  description:
    "When you lack a tool or capability, climb this ladder and call this for every step, so it is written on the project board: reuse (a bot, MCP tool or skill that exists), install, build (a child thread in a new worktree), hire (propose a bot, only after build failed). Follow the returned `next`. An install is never run on your own: send `install` with the exact command and how to undo it, end your turn, and run it yourself only after the user's yes arrives in this thread, once, unchanged. Command and undo are one command each, with no ; & | or redirection; one install per gap; a system install only from approval-required. No clear way to undo it means do not ask. Each gap has a limit of steps and tokens; when it closes, stop and tell the user.",
  parameters: Schema.Struct({
    gap: ForkGapName.annotate({ description: "What is missing; the same text on every step." }),
    rung: ForkGapRung,
    result: ForkGapResult.annotate({
      description: "trying before you act, then worked or failed.",
    }),
    note: ForkGapNote.annotate({ description: "One line: what you tried or found." }),
    install: Schema.optionalKey(ForkGapInstallDraft).annotate({
      description:
        "Only with rung install and result trying. scope system is anything outside the project (global packages, binaries, sudo).",
    }),
  }),
  success: Schema.Struct({
    gapId: ForkGapId,
    installId: Schema.optionalKey(ForkGapInstallId),
    next: Schema.String,
  }),
})
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenOutsideBotThreads);

export const BotHandoffToolkit = Toolkit.make(BotHandoffTool, BotProposeTool, BotGapStepTool);
