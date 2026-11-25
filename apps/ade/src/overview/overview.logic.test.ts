import { RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groupSessions } from "./overview.logic.ts";

type Input = Parameters<typeof groupSessions>[0][number];
const session = (id: string, lastWrittenAt: string, overrides: Partial<Input> = {}): Input => ({
  id: ThreadId.make(id),
  archivedAt: null,
  deletedAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  pendingGuestMessageCount: 0,
  interactionMode: "default",
  hasActionableProposedPlan: false,
  latestRun: null,
  runtime: null,
  pendingSubagentRequest: null,
  lastVisitedAt: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  latestUserMessageAt: lastWrittenAt,
  latestUserAuthoredMessageAt: lastWrittenAt,
  ...overrides,
});

describe("groupSessions", () => {
  // The board shows several machines at once (a-…, b-…): a group is one list, not one per machine.
  it("puts each thread in its state's group, most recent first across machines", () => {
    const running = {
      runtime: { status: "running", activeRunId: RunId.make("run-1") },
    } as Partial<Input>;
    const groups = groupSessions([
      session("a-old", "2026-11-20T10:00:00.000Z", running),
      session("b-asks", "2026-11-21T10:00:00.000Z", { pendingSubagentRequest: "approval" }),
      session("b-new", "2026-11-23T10:00:00.000Z", running),
      session("a-done", "2026-11-22T10:00:00.000Z"),
      session("a-mid", "2026-11-22T10:00:00.000Z", running),
    ]);
    expect(
      Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.map((t) => t.id)])),
    ).toEqual({
      "needs-you": ["b-asks"],
      error: [],
      working: ["b-new", "a-mid", "a-old"],
      done: ["a-done"],
    });
  });
});
