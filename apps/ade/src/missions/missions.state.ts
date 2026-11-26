import { useAtomSet } from "@effect/atom-react";
import {
  groupWorkflowRuns,
  listedWorkflowRuns,
  type WorkflowRunNode,
  workflowRunLists,
} from "@t3tools/client-runtime/workflows";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { viewAtom } from "../overview/Overview.tsx";
import { operableEnvironmentIdsAtom, serverEnvironment } from "../state.ts";
import { missionKey } from "./mission.logic.ts";

const readMission = () => new URLSearchParams(window.location.search).get("mision");

/** The open mission, in `?mision=` beside `?vista=misiones`, so Back closes it. */
export const missionKeyAtom = Atom.writable(
  (get) => {
    const onPopState = () => get.setSelf(readMission());
    window.addEventListener("popstate", onPopState);
    get.addFinalizer(() => window.removeEventListener("popstate", onPopState));
    return readMission();
  },
  (ctx, key: string | null) => {
    const url = new URL(window.location.href);
    if (key === null) url.searchParams.delete("mision");
    else url.searchParams.set("mision", key);
    if (url.href === window.location.href) return;
    window.history.pushState(null, "", url);
    ctx.setSelf(key);
  },
).pipe(Atom.keepAlive);

// The same live lists the inbox reads its questions from: one subscription per machine.
export const missionsLiveAtom = Atom.make((get) => {
  const environmentIds = [...get(operableEnvironmentIdsAtom)].toSorted();
  return get(serverEnvironment.workflowsLiveAcross(JSON.stringify(environmentIds)));
}).pipe(Atom.withLabel("ade-missions-live"));

export const openQuestions = (node: WorkflowRunNode): number =>
  node.questions.length + node.children.reduce((sum, child) => sum + openQuestions(child), 0);

/** Every machine's runs, what waits on the user first, then what runs, newest first. */
export const missionRowsAtom = Atom.make((get) => {
  const across = get(missionsLiveAtom);
  const loaded = across.filter(({ result }) => Option.isSome(AsyncResult.value(result))).length;
  const rows = across
    .flatMap(({ environmentId, result }) => {
      const snapshot = Option.getOrUndefined(AsyncResult.value(result));
      if (snapshot === undefined) return [];
      const { runs } = listedWorkflowRuns(snapshot.runs, false);
      const lists = workflowRunLists(
        groupWorkflowRuns(snapshot.workflows, runs, snapshot.questions),
      );
      const needsYou = new Set(lists["needs-you"].map((node) => node.run.runId));
      return lists.all.map((node) => ({
        environmentId,
        node,
        triggers: snapshot.workflows.find((w) => w.name === node.run.workflow)?.triggers ?? [],
        rank: needsYou.has(node.run.runId) ? 0 : node.run.endedAt === null ? 1 : 2,
      }));
    })
    .sort(
      (left, right) =>
        left.rank - right.rank || right.node.run.updatedAt.localeCompare(left.node.run.updatedAt),
    );
  return { rows, loaded };
}).pipe(Atom.withLabel("ade-mission-rows"));

/** Opens a mission from any screen: Misiones first, then the run, so Back returns to the list. */
export function useOpenMission() {
  const setView = useAtomSet(viewAtom);
  const setMission = useAtomSet(missionKeyAtom);
  return (environmentId: EnvironmentId, runId: string) => {
    setView("misiones");
    setMission(missionKey(environmentId, runId));
  };
}

/** The runs still going, each with its steps once read: the featured mission, the rail and counts. */
export const activeMissionsAtom = Atom.make((get) => {
  const operable = get(operableEnvironmentIdsAtom);
  return get(missionRowsAtom)
    .rows.filter(({ node }) => node.run.endedAt === null)
    .toSorted((left, right) => right.node.run.updatedAt.localeCompare(left.node.run.updatedAt))
    .map((row) => ({
      ...row,
      detail: operable.has(row.environmentId)
        ? Option.getOrUndefined(
            AsyncResult.value(
              get(
                serverEnvironment.workflowRun({
                  environmentId: row.environmentId,
                  input: { runId: row.node.run.runId },
                }),
              ),
            ),
          )
        : undefined,
    }));
}).pipe(Atom.withLabel("ade-active-missions"));
