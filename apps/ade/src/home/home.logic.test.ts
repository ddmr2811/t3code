import { EnvironmentId, type OrchestrationProjectShell, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveInitialThreadTitle, homeProjects } from "./home.logic.ts";

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
