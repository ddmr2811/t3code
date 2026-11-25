import {
  OrchestratorMcpFailure,
  type OrchestratorMcpDelegateTaskInput,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ForkGaps from "../../../fork/gaps/ForkGaps.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/** The gap the calling thread is climbing, if any. A store that cannot be read refuses the call. */
const callerGap = Effect.fnUntraced(function* () {
  const forkGaps = yield* Effect.serviceOption(ForkGaps.ForkGaps);
  const caller = (yield* McpInvocationContext.McpInvocationContext).thread?.threadId;
  if (Option.isNone(forkGaps) || caller === undefined) return null;
  return yield* forkGaps.value
    .openGap(caller)
    .pipe(
      Effect.mapError(
        (error) =>
          new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
      ),
    );
});

/** Fork: while a thread climbs a gap, what it builds runs in a new worktree and asks for everything. */
export const delegateWithinGap = Effect.fnUntraced(function* (
  input: OrchestratorMcpDelegateTaskInput,
) {
  if ((yield* callerGap()) === null) return input;
  return { ...input, isolation: "worktree" as const, runtimeMode: "approval-required" as const };
});

/** Fork: a proposed bot never gets full access, and a gap reaches it only through its hire rung. */
export const refuseProposalOutsideLadder = Effect.fnUntraced(function* (
  runtimeMode: RuntimeMode | undefined,
) {
  if (runtimeMode === "full-access") {
    return yield* new OrchestratorMcpFailure({
      code: "runtime_mode_escalation_denied",
      message: "Un bot propuesto nunca va en full-access.",
    });
  }
  const gap = yield* callerGap();
  if (gap !== null && !gap.steps.some((step) => step.rung === "hire" && step.result === "trying")) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: `Tienes abierto el hueco «${gap.name}»: un bot se propone solo desde su peldaño hire, después de que construir falle.`,
    });
  }
});
