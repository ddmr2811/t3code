import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

import type { EnvironmentThreadShell, ThreadRunSummary, ThreadRuntimeSummary } from "./models.ts";
import { hasUnseenRunFailure } from "./threadSettled.ts";

/** What a thread's status mark says, one per shape: web and ADE draw the same states. */
export type ThreadStatusKind =
  | "approval"
  | "input"
  | "guest"
  | "working"
  | "connecting"
  | "waiting"
  | "failed"
  | "plan"
  | "completed";

export type ThreadStatusInput = Pick<
  EnvironmentThreadShell,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "pendingGuestMessageCount"
  | "interactionMode"
  | "latestRun"
  | "runtime"
> & {
  lastVisitedAt?: string | null | undefined;
  pendingBackgroundTasks?: EnvironmentThreadShell["pendingBackgroundTasks"] | undefined;
  blockedOnThreadWait?: boolean | undefined;
};

export function isLatestRunSettled(
  latestRun: Pick<ThreadRunSummary, "runId" | "startedAt" | "completedAt" | "status"> | null,
  runtime: Pick<ThreadRuntimeSummary, "status" | "activeRunId"> | null,
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

export function hasUnseenCompletion(thread: ThreadStatusInput): boolean {
  if (!thread.latestRun?.completedAt) return false;
  if (thread.latestRun.status === "interrupted" || thread.latestRun.status === "cancelled") {
    return false;
  }
  const completedAt = Date.parse(thread.latestRun.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return false;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

/** The thread's status mark, or null for a settled thread the user has seen. */
export function resolveThreadStatusKind(thread: ThreadStatusInput): ThreadStatusKind | null {
  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") {
    return "approval";
  }
  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input") {
    return "input";
  }
  if ((thread.pendingGuestMessageCount ?? 0) > 0) return "guest";
  if (
    (thread.runtime?.status === "running" && thread.blockedOnThreadWait !== true) ||
    thread.runtime?.status === "waiting"
  ) {
    return "working";
  }
  if (
    thread.runtime?.status === "preparing" ||
    thread.runtime?.status === "starting" ||
    thread.runtime?.status === "queued"
  ) {
    return "connecting";
  }
  if (thread.runtime?.status === "running" && thread.blockedOnThreadWait === true) return "waiting";
  // A failed run goes to the inbox even while background work holds the thread.
  if (hasUnseenRunFailure(thread)) return "failed";
  if (backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [])) return "waiting";
  if (
    !thread.hasPendingUserInput &&
    thread.interactionMode === "plan" &&
    isLatestRunSettled(thread.latestRun, thread.runtime) &&
    thread.hasActionableProposedPlan
  ) {
    return "plan";
  }
  if (hasUnseenCompletion(thread)) return "completed";
  return null;
}
