import { describe, expect, it } from "vite-plus/test";

import { isWorkCompletedThread, splitInboxByAttention, splitPinnedByAttention } from "./forkInbox";

type Input = Parameters<typeof isWorkCompletedThread>[0];

function thread(overrides: Partial<Input> = {}, runStatus: string | null = "completed"): Input {
  return {
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    pendingGuestMessageCount: 0,
    interactionMode: "default",
    latestRun:
      runStatus === null
        ? null
        : ({
            runId: "run-1",
            status: runStatus,
            requestedAt: null,
            startedAt: null,
            completedAt: "2026-01-01T00:00:00.000Z",
            assistantMessageId: null,
          } as Input["latestRun"]),
    runtime: null,
    ...overrides,
  };
}

describe("isWorkCompletedThread", () => {
  it.each([
    ["a completed run", thread(), true],
    ["a thread that never ran", thread({}, null), false],
    ["an interrupted run", thread({}, "interrupted"), false],
    ["a failed run", thread({}, "failed"), false],
    ["a pending approval", thread({ hasPendingApprovals: true }), false],
    ["a pending question", thread({ hasPendingUserInput: true }), false],
    ["a subagent request", thread({ pendingSubagentRequest: "approval" }), false],
    ["a guest message", thread({ pendingGuestMessageCount: 1 }), false],
    [
      "a plan to approve",
      thread({ interactionMode: "plan", hasActionableProposedPlan: true }),
      false,
    ],
  ])("%s", (_name, input, expected) => {
    expect(isWorkCompletedThread(input)).toBe(expected);
  });
});

describe("splitInboxByAttention", () => {
  it("keeps input order within each list", () => {
    const a = thread({ hasPendingUserInput: true });
    const b = thread();
    const c = thread({}, null);
    const d = thread();
    expect(splitInboxByAttention([a, b, c, d])).toEqual({ needsInput: [a, c], completed: [b, d] });
  });
});

describe("splitPinnedByAttention", () => {
  it("keeps only pinned threads that wait on the user at the top", () => {
    const asks = thread({ hasPendingUserInput: true });
    const done = thread();
    const running = thread({}, "running");
    const fresh = thread({}, null);
    expect(
      splitPinnedByAttention([asks, done, running, fresh], (item) => item === running),
    ).toEqual({ needsInput: [asks, fresh], rest: [done, running] });
  });
});
