import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { getThreadSortTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import {
  resolveThreadStatusKind,
  type ThreadStatusInput,
} from "@t3tools/client-runtime/state/thread-status";
import { type EnvironmentId, isListedThreadLineage, type ProjectId } from "@t3tools/contracts";

// Shared with apps/web's fork: the same rule decides who "needs you" on both surfaces.
import { threadNeedsYou } from "../../../web/src/fork/decisions/decisions.logic.ts";

export type ThreadState = "needs-you" | "working" | "error" | "done";

type StateInput = ThreadStatusInput &
  Parameters<typeof threadNeedsYou>[0] &
  Partial<Pick<EnvironmentThreadShell, "settledAt">>;

/** The thread's mark in T3's words, bucketed for the ADE's counters and groups. */
export function threadState(thread: StateInput): ThreadState {
  // What the decisions panel counts, and a parent whose subagent asks, read as waiting on you
  // first, even while the thread's own work runs in the background.
  if (threadNeedsYou(thread) || thread.pendingSubagentRequest != null) return "needs-you";
  switch (resolveThreadStatusKind(thread)) {
    case "approval":
    case "input":
    case "guest":
    case "plan":
      return "needs-you";
    // «waiting» is the thread waiting on its own subagent or task: work, not the user.
    case "working":
    case "connecting":
    case "waiting":
      return "working";
    // Settling a failed thread is how the user dismisses it.
    case "failed":
      return thread.settledAt == null ? "error" : "done";
    default:
      return "done";
  }
}

type GroupInput = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "projectId"
  | "lineage"
  | "archivedAt"
  | "deletedAt"
  | "createdAt"
  | "updatedAt"
  | "latestUserMessageAt"
  | "latestUserAuthoredMessageAt"
>;

export interface ProjectGroup<T> {
  readonly projectId: ProjectId;
  readonly threads: ReadonlyArray<T>;
}

export interface MachineGroup<T> {
  readonly environmentId: EnvironmentId;
  readonly projects: ReadonlyArray<ProjectGroup<T>>;
}

/** The threads a sidebar lists: no archived or deleted ones, and no subagents or side chats. */
export function listedThreads<T extends GroupInput>(threads: ReadonlyArray<T>): T[] {
  return threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      thread.deletedAt === null &&
      isListedThreadLineage(thread.lineage),
  );
}

type LineageInput = Pick<EnvironmentThreadShell, "environmentId" | "id" | "lineage">;

export const lineageKey = (thread: { environmentId: string; id: string }) =>
  `${thread.environmentId}\u0000${thread.id}`;

/**
 * Groups waiting threads under the listed row that shows their decision: the thread itself when
 * listed, else its nearest listed ancestor. Parents, not `rootThreadId`: a fork shares its
 * origin's root but has its own row. Threads with no listed ancestor are left out.
 */
export function decisionsByRow<T extends LineageInput>(
  waiting: ReadonlyArray<T>,
  all: ReadonlyArray<T>,
  listed: ReadonlyArray<T>,
): Map<string, T[]> {
  const listedKeys = new Set(listed.map(lineageKey));
  const byKey = new Map(all.map((thread) => [lineageKey(thread), thread]));
  const rows = new Map<string, T[]>();
  for (const thread of waiting) {
    const seen = new Set<string>();
    let current: T | undefined = thread;
    while (current !== undefined && !seen.has(lineageKey(current))) {
      const key = lineageKey(current);
      if (listedKeys.has(key)) {
        rows.set(key, [...(rows.get(key) ?? []), thread]);
        break;
      }
      seen.add(key);
      const parentId: string | null = current.lineage.parentThreadId;
      current =
        parentId === null
          ? undefined
          : byKey.get(lineageKey({ environmentId: current.environmentId, id: parentId }));
    }
  }
  return rows;
}

const SIDEBAR_STORAGE_KEY = "ade.sidebar";

const PROJECT_ACCENTS = ["#ECE6DA", "#8FB4EE", "#96C59A", "#D8D58A", "#E0A3B8", "#86CFCB"] as const;

export function readSidebarExpanded(storage?: Pick<Storage, "getItem">): boolean {
  try {
    const store = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
    return store?.getItem(SIDEBAR_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeSidebarExpanded(expanded: boolean, storage?: Pick<Storage, "setItem">): void {
  try {
    const store = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
    store?.setItem(SIDEBAR_STORAGE_KEY, expanded ? "1" : "0");
  } catch {
    // Storage may be unavailable or full in private browsing; keep the choice in memory.
  }
}

export function projectMonogram(title: string): string {
  const words = title
    .trim()
    .split(/[\s._/-]+/)
    .filter((word) => word.length > 0);
  if (words.length >= 2) {
    const first = [...words[0]!][0] ?? "";
    const second = [...words[1]!][0] ?? "";
    return `${first}${second}`.toUpperCase();
  }
  const single = words[0];
  if (single === undefined) return "?";
  return [...single].slice(0, 2).join("").toUpperCase();
}

export function projectAccentColor(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return PROJECT_ACCENTS[hash % PROJECT_ACCENTS.length]!;
}

/**
 * Threads by machine, in `machineIds` order, then by project. Threads and projects go most recent
 * first. Machines without threads are left out; so are threads of machines not in `machineIds`.
 */
export function groupThreads<T extends GroupInput>(
  threads: ReadonlyArray<T>,
  machineIds: ReadonlyArray<EnvironmentId>,
): MachineGroup<T>[] {
  const recency = (thread: T) => getThreadSortTimestamp(thread, "updated_at");
  const sorted = threads.toSorted((a, b) => recency(b) - recency(a) || a.id.localeCompare(b.id));
  return machineIds.flatMap((environmentId) => {
    const byProject = new Map<ProjectId, T[]>();
    for (const thread of sorted) {
      if (thread.environmentId !== environmentId) continue;
      const group = byProject.get(thread.projectId);
      if (group === undefined) byProject.set(thread.projectId, [thread]);
      else group.push(thread);
    }
    if (byProject.size === 0) return [];
    // Map order is first-seen order, and the first thread seen is each project's most recent.
    const projects = [...byProject].map(([projectId, projectThreads]) => ({
      projectId,
      threads: projectThreads,
    }));
    return [{ environmentId, projects }];
  });
}
