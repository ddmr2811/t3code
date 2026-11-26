import { EnvironmentId, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  decisionsByRow,
  groupThreads,
  listedThreads,
  projectMonogram,
  lineageKey,
  railProjects,
  readSidebarExpanded,
  threadState,
  writeSidebarExpanded,
} from "./sidebar.logic.ts";

const run = (status: "completed" | "failed" | "running") =>
  ({
    runId: RunId.make("run-1"),
    status,
    requestedAt: "2026-11-23T10:00:00.000Z",
    startedAt: "2026-11-23T10:00:00.000Z",
    completedAt: status === "running" ? null : "2026-11-23T10:05:00.000Z",
    assistantMessageId: null,
  }) as const;

const runtime = (status: "running" | "idle" | "failed") =>
  ({ status, activeRunId: status === "running" ? RunId.make("run-1") : null }) as const;

type StateInput = Parameters<typeof threadState>[0];
const stateInput = (overrides: Partial<StateInput> = {}): StateInput => ({
  archivedAt: null,
  deletedAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  pendingGuestMessageCount: 0,
  interactionMode: "default",
  hasActionableProposedPlan: false,
  latestRun: run("completed"),
  runtime: runtime("idle") as StateInput["runtime"],
  pendingSubagentRequest: null,
  lastVisitedAt: "2026-11-23T09:00:00.000Z",
  ...overrides,
});

describe("threadState", () => {
  it.each([
    ["a pending approval", stateInput({ hasPendingApprovals: true }), "needs-you"],
    // Its subagent's row is hidden, so the parent is where the request shows.
    [
      "a parent whose subagent asks",
      stateInput({ pendingSubagentRequest: "approval" }),
      "needs-you",
    ],
    [
      "a running turn",
      stateInput({
        latestRun: run("running"),
        runtime: runtime("running") as StateInput["runtime"],
      }),
      "working",
    ],
    // Its turn ended, but it waits on the subagent it started: the row says it works.
    [
      "a parent waiting on its subagent",
      stateInput({
        pendingBackgroundTasks: [{ taskId: "task-1", kind: "subagent", description: "Revisar" }],
      }),
      "working",
    ],
    // As the decisions panel counts it, though its background work also holds the thread.
    [
      "a ready plan with background work",
      stateInput({
        interactionMode: "plan",
        hasActionableProposedPlan: true,
        pendingBackgroundTasks: [{ taskId: "task-1", kind: "subagent", description: "Revisar" }],
      }),
      "needs-you",
    ],
    [
      "a failure not yet opened",
      stateInput({ latestRun: run("failed"), runtime: runtime("failed") as StateInput["runtime"] }),
      "error",
    ],
    [
      "a failure the user already opened",
      stateInput({
        latestRun: run("failed"),
        runtime: runtime("failed") as StateInput["runtime"],
        lastVisitedAt: "2026-11-23T11:00:00.000Z",
      }),
      "done",
    ],
    [
      "a failure the user settled without opening",
      stateInput({
        latestRun: run("failed"),
        runtime: runtime("failed") as StateInput["runtime"],
        settledAt: "2026-11-23T11:00:00.000Z",
      }),
      "done",
    ],
    ["a finished turn", stateInput(), "done"],
  ])("%s → %s", (_name, input, expected) => {
    expect(threadState(input)).toBe(expected);
  });
});

const machineA = EnvironmentId.make("machine-a");
const machineB = EnvironmentId.make("machine-b");
const thread = (
  id: string,
  environmentId: EnvironmentId,
  projectId: string,
  lastWrittenAt: string,
  overrides: Partial<Parameters<typeof listedThreads>[0][number]> = {},
) => ({
  id: ThreadId.make(id),
  environmentId,
  projectId: ProjectId.make(projectId),
  lineage: { relationshipToParent: null, sideChat: false } as never,
  archivedAt: null,
  deletedAt: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  latestUserMessageAt: lastWrittenAt,
  latestUserAuthoredMessageAt: lastWrittenAt,
  ...overrides,
});

describe("listedThreads", () => {
  it("leaves out archived, deleted, subagent and side-chat threads", () => {
    const kept = thread("kept", machineA, "p", "2026-11-23T10:00:00.000Z");
    const threads = [
      kept,
      thread("archived", machineA, "p", "2026-11-23T10:00:00.000Z", {
        archivedAt: "2026-11-23T11:00:00.000Z",
      }),
      thread("deleted", machineA, "p", "2026-11-23T10:00:00.000Z", {
        deletedAt: "2026-11-23T11:00:00.000Z",
      }),
      thread("subagent", machineA, "p", "2026-11-23T10:00:00.000Z", {
        lineage: { relationshipToParent: "subagent", sideChat: false } as never,
      }),
      thread("side-chat", machineA, "p", "2026-11-23T10:00:00.000Z", {
        lineage: { relationshipToParent: null, sideChat: true } as never,
      }),
    ];
    expect(listedThreads(threads)).toEqual([kept]);
  });
});

