import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadRunSummary } from "./models.ts";
import { hasUnseenCompletion, resolveThreadStatusKind } from "./threadStatus.ts";

function makeLatestRun(): ThreadRunSummary {
  return {
    runId: "turn-1" as never,
    status: "completed",
    assistantMessageId: null,
    requestedAt: "2026-03-09T10:00:00.000Z",
    startedAt: "2026-03-09T10:00:00.000Z",
    completedAt: "2026-03-09T10:05:00.000Z",
  };
}

describe("resolveThreadStatusKind", () => {
  const baseThread = {
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "plan" as const,
    latestRun: null,
    lastVisitedAt: undefined,
    runtime: {
      status: "running" as const,
      providerName: "Codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      activeRunId: "turn-1" as never,
      lastError: null,
      updatedAt: "2026-03-09T10:00:00.000Z",
    },
  };

  it("shows an active thread wait as waiting and resumes working when it ends", () => {
    const blocked = { ...baseThread, blockedOnThreadWait: true };
    expect(resolveThreadStatusKind(blocked)).toBe("waiting");
    expect(resolveThreadStatusKind({ ...blocked, blockedOnThreadWait: false })).toBe("working");
  });

  it("shows waiting for an idle thread with pending background tasks", () => {
    expect(
      resolveThreadStatusKind({
        ...baseThread,
        pendingBackgroundTasks: [
          { taskId: "bg-1", description: "Watch build", kind: "monitor", awaited: true },
        ],
        runtime: { ...baseThread.runtime, status: "idle", activeRunId: null },
      }),
    ).toBe("waiting");
  });

  it("shows plan ready when a settled plan turn has a proposed plan ready for follow-up", () => {
    expect(
      resolveThreadStatusKind({
        ...baseThread,
        hasActionableProposedPlan: true,
        latestRun: makeLatestRun(),
        runtime: { ...baseThread.runtime, status: "completed", activeRunId: null },
      }),
    ).toBe("plan");
  });

  it("does not manufacture completed state without a client visit marker", () => {
    expect(
      resolveThreadStatusKind({
        ...baseThread,
        latestRun: makeLatestRun(),
        runtime: { ...baseThread.runtime, status: "completed", activeRunId: null },
      }),
    ).toBeNull();
  });

  it("shows completed when there is an unseen completion and no active blocker", () => {
    expect(
      resolveThreadStatusKind({
        ...baseThread,
        interactionMode: "default",
        latestRun: makeLatestRun(),
        lastVisitedAt: "2026-03-09T10:04:00.000Z",
        runtime: { ...baseThread.runtime, status: "completed", activeRunId: null },
      }),
    ).toBe("completed");
  });

  it("does not show a stopped run as an unseen completion", () => {
    for (const status of ["interrupted", "cancelled"] as const) {
      const stopped = {
        ...baseThread,
        interactionMode: "default" as const,
        runtime: { ...baseThread.runtime, status, activeRunId: null },
        latestRun: { ...makeLatestRun(), status },
        lastVisitedAt: "2026-03-09T10:01:00.000Z",
      };
      expect(hasUnseenCompletion(stopped)).toBe(false);
      expect(resolveThreadStatusKind(stopped)).toBeNull();
    }
  });

  it("shows failed, not completed, when the unseen run failed", () => {
    const failed = {
      ...baseThread,
      interactionMode: "default" as const,
      latestRun: { ...makeLatestRun(), status: "failed" as const },
      lastVisitedAt: "2026-03-09T10:04:00.000Z",
      runtime: {
        ...baseThread.runtime,
        status: "failed" as const,
        activeRunId: null,
        lastError: "Provider turn failed.",
      },
    };
    expect(resolveThreadStatusKind(failed)).toBe("failed");
    // The failure sends the thread to the inbox, so its mark must not say it is still waiting.
    const watching = {
      ...failed,
      pendingBackgroundTasks: [
        {
          taskId: "pr-watch",
          description: "Watching pull request #7",
          kind: "monitor" as const,
          awaited: true as const,
        },
      ],
    };
    expect(resolveThreadStatusKind(watching)).toBe("failed");
    // A run blocked on another thread is still waiting, as its sidebar row says.
    const blocked = {
      ...watching,
      runtime: { ...failed.runtime, status: "running" as const },
      blockedOnThreadWait: true,
    };
    expect(resolveThreadStatusKind(blocked)).toBe("waiting");
  });

  it("shows failed, not plan ready, when a plan run proposed a plan and then failed", () => {
    expect(
      resolveThreadStatusKind({
        ...baseThread,
        hasActionableProposedPlan: true,
        latestRun: { ...makeLatestRun(), status: "failed" },
        lastVisitedAt: "2026-03-09T10:04:00.000Z",
        runtime: { ...baseThread.runtime, status: "failed", activeRunId: null },
      }),
    ).toBe("failed");
  });

  it("drops the failed mark once the failure has been seen", () => {
    expect(
      resolveThreadStatusKind({
        ...baseThread,
        interactionMode: "default",
        latestRun: { ...makeLatestRun(), status: "failed" },
        lastVisitedAt: "2026-03-09T10:06:00.000Z",
        runtime: { ...baseThread.runtime, status: "failed", activeRunId: null },
      }),
    ).toBeNull();
  });
});
