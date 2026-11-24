import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  type EnvironmentId,
  FORK_COORDINATION_AGENT_NAME_MAX_LENGTH,
  FORK_COORDINATION_MODEL_LABEL_MAX_LENGTH,
  FORK_COORDINATION_PROJECT_KEY_MAX_LENGTH,
  FORK_COORDINATION_PROJECT_NAME_MAX_LENGTH,
  FORK_COORDINATION_SHORT_TEXT_MAX_LENGTH,
  FORK_COORDINATION_SUMMARY_MAX_LENGTH,
  type ForkCoordinationEntry,
  type ForkCoordinationStatus,
  type ForkCoordinationUpsertInput,
  projectKeyFromName,
  type ThreadId,
} from "@t3tools/contracts";

import { type ThreadState, threadState } from "../sidebar/sidebar.logic.ts";

export type CoordinationStatusFilter = "all" | ForkCoordinationStatus;

export const COORDINATION_STATUSES = [
  "blocked",
  "waiting",
  "working",
  "done",
] as const satisfies ReadonlyArray<ForkCoordinationStatus>;

const STATUS_PRIORITY: Record<ForkCoordinationStatus, number> = {
  blocked: 0,
  waiting: 1,
  working: 2,
  done: 3,
};

const MAX_UNANNOTATED_DONE_PER_PROJECT = 5;

export interface ProjectBoardItem {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
  readonly projectKey: string;
  readonly projectName: string;
  readonly entry: ForkCoordinationEntry | null;
  readonly thread: EnvironmentThreadShell | null;
  readonly threadKey: string | null;
  readonly liveState: ThreadState | null;
  readonly status: ForkCoordinationStatus;
  readonly agentName: string;
  readonly workingOn: string;
  readonly completedSummary: string;
  readonly waitingFor: string;
  readonly modelLabel: string | null;
  readonly updatedAt: string;
}

export interface ProjectBoardGroup {
  readonly projectKey: string;
  readonly projectName: string;
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly counts: {
    readonly total: number;
    readonly notes: number;
    readonly needsYou: number;
    readonly blocked: number;
    readonly waiting: number;
    readonly working: number;
    readonly done: number;
  };
  readonly latestUpdatedAt: string;
  readonly items: ReadonlyArray<ProjectBoardItem>;
}

export interface CoordinationDraft {
  readonly id?: string;
  readonly projectKey: string;
  readonly projectName: string;
  readonly threadId?: ThreadId;
  readonly agentName: string;
  readonly status: ForkCoordinationStatus;
  readonly workingOn: string;
  readonly completedSummary: string;
  readonly waitingFor: string;
  readonly modelLabel?: string;
}

const SINGLE_LINE_CONTROL = /[\u0000-\u001f\u007f]/;
const MULTILINE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const PATH_TRAVERSAL_SEGMENT = /(?:^|[\\/])\.\.(?:$|[\\/])/;

export function threadModelLabel(
  thread: Pick<EnvironmentThreadShell, "modelSelection">,
): string | null {
  const model = thread.modelSelection?.model?.trim();
  if (!model) return null;
  return model.slice(0, FORK_COORDINATION_MODEL_LABEL_MAX_LENGTH);
}

export function coordinationStatusFromThreadState(state: ThreadState): ForkCoordinationStatus {
  switch (state) {
    case "error":
      return "blocked";
    case "needs-you":
      return "waiting";
    case "working":
      return "working";
    case "done":
      return "done";
  }
}

