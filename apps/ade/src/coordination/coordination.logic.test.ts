import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  type ForkCoordinationEntry,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProjectBoardGroups,
  projectKeyFromName,
  validateCoordinationDraft,
} from "./coordination.logic.ts";

const envA = EnvironmentId.make("env-a");
const envB = EnvironmentId.make("env-b");

const makeThread = (
  id: string,
  environmentId: EnvironmentId,
  projectId: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell =>
  ({
    environmentId,
    id: ThreadId.make(id),
    projectId: ProjectId.make(projectId),
    title: `Hilo ${id}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { provider: "codex", model: "gpt-5.4" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: "dev",
    worktreePath: "/tmp/wt",
    lineage: { kind: "top-level" },
    forkedFrom: null,
    linkOrigin: null,
    delegatedFrom: null,
    activeProviderThreadId: null,
    latestRun: null,
    runtime: null,
    latestUserMessageAt: "2026-11-23T10:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingGuestMessageCount: 0,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    providerInstanceHistory: [],
    goal: null,
    itemCount: 1,
    visibleItemCount: 1,
    createdAt: "2026-11-23T09:00:00.000Z",
    updatedAt: "2026-11-23T10:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    settledAt: null,
    unsettledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pullRequests: [],
    ...overrides,
  }) as unknown as EnvironmentThreadShell;

describe("coordination.logic", () => {
  it("merges persisted coordination entries with live threads across machines by project", () => {
    const linkedThread = makeThread("t-api", envA, "p-api", {
      hasPendingApprovals: true,
      updatedAt: "2026-11-23T10:15:00.000Z",
    });
    const unannotatedThread = makeThread("t-web", envB, "p-web", {
      runtime: {
        status: "running",
        activeRunId: RunId.make("run-1"),
      } as EnvironmentThreadShell["runtime"],
      updatedAt: "2026-11-23T10:10:00.000Z",
    });
    const entryApi: ForkCoordinationEntry = {
      id: "coord:api",
      projectKey: "api-core",
      projectName: "API Core",
      threadId: ThreadId.make("t-api"),
      agentName: "Codex API",
      status: "waiting",
      workingOn: "Contrato de coordinación",
      completedSummary: "Servicio y tests listos",
      waitingFor: "Revisión de permisos",
      modelLabel: "gpt-5.4",
      updatedAt: "2026-11-23T10:05:00.000Z",
    };

    const groups = buildProjectBoardGroups({
      machineLabels: new Map([
        [envA, "Servidor A"],
        [envB, "Servidor B"],
      ]),
      projectsByEnv: new Map([
        [envA, new Map([["p-api", { id: ProjectId.make("p-api"), title: "API Core" }]])],
        [envB, new Map([["p-web", { id: ProjectId.make("p-web"), title: "Web ADE" }]])],
      ]),
      threads: [linkedThread, unannotatedThread],
      entriesByEnv: new Map([[envA, [entryApi]]]),
      statusFilter: "all",
      query: "",
    });

    expect(groups.map((group) => group.projectKey)).toEqual(["api-core", "web-ade"]);
    expect(groups[0]!.counts).toMatchObject({ total: 1, notes: 1, needsYou: 1, waiting: 1 });
    expect(groups[0]!.items[0]!.threadKey).toContain("t-api");
    expect(groups[0]!.items[0]!.liveState).toBe("needs-you");
    expect(groups[1]!.items[0]!.entry).toBeNull();
    expect(groups[1]!.items[0]!.status).toBe("working");
    expect(groups[1]!.items[0]!.modelLabel).toBe("gpt-5.4");
  });

  it("filters by status and search text and validates drafts strictly", () => {
    expect(projectKeyFromName("T3 Code / Fork .. v2")).toBe("t3-code-fork-v2");

    expect(
      validateCoordinationDraft({
        projectKey: "../bad",
        projectName: "Bad",
        agentName: "Bot",
        status: "working",
        workingOn: "x",
        completedSummary: "",
        waitingFor: "",
      }),
    ).toMatchObject({ ok: false });

    expect(
      validateCoordinationDraft({
        projectKey: "ok",
        projectName: "OK",
        agentName: "Bot",
        status: "working",
        workingOn: "   ",
        completedSummary: "",
        waitingFor: "",
      }),
    ).toMatchObject({ ok: false });

    const valid = validateCoordinationDraft({
      projectKey: "",
      projectName: "ADE Móvil",
      agentName: "  Claude  ",
      status: "blocked",
      workingOn: "  Bandeja móvil  ",
      completedSummary: "Layout listo",
      waitingFor: "Aprobación",
      modelLabel: "  sonnet  ",
    });
    expect(valid).toEqual({
      ok: true,
      input: {
        projectKey: "ade-m-vil",
        projectName: "ADE Móvil",
        agentName: "Claude",
        status: "blocked",
        workingOn: "Bandeja móvil",
        completedSummary: "Layout listo",
        waitingFor: "Aprobación",
        modelLabel: "sonnet",
      },
    });
  });
});
