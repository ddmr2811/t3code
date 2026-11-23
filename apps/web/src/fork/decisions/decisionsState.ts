// Fork-only: the threads on every connected machine that wait on the user, and whether the decisions panel is open.
import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { arrayElementsEqual } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { create } from "zustand";

import { useEnvironmentsWithScope } from "~/state/session";
import { environmentThreadShells } from "~/state/threads";
import {
  type DecisionsPanelChoice,
  isDecisionsPanelOpen,
  selectNeedsYouThreads,
} from "./decisions.logic";

const NO_THREADS: ReadonlyArray<EnvironmentThreadShell> = [];

const needsYouThreadsAtom = (() => {
  let previous = NO_THREADS;
  // Quiet shells keep their reference through streaming; readers re-render only when the waiting list does.
  return Atom.make((get) => {
    const next = selectNeedsYouThreads(get(environmentThreadShells.quietThreadShellsAtom));
    if (arrayElementsEqual(previous, next)) return previous;
    previous = next.length === 0 ? NO_THREADS : next;
    return previous;
  }).pipe(Atom.withLabel("fork-needs-you"));
})();

const useDecisionsPanelChoice = create<{ choice: DecisionsPanelChoice | null }>(() => ({
  choice: null,
}));

export function useDecisionsPanel() {
  const waiting = useAtomValue(needsYouThreadsAtom);
  // A connection that cannot answer is not asked to.
  const operable = useEnvironmentsWithScope(
    [...new Set(waiting.map((thread) => thread.environmentId))].map((environmentId) => ({
      environmentId,
    })),
    AuthOrchestrationOperateScope,
  );
  const threads = waiting.filter((thread) => operable.has(thread.environmentId));
  const choice = useDecisionsPanelChoice((state) => state.choice);
  const keys = threads.map((thread) =>
    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
  );
  const open = isDecisionsPanelOpen(choice, keys);
  const setOpen = (next: boolean) =>
    useDecisionsPanelChoice.setState({ choice: { open: next, seenKeys: keys } });
  return { threads, open, setOpen };
}
