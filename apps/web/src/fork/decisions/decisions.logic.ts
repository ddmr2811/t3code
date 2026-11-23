import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

type NeedsYouInput = Pick<
  EnvironmentThreadShell,
  | "archivedAt"
  | "deletedAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingGuestMessageCount"
  | "interactionMode"
  | "hasActionableProposedPlan"
  | "latestRun"
  | "runtime"
>;

// `isLatestRunSettled` from session-logic, repeated: apps/ade imports this file, and that one
// would bring the web's i18n with it.
function isLatestRunSettled(
  latestRun: NeedsYouInput["latestRun"],
  runtime: NeedsYouInput["runtime"],
): boolean {
  if (latestRun === null) return false;
  if (
    latestRun.status === "preparing" ||
    latestRun.status === "queued" ||
    latestRun.status === "starting" ||
    latestRun.status === "running" ||
    latestRun.status === "waiting"
  )
    return false;
  return runtime?.activeRunId !== latestRun.runId;
}

/**
 * Whether the thread itself waits on the user. A parent flagged only by its subagent's
 * request (`pendingSubagentRequest`) is left out: that child is counted on its own.
 */
export function threadNeedsYou(thread: NeedsYouInput): boolean {
  if (thread.archivedAt !== null || thread.deletedAt !== null) return false;
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return true;
  if ((thread.pendingGuestMessageCount ?? 0) > 0) return true;
  return (
    thread.interactionMode === "plan" &&
    thread.hasActionableProposedPlan &&
    isLatestRunSettled(thread.latestRun, thread.runtime)
  );
}

/** The threads that wait on the user, in input order. */
export function selectNeedsYouThreads<T extends NeedsYouInput>(threads: ReadonlyArray<T>): T[] {
  return threads.filter(threadNeedsYou);
}

export interface DecisionsPanelChoice {
  readonly open: boolean;
  /** The waiting threads the user saw when choosing. */
  readonly seenKeys: ReadonlyArray<string>;
}

/**
 * Open while something waits, unless the user chose otherwise; a thread that starts
 * waiting after that choice opens the panel again. Never open with nothing waiting.
 */
export function isDecisionsPanelOpen(
  choice: DecisionsPanelChoice | null,
  waitingKeys: ReadonlyArray<string>,
): boolean {
  if (waitingKeys.length === 0) return false;
  if (choice !== null && waitingKeys.every((key) => choice.seenKeys.includes(key))) {
    return choice.open;
  }
  return true;
}
