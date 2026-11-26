import type { EnvironmentId, WorkflowQuestion } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { operableEnvironmentIdsAtom, serverEnvironment } from "../state.ts";

export interface OpenWorkflowQuestion {
  readonly environmentId: EnvironmentId;
  readonly question: WorkflowQuestion;
  /** The workflow the run belongs to, when the runs list still has it. */
  readonly workflow: string | null;
}

/**
 * The questions workflow runs wait on, on every machine this session may answer on, and the
 * machines whose list has arrived: only those may alert, so opening the ADE never does.
 */
export const workflowQuestionsAtom = Atom.make((get) => {
  const environmentIds = [...get(operableEnvironmentIdsAtom)].toSorted();
  const across = get(serverEnvironment.workflowsLiveAcross(JSON.stringify(environmentIds)));
  const questions: Array<OpenWorkflowQuestion> = [];
  const loaded = new Set<EnvironmentId>();
  for (const { environmentId, result } of across) {
    const snapshot = Option.getOrUndefined(AsyncResult.value(result));
    // Workflows off, or a server without them: nothing waits there.
    if (snapshot === undefined) continue;
    loaded.add(environmentId);
    for (const question of snapshot.questions) {
      const run = snapshot.runs.find((candidate) => candidate.runId === question.runId);
      questions.push({ environmentId, question, workflow: run?.workflow ?? null });
    }
  }
  return { questions, loaded };
}).pipe(Atom.withLabel("ade-workflow-questions"));

export const workflowQuestionKey = ({ environmentId, question }: OpenWorkflowQuestion) =>
  `workflow:${environmentId}:${question.runId}:${question.name}`;