export function validateCoordinationDraft(
  draft: CoordinationDraft,
):
  | { readonly ok: true; readonly input: ForkCoordinationUpsertInput }
  | { readonly ok: false; readonly error: string } {
  const projectName = draft.projectName.trim();
  const projectKey = (draft.projectKey.trim() || projectKeyFromName(projectName)).trim();
  const agentName = draft.agentName.trim();
  const workingOn = draft.workingOn.trim();
  const completedSummary = draft.completedSummary.trim();
  const waitingFor = draft.waitingFor.trim();
  const modelLabel = draft.modelLabel?.trim();

  if (projectName.length === 0) return { ok: false, error: "Indica el nombre del proyecto." };
  if (
    projectName.length > FORK_COORDINATION_PROJECT_NAME_MAX_LENGTH ||
    SINGLE_LINE_CONTROL.test(projectName)
  ) {
    return { ok: false, error: "El nombre del proyecto no es válido o es demasiado largo." };
  }
  if (
    projectKey.length === 0 ||
    projectKey.length > FORK_COORDINATION_PROJECT_KEY_MAX_LENGTH ||
    SINGLE_LINE_CONTROL.test(projectKey) ||
    PATH_TRAVERSAL_SEGMENT.test(projectKey)
  ) {
    return { ok: false, error: "La clave de proyecto contiene caracteres no permitidos." };
  }
  if (agentName.length === 0) return { ok: false, error: "Indica el agente o hilo responsable." };
  if (
    agentName.length > FORK_COORDINATION_AGENT_NAME_MAX_LENGTH ||
    SINGLE_LINE_CONTROL.test(agentName)
  ) {
    return { ok: false, error: "El nombre del agente no es válido o es demasiado largo." };
  }
  if (
    draft.threadId !== undefined &&
    (draft.threadId.length > 128 || SINGLE_LINE_CONTROL.test(draft.threadId))
  ) {
    return { ok: false, error: "El identificador de hilo no es válido." };
  }
  if (
    workingOn.length > FORK_COORDINATION_SHORT_TEXT_MAX_LENGTH ||
    MULTILINE_CONTROL.test(workingOn)
  ) {
    return { ok: false, error: "«En qué está» no es válido o supera el límite de 500 caracteres." };
  }
  if (
    completedSummary.length > FORK_COORDINATION_SUMMARY_MAX_LENGTH ||
    MULTILINE_CONTROL.test(completedSummary)
  ) {
    return {
      ok: false,
      error: "«Qué ha hecho» no es válido o supera el límite de 1000 caracteres.",
    };
  }
  if (
    waitingFor.length > FORK_COORDINATION_SHORT_TEXT_MAX_LENGTH ||
    MULTILINE_CONTROL.test(waitingFor)
  ) {
    return { ok: false, error: "«Qué espera» no es válido o supera el límite de 500 caracteres." };
  }
  if (
    modelLabel !== undefined &&
    (modelLabel.length > FORK_COORDINATION_MODEL_LABEL_MAX_LENGTH ||
      SINGLE_LINE_CONTROL.test(modelLabel))
  ) {
    return { ok: false, error: "El nombre del modelo no es válido o es demasiado largo." };
  }
  if (workingOn === "" && completedSummary === "" && waitingFor === "") {
    return {
      ok: false,
      error: "Escribe al menos un campo: en qué está, qué ha hecho o qué espera.",
    };
  }

  return {
    ok: true,
    input: {
      ...(draft.id === undefined ? {} : { id: draft.id }),
      projectKey,
      projectName,
      ...(draft.threadId === undefined ? {} : { threadId: draft.threadId }),
      agentName,
      status: draft.status,
      workingOn,
      completedSummary,
      waitingFor,
      ...(modelLabel ? { modelLabel } : {}),
    },
  };
}

function compareBoardItems(left: ProjectBoardItem, right: ProjectBoardItem): number {
  const leftNeeds = left.liveState === "needs-you" ? 0 : 1;
  const rightNeeds = right.liveState === "needs-you" ? 0 : 1;
  if (leftNeeds !== rightNeeds) return leftNeeds - rightNeeds;
  const statusDiff = STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status];
  if (statusDiff !== 0) return statusDiff;
  return right.updatedAt.localeCompare(left.updatedAt) || left.key.localeCompare(right.key);
}

