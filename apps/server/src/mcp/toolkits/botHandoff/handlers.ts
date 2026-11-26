// @effect-diagnostics nodeBuiltinImport:off - sha256 of the handoff id has no Effect equivalent.
import * as NodeCrypto from "node:crypto";

import { type ForkBotsError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ForkBots from "../../../fork/bots/ForkBots.ts";
import * as ForkGaps from "../../../fork/gaps/ForkGaps.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller } from "../../threadAccess.ts";
import { refuseProposalOutsideLadder } from "./gapRules.ts";
import { BotHandoffToolkit } from "./tools.ts";

const toFailure = (error: ForkBotsError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "permissionDenied"
        ? "runtime_mode_escalation_denied"
        : error.reason === "storageFailed" ||
            error.reason === "unavailable" ||
            error.reason === "dispatchFailed"
          ? "orchestration_error"
          : "invalid_request",
    message: error.message,
  });

export const layer = McpToolAccess.toLayer(BotHandoffToolkit, {
  bot_handoff: McpToolAccess.actsAsCaller(({ handle, text, context }) =>
    Effect.gen(function* () {
      const forkBots = yield* ForkBots.ForkBots;
      const { caller, limits } = yield* loadCaller();
      const from = (yield* forkBots.list({}).pipe(Effect.mapError(toFailure))).bots.find(
        (bot) => caller !== undefined && bot.threadId === caller.id,
      );
      if (caller === undefined || from === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Only a bot's own thread can hand work to another bot.",
        });
      }
      // The same call in the same run gets the same id, so a retried call is not sent twice.
      const id = `handoff:${NodeCrypto.createHash("sha256")
        .update(
          [
            caller.id,
            caller.activeRunId ?? "",
            handle,
            text,
            ...(context === undefined ? [] : [context]),
          ].join("\u0000"),
        )
        .digest("hex")
        .slice(0, 40)}`;
      const result = yield* forkBots
        .handoff(
          {
            id,
            fromId: from.id,
            toHandle: handle,
            text,
            ...(context === undefined ? {} : { context }),
          },
          { kind: "agent", limits },
        )
        .pipe(Effect.mapError(toFailure));
      return {
        id: result.handoff.id,
        status: result.duplicate
          ? ("duplicate" as const)
          : result.handoff.status === "cut"
            ? ("cut" as const)
            : ("delivered" as const),
        hops: result.handoff.hops,
      };
    }),
  ),
  bot_propose: McpToolAccess.actsAsCaller((draft) =>
    Effect.gen(function* () {
      const forkBots = yield* ForkBots.ForkBots;
      const { caller, limits } = yield* loadCaller();
      if (caller === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Only the project's coordinator can propose a bot.",
        });
      }
      yield* refuseProposalOutsideLadder();
      const proposal = yield* forkBots
        .propose(draft, { threadId: caller.id, projectId: caller.projectId, limits })
        .pipe(Effect.mapError(toFailure));
      return { id: proposal.id };
    }),
  ),
  bot_gap_step: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const forkGaps = yield* ForkGaps.ForkGaps;
      const { caller } = yield* loadCaller();
      if (caller === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "Only a bot's own thread can record a gap or ask for an install.",
        });
      }
      const { gap, next } = yield* forkGaps
        .step(input, {
          threadId: caller.id,
          projectId: caller.projectId,
          runtimeMode: caller.runtimeMode,
          modelSelection: caller.modelSelection,
        })
        .pipe(Effect.mapError(toFailure));
      const installId = gap.steps.at(-1)?.install?.id;
      return { gapId: gap.id, ...(installId === undefined ? {} : { installId }), next };
    }),
  ),
});
