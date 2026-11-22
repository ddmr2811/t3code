import { EnvironmentId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isDecisionsPanelOpen, selectNeedsYouThreads } from "./decisions.logic";

const HERE = EnvironmentId.make("env-here");
const OTHER = EnvironmentId.make("env-other");

const settledRun = {
  runId: RunId.make("run-1"),
  status: "completed",
  requestedAt: "2026-11-22T10:00:00.000Z",
  startedAt: "2026-11-22T10:00:00.000Z",
  completedAt: "2026-11-22T10:05:00.000Z",
  assistantMessageId: null,
} as const;

type Input = Parameters<typeof selectNeedsYouThreads>[0][number];
const thread = (overrides: Partial<Input> = {}): Input => ({
  environmentId: HERE,
  archivedAt: null,
  deletedAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  pendingGuestMessageCount: 0,
  interactionMode: "default",
  hasActionableProposedPlan: false,
  latestRun: settledRun,
  runtime: null,
  ...overrides,
});

describe("selectNeedsYouThreads", () => {
  it.each([
    ["a pending approval", thread({ hasPendingApprovals: true }), true],
    ["a pending question", thread({ hasPendingUserInput: true }), true],
    ["a guest message", thread({ pendingGuestMessageCount: 2 }), true],
    [
      "a settled plan turn with a plan to act on",
      thread({ interactionMode: "plan", hasActionableProposedPlan: true }),
      true,
    ],
    [
      "a plan turn still running",
      thread({
        interactionMode: "plan",
        hasActionableProposedPlan: true,
        latestRun: { ...settledRun, status: "running", completedAt: null },
      }),
      false,
    ],
    // The child that asked is counted itself; counting its parent too would show 2 for 1.
    [
      "a parent flagged only by its subagent",
      { ...thread(), pendingSubagentRequest: "approval" },
      false,
    ],
    [
      "an archived thread with a pending approval",
      thread({ hasPendingApprovals: true, archivedAt: "2026-11-22T11:00:00.000Z" }),
      false,
    ],
    ["a finished thread", thread(), false],
  ])("%s → %s", (_name, input, expected) => {
    expect(selectNeedsYouThreads([input], HERE).length === 1).toBe(expected);
  });

  it("counts only the chosen environment", () => {
    const here = thread({ hasPendingApprovals: true });
    const elsewhere = thread({ environmentId: OTHER, hasPendingApprovals: true });
    expect(selectNeedsYouThreads([here, elsewhere], HERE)).toEqual([here]);
  });
});

describe("isDecisionsPanelOpen", () => {
  it("opens while something waits and stays closed otherwise", () => {
    expect(isDecisionsPanelOpen(null, ["a"])).toBe(true);
    expect(isDecisionsPanelOpen(null, [])).toBe(false);
  });

  it("keeps the user's choice until a new thread starts waiting", () => {
    const closed = { open: false, seenKeys: ["a", "b"] };
    expect(isDecisionsPanelOpen(closed, ["a", "b"])).toBe(false);
    expect(isDecisionsPanelOpen(closed, ["b"])).toBe(false);
    expect(isDecisionsPanelOpen(closed, [])).toBe(false);
    expect(isDecisionsPanelOpen(closed, ["b", "c"])).toBe(true);
  });

  it("stays open when the user opens it with nothing waiting", () => {
    expect(isDecisionsPanelOpen({ open: true, seenKeys: [] }, [])).toBe(true);
  });
});
