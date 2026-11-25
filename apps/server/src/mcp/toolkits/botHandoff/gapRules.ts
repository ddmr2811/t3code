import { OrchestratorMcpFailure, type OrchestratorMcpDelegateTaskInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ForkGaps from "../../../fork/gaps/ForkGaps.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/** The last step of the gap the calling thread climbs, if any. An unreadable store refuses. */
const callerGapStep = Effect.fnUntraced(function* () {
  const forkGaps = yield* Effect.serviceOption(ForkGaps.ForkGaps);
  const caller = (yield* McpInvocationContext.McpInvocationContext).thread?.threadId;
  if (Option.isNone(forkGaps) || caller === undefined) return null;
  const gap = yield* forkGaps.value
    .openGap(caller)
    .pipe(
      Effect.mapError(
        (error) =>
          new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
      ),
    );
  return gap === null ? null : { gap: gap.name, last: gap.steps.at(-1) };
});

/**
 * Fork: while a thread is on the build rung of a gap, what it delegates runs here, in a new
 * worktree, and asks for everything. Any other delegation is left as it is.
 */
export const delegateWithinGap = Effect.fnUntraced(function* (
  input: OrchestratorMcpDelegateTaskInput,
) {
  const step = (yield* callerGapStep())?.last;
  if (step?.rung !== "build" || step.result !== "trying") return input;
  if (input.target?.environmentId !== undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message:
        "Estás construyendo lo que falta de un hueco: eso se delega en esta máquina, no en otra. Apunta antes cómo acabó el peldaño build.",
    });
  }
  return { ...input, isolation: "worktree" as const, runtimeMode: "approval-required" as const };
});

/** Fork: a thread climbing a gap proposes a bot only while its hire rung is the one in progress. */
export const refuseProposalOutsideLadder = Effect.fnUntraced(function* () {
  const step = yield* callerGapStep();
  if (step !== null && (step.last?.rung !== "hire" || step.last.result !== "trying")) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: `Tienes abierto el hueco «${step.gap}»: un bot se propone solo con su peldaño hire en curso, después de que construir falle.`,
    });
  }
});
