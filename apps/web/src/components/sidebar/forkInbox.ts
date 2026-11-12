// Fork-only: splits the sidebar inbox into threads that wait on the user and
// threads whose work simply finished. Kept in its own file so upstream merges
// touch as little as possible.
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

type AttentionInput = Pick<
  EnvironmentThreadShell,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "pendingGuestMessageCount"
  | "interactionMode"
  | "latestRun"
  | "runtime"
>;

/**
 * Whether a finished thread only reports completed work; anything else in the inbox waits on the user.
 * The shell carries no message text, so a question asked in prose still reads as completed.
 */
export function isWorkCompletedThread(thread: AttentionInput): boolean {
  if (thread.latestRun?.status !== "completed") return false;
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false;
  if (thread.pendingSubagentRequest != null) return false;
  if ((thread.pendingGuestMessageCount ?? 0) > 0) return false;
  if (thread.interactionMode === "plan" && thread.hasActionableProposedPlan) return false;
  if (thread.runtime?.lastError != null) return false;
  return true;
}

/**
 * Pinned threads that wait on the user stay at the top; the ones still working
 * or already finished move to their own shelf below. Keeps input order.
 */
export function splitPinnedByAttention<T extends AttentionInput>(
  threads: readonly T[],
  isWorking: (thread: T) => boolean,
): { readonly needsInput: T[]; readonly rest: T[] } {
  const needsInput: T[] = [];
  const rest: T[] = [];
  for (const thread of threads) {
    (isWorking(thread) || isWorkCompletedThread(thread) ? rest : needsInput).push(thread);
  }
  return { needsInput, rest };
}

/** Keeps each list in its input order. */
export function splitInboxByAttention<T extends AttentionInput>(
  threads: readonly T[],
): { readonly needsInput: T[]; readonly completed: T[] } {
  const needsInput: T[] = [];
  const completed: T[] = [];
  for (const thread of threads)
    (isWorkCompletedThread(thread) ? completed : needsInput).push(thread);
  return { needsInput, completed };
}
