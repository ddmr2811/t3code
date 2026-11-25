import { OrchestratorMcpFailure, type OrchestratorMcpDelegateTaskInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ForkGaps from "../../../fork/gaps/ForkGaps.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/** Whether any gap the calling thread climbs is on this rung now. An unreadable store refuses. */
const callerGaps = Effect.fnUntraced(function* (rung: "build" | "hire") {
  const forkGaps = yield* Effect.serviceOption(ForkGaps.ForkGaps);
  const caller = (yield* McpInvocationContext.McpInvocationContext).thread?.threadId;
  if (Option.isNone(forkGaps) || caller === undefined) return { open: 0, onRung: false };
  const gaps = yield* forkGaps.value
    .openGaps(caller)
    .pipe(
      Effect.mapError(
        (error) =>
          new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
      ),
    );
  const onRung = gaps.some((gap) => {
    const last = gap.steps.at(-1);
    return last?.rung === rung && last.result === "trying";
  });
  return { open: gaps.length, onRung };
});

/**
 * Fork: while a thread is on the build rung of any of its gaps, what it delegates runs here, in
 * a new worktree, and asks for everything. Any other delegation is left as it is.
 */
export const delegateWithinGap = Effect.fnUntraced(function* (
  input: OrchestratorMcpDelegateTaskInput,
) {
  if (!(yield* callerGaps("build")).onRung) return input;
  const here = (yield* McpInvocationContext.McpInvocationContext).environmentId;
  const target = input.target?.environmentId;
  if (target !== undefined && target !== here) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message:
        "Estás construyendo lo que falta de un hueco: eso se delega en esta máquina, no en otra. Apunta antes cómo acabó el peldaño build.",
    });
  }
  return { ...input, isolation: "worktree" as const, runtimeMode: "approval-required" as const };
});

/** Fork: a thread climbing gaps proposes a bot only while a hire rung of its own is in progress. */
export const refuseProposalOutsideLadder = Effect.fnUntraced(function* () {
  const gaps = yield* callerGaps("hire");
  if (gaps.open > 0 && !gaps.onRung) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message:
        "Tienes un hueco abierto: un bot se propone solo con su peldaño hire en curso, después de que construir falle.",
    });
  }
});