export function buildProjectBoardGroups(input: {
  readonly machineLabels: ReadonlyMap<EnvironmentId, string>;
  readonly projectsByEnv: ReadonlyMap<
    EnvironmentId,
    ReadonlyMap<string, Pick<EnvironmentProject, "id" | "title">>
  >;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly entriesByEnv: ReadonlyMap<EnvironmentId, ReadonlyArray<ForkCoordinationEntry>>;
  readonly statusFilter: CoordinationStatusFilter;
  readonly query: string;
}): ReadonlyArray<ProjectBoardGroup> {
  const threadIndex = new Map<string, EnvironmentThreadShell>();
  for (const thread of input.threads) {
    threadIndex.set(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread);
  }

  const annotatedThreadKeys = new Set<string>();
  const allItems: ProjectBoardItem[] = [];

  for (const [environmentId, entries] of input.entriesByEnv) {
    const machineLabel = input.machineLabels.get(environmentId) ?? environmentId;
    for (const entry of entries) {
      const threadKey =
        entry.threadId === undefined
          ? null
          : scopedThreadKey(scopeThreadRef(environmentId, entry.threadId));
      const thread = threadKey === null ? null : (threadIndex.get(threadKey) ?? null);
      if (threadKey !== null && thread !== null) {
        annotatedThreadKeys.add(threadKey);
      }
      const liveState = thread === null ? null : threadState(thread);
      allItems.push({
        key: `note:${environmentId}:${entry.id}`,
        environmentId,
        machineLabel,
        projectKey: entry.projectKey,
        projectName: entry.projectName,
        entry,
        thread,
        threadKey: thread === null ? null : threadKey,
        liveState,
        status: entry.status,
        agentName: entry.agentName,
        workingOn: entry.workingOn,
        completedSummary: entry.completedSummary,
        waitingFor: entry.waitingFor,
        modelLabel: entry.modelLabel ?? (thread === null ? null : threadModelLabel(thread)),
        updatedAt:
          thread !== null && thread.updatedAt > entry.updatedAt
            ? thread.updatedAt
            : entry.updatedAt,
      });
    }
  }

  // Group unannotated live threads by project so every connected project appears in the front layer.
  const unannotatedDonePerProject = new Map<string, number>();
  const sortedThreads = input.threads.toSorted(
    (left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
  );
  for (const thread of sortedThreads) {
    const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    if (annotatedThreadKeys.has(threadKey)) continue;
    const project = input.projectsByEnv.get(thread.environmentId)?.get(thread.projectId);
    const projectName = project?.title?.trim() || "Proyecto sin nombre";
    const projectKey = projectKeyFromName(projectName, thread.projectId);
    const liveState = threadState(thread);
    const status = coordinationStatusFromThreadState(liveState);
    if (status === "done") {
      const seen = unannotatedDonePerProject.get(projectKey) ?? 0;
      if (seen >= MAX_UNANNOTATED_DONE_PER_PROJECT) continue;
      unannotatedDonePerProject.set(projectKey, seen + 1);
    }
    const machineLabel = input.machineLabels.get(thread.environmentId) ?? thread.environmentId;
    allItems.push({
      key: `thread:${threadKey}`,
      environmentId: thread.environmentId,
      machineLabel,
      projectKey,
      projectName,
      entry: null,
      thread,
      threadKey,
      liveState,
      status,
      agentName: thread.title,
      workingOn: "",
      completedSummary: "",
      waitingFor: "",
      modelLabel: threadModelLabel(thread),
      updatedAt: thread.updatedAt,
    });
  }

  const normalizedQuery = input.query.trim().toLowerCase();
  const filteredItems = allItems.filter((item) => {
    if (input.statusFilter !== "all" && item.status !== input.statusFilter) return false;
    if (normalizedQuery === "") return true;
    const haystack = [
      item.projectName,
      item.projectKey,
      item.agentName,
      item.machineLabel,
      item.workingOn,
      item.completedSummary,
      item.waitingFor,
      item.modelLabel ?? "",
      item.thread?.title ?? "",
      item.thread?.branch ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(normalizedQuery);
  });

  const byProject = new Map<
    string,
    {
      projectKey: string;
      projectName: string;
      envSet: Set<EnvironmentId>;
      items: ProjectBoardItem[];
    }
  >();

  for (const item of filteredItems) {
    const existing = byProject.get(item.projectKey);
    if (existing === undefined) {
      byProject.set(item.projectKey, {
        projectKey: item.projectKey,
        projectName: item.projectName,
        envSet: new Set([item.environmentId]),
        items: [item],
      });
    } else {
      existing.envSet.add(item.environmentId);
      existing.items.push(item);
    }
  }

  const groups: ProjectBoardGroup[] = [...byProject.values()].map((group) => {
    const sorted = group.items.toSorted(compareBoardItems);
    const counts = {
      total: sorted.length,
      notes: sorted.filter((item) => item.entry !== null).length,
      needsYou: sorted.filter((item) => item.liveState === "needs-you").length,
      blocked: sorted.filter((item) => item.status === "blocked").length,
      waiting: sorted.filter((item) => item.status === "waiting").length,
      working: sorted.filter((item) => item.status === "working").length,
      done: sorted.filter((item) => item.status === "done").length,
    };
    const latestUpdatedAt = sorted.reduce(
      (latest, item) => (item.updatedAt > latest ? item.updatedAt : latest),
      "",
    );
    return {
      projectKey: group.projectKey,
      projectName: group.projectName,
      environmentIds: [...group.envSet],
      counts,
      latestUpdatedAt,
      items: sorted,
    };
  });

  return groups.toSorted((left, right) => {
    const leftUrgent = left.counts.needsYou + left.counts.blocked > 0 ? 0 : 1;
    const rightUrgent = right.counts.needsYou + right.counts.blocked > 0 ? 0 : 1;
    if (leftUrgent !== rightUrgent) return leftUrgent - rightUrgent;
    const leftActive = left.counts.working + left.counts.waiting > 0 ? 0 : 1;
    const rightActive = right.counts.working + right.counts.waiting > 0 ? 0 : 1;
    if (leftActive !== rightActive) return leftActive - rightActive;
    return (
      right.latestUpdatedAt.localeCompare(left.latestUpdatedAt) ||
      left.projectName.localeCompare(right.projectName)
    );
  });
}
