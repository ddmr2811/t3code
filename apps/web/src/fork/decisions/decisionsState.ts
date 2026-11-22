// Fork-only: the threads on this machine that wait on the user, and whether the decisions panel is open.
import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { arrayElementsEqual } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { create } from "zustand";

import { usePrimaryEnvironmentId } from "~/state/environments";
import { environmentThreadShells } from "~/state/threads";
import {
  type DecisionsPanelChoice,
  isDecisionsPanelOpen,
  selectNeedsYouThreads,
} from "./decisions.logic";

const NO_THREADS: ReadonlyArray<EnvironmentThreadShell> = [];
const NO_THREADS_ATOM = Atom.make(NO_THREADS).pipe(Atom.withLabel("fork-needs-you:none"));

const needsYouThreadsAtom = Atom.family((environmentId: EnvironmentId) => {
  let previous = NO_THREADS;
  // Shells change on every streamed event; readers re-render only when the waiting list does.
  return Atom.make((get) => {
    const next = selectNeedsYouThreads(
      get(environmentThreadShells.visibleThreadShellsAtom),
      environmentId,
    );
    if (arrayElementsEqual(previous, next)) return previous;
    previous = next.length === 0 ? NO_THREADS : next;
    return previous;
  }).pipe(Atom.withLabel(`fork-needs-you:${environmentId}`));
});

const useDecisionsPanelChoice = create<{ choice: DecisionsPanelChoice | null }>(() => ({
  choice: null,
}));

export function useDecisionsPanel() {
  const environmentId = usePrimaryEnvironmentId();
  const threads = useAtomValue(
    environmentId === null ? NO_THREADS_ATOM : needsYouThreadsAtom(environmentId),
  );
  const choice = useDecisionsPanelChoice((state) => state.choice);
  const keys = threads.map((thread) =>
    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
  );
  const open = isDecisionsPanelOpen(choice, keys);
  const setOpen = (next: boolean) =>
    useDecisionsPanelChoice.setState({ choice: { open: next, seenKeys: keys } });
  return { threads, open, setOpen };
}