describe("decisionsByRow", () => {
  it("puts a fork's decision on the fork's own row and its subagent's under the fork", () => {
    const at = "2026-11-23T10:00:00.000Z";
    const lineage = (parentThreadId: string | null, relationshipToParent: string | null) =>
      ({ rootThreadId: "origin", parentThreadId, relationshipToParent, sideChat: false }) as never;
    const origin = thread("origin", machineA, "p", at, { lineage: lineage(null, null) });
    const fork = thread("fork", machineA, "p", at, { lineage: lineage("origin", "fork") });
    const child = thread("child", machineA, "p", at, { lineage: lineage("fork", "subagent") });
    const rows = decisionsByRow([fork, child], [origin, fork, child], [origin, fork]);
    expect([...rows.entries()].map(([key, waiting]) => [key, waiting.map((t) => t.id)])).toEqual([
      [`${machineA}\u0000fork`, ["fork", "child"]],
    ]);
  });
});

describe("groupThreads", () => {
  it("groups by machine in the given order, then by project, most recent first", () => {
    const groups = groupThreads(
      [
        thread("a-old", machineA, "web", "2026-11-20T10:00:00.000Z"),
        thread("b-only", machineB, "api", "2026-11-23T12:00:00.000Z"),
        thread("a-new", machineA, "docs", "2026-11-23T10:00:00.000Z"),
        thread("a-mid", machineA, "web", "2026-11-22T10:00:00.000Z"),
        thread("gone", EnvironmentId.make("removed"), "x", "2026-11-23T13:00:00.000Z"),
      ],
      [machineA, machineB],
    );
    expect(
      groups.map((machine) => [
        machine.environmentId,
        machine.projects.map((project) => [
          project.projectId,
          project.threads.map((entry) => entry.id),
        ]),
      ]),
    ).toEqual([
      [
        machineA,
        [
          ["docs", ["a-new"]],
          ["web", ["a-mid", "a-old"]],
        ],
      ],
      [machineB, [["api", ["b-only"]]]],
    ]);
  });
});

describe("sidebar persistence", () => {
  it("round-trips expanded and collapsed states through storage", () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
    };
    expect(readSidebarExpanded(storage)).toBe(false);
    writeSidebarExpanded(true, storage);
    expect(readSidebarExpanded(storage)).toBe(true);
    writeSidebarExpanded(false, storage);
    expect(readSidebarExpanded(storage)).toBe(false);
  });
});

describe("railProjects", () => {
  it("flags pending decisions only on operable machines and targets the waiting thread", () => {
    const waiting = {
      ...stateInput({ hasPendingApprovals: true }),
      ...thread("a-wait", machineA, "web", "2026-11-22T10:00:00.000Z"),
    };
    const newer = {
      ...stateInput(),
      ...thread("a-new", machineA, "web", "2026-11-23T12:00:00.000Z"),
    };
    const readOnlyWaiting = {
      ...stateInput({ hasPendingApprovals: true }),
      ...thread("b-wait", machineB, "api", "2026-11-23T12:00:00.000Z"),
    };
    // Its only waiting thread is a subagent, which is not listed.
    const subagentParent = {
      ...stateInput(),
      ...thread("a-docs", machineA, "docs", "2026-11-21T09:00:00.000Z"),
    };
    const docsNewer = {
      ...stateInput(),
      ...thread("a-docs-new", machineA, "docs", "2026-11-23T09:00:00.000Z"),
    };
    const projects = railProjects(
      [newer, waiting, readOnlyWaiting, subagentParent, docsNewer],
      [machineA, machineB],
      new Set([machineA]),
      new Set([lineageKey(waiting), lineageKey(readOnlyWaiting), lineageKey(subagentParent)]),
    );
    expect(
      projects.map((project) => ({
        projectId: project.projectId,
        hasPendingDecision: project.hasPendingDecision,
        primaryId: project.primaryThread.id,
      })),
    ).toEqual([
      { projectId: "web", hasPendingDecision: true, primaryId: "a-wait" },
      { projectId: "docs", hasPendingDecision: true, primaryId: "a-docs" },
      { projectId: "api", hasPendingDecision: false, primaryId: "b-wait" },
    ]);
  });
});

describe("projectMonogram", () => {
  it("keeps surrogate-pair emoji intact", () => {
    expect(projectMonogram("🚀 Proyecto")).toBe("🚀P");
  });
});
