import {
  EnvironmentId,
  type OrchestrationProjectShell,
  ProjectId,
  RunId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveInitialThreadTitle,
  forYouEntries,
  homeActivity,
  homeChips,
  homeProjects,
} from "./home.logic.ts";

const envA = EnvironmentId.make("env-a");
const envB = EnvironmentId.make("env-b");

const project = (
  id: string,
  title: string,
  overrides: Partial<OrchestrationProjectShell> = {},
): OrchestrationProjectShell => ({
  id: ProjectId.make(id),
  title,
  workspaceRoot: `/repos/${id}`,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  ...overrides,
});

describe("homeProjects", () => {
  it("excludes archived projects, keeps projects without threads, and orders pinned then active", () => {
    const result = homeProjects(
      [
        {
          environmentId: envA,
          label: "dev-a",
          projects: [
            project("archived", "Archivado", { archivedAt: "2026-11-20T00:00:00.000Z" }),
            project("empty", "Sin hilos", { updatedAt: "2026-11-10T00:00:00.000Z" }),
            project("busy", "Con actividad", { updatedAt: "2026-11-05T00:00:00.000Z" }),
          ],
        },
        {
          environmentId: envB,
          label: "dev-b",
          projects: [
            project("pinned", "Fijado", {
              pinnedAt: "2026-11-02T00:00:00.000Z",
              updatedAt: "2026-11-02T00:00:00.000Z",
            }),
          ],
        },
      ],
      [
        {
          environmentId: envA,
          projectId: ProjectId.make("busy"),
          createdAt: "2026-11-01T00:00:00.000Z",
          updatedAt: "2026-11-24T10:00:00.000Z",
          latestUserMessageAt: "2026-11-24T10:00:00.000Z",
          latestUserAuthoredMessageAt: "2026-11-24T10:00:00.000Z",
        },
      ],
    );

    expect(result.map((target) => [target.machineLabel, target.project.id])).toEqual([
      ["dev-b", "pinned"],
      ["dev-a", "busy"],
      ["dev-a", "empty"],
    ]);
  });
});

describe("homeChips", () => {
  const recentFirst = ["a", "b", "c", "d", "e", "f", "g"];

  it.each([
    {
      when: "nothing picked: the five most recent",
      selected: null,
      expected: ["a", "b", "c", "d", "e"],
    },
    { when: "a recent one picked: unchanged", selected: "c", expected: ["a", "b", "c", "d", "e"] },
    {
      when: "an older one picked from «Más…»: it takes the fifth place",
      selected: "g",
      expected: ["a", "b", "c", "d", "g"],
    },
  ])("$when", ({ selected, expected }) => {
    expect(homeChips(recentFirst, selected)).toEqual(expected);
  });
});

describe("deriveInitialThreadTitle", () => {
  it("uses the first non-empty line, collapses whitespace, truncates long lines, and falls back", () => {
    expect(deriveInitialThreadTitle("\n   Arregla   el   inicio  \nsegunda línea")).toBe(
      "Arregla el inicio",
    );
    expect(deriveInitialThreadTitle("   \n  ")).toBe("Nuevo hilo");
    const long = "a".repeat(100);
    const derived = deriveInitialThreadTitle(long);
    expect(derived.length).toBe(80);
    expect(derived.endsWith("…")).toBe(true);
  });
});

describe("forYouEntries", () => {
  it("lists bot notices before waiting threads, as the decisions panel does, without the snoozed", () => {
    const entries = forYouEntries(
      [{ key: "proposal:a" }, { key: "handoff:b" }],
      [{ key: "thread:1" }, { key: "thread:2" }, { key: "thread:3" }],
      ["handoff:b", "thread:2"],
    );
    expect(entries.map((entry) => entry.key)).toEqual(["proposal:a", "thread:1", "thread:3"]);
  });
});

describe("homeActivity", () => {
  type Input = Parameters<typeof homeActivity>[0][number];
  const thread = (
    id: string,
    status: "running" | "completed" | "failed" | "interrupted",
    at: string,
    overrides: Partial<Input> = {},
  ): Input & { id: string } => ({
    id,
    archivedAt: null,
    deletedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingGuestMessageCount: 0,
    interactionMode: "default",
    hasActionableProposedPlan: false,
    pendingSubagentRequest: null,
    lastVisitedAt: at,
    createdAt: at,
    updatedAt: at,
    latestUserMessageAt: at,
    latestUserAuthoredMessageAt: at,
    latestRun: {
      runId: RunId.make(`run-${id}`),
      status,
      requestedAt: at,
      startedAt: at,
      completedAt: status === "running" ? null : at,
      assistantMessageId: null,
    },
    runtime: {
      status: status === "running" ? "running" : "idle",
      activeRunId: status === "running" ? RunId.make(`run-${id}`) : null,
    } as Input["runtime"],
    ...overrides,
  });

  it("keeps a running thread that waits on you out of «En marcha»: it is a decision", () => {
    const { working } = homeActivity([
      thread("busy", "running", "2026-11-26T10:00:00.000Z"),
      thread("asks", "running", "2026-11-26T11:00:00.000Z", { hasPendingApprovals: true }),
    ]);
    expect(working.map((item) => item.id)).toEqual(["busy"]);
  });

  it("lists as finished only runs that completed, latest first", () => {
    const { finished } = homeActivity([
      thread("old", "completed", "2026-11-26T08:00:00.000Z"),
      thread("broke", "failed", "2026-11-26T12:00:00.000Z", {
        settledAt: "2026-11-26T12:01:00.000Z",
      }),
      thread("stopped", "interrupted", "2026-11-26T11:00:00.000Z"),
      thread("new", "completed", "2026-11-26T10:00:00.000Z"),
      thread("busy", "running", "2026-11-26T13:00:00.000Z"),
    ]);
    expect(finished.map((item) => item.id)).toEqual(["new", "old"]);
  });
});
