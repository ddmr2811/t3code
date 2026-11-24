import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { hasUnseenRunFailure } from "@t3tools/client-runtime/state/thread-settled";
import { getThreadSortTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import { type EnvironmentId, isListedThreadLineage, type ProjectId } from "@t3tools/contracts";

// Shared with apps/web's fork: the same rule decides who "needs you" on both surfaces.
import { threadNeedsYou } from "../../../web/src/fork/decisions/decisions.logic.ts";

export type ThreadState = "needs-you" | "working" | "error" | "done";

type StateInput = Parameters<typeof threadNeedsYou>[0] &
  Pick<EnvironmentThreadShell, "pendingSubagentRequest" | "lastVisitedAt">;

export function threadState(thread: StateInput): ThreadState {
  // A parent shows its subagent's request: the child itself has no row of its own.
  if (threadNeedsYou(thread) || thread.pendingSubagentRequest != null) return "needs-you";
  const runtime = thread.runtime?.status;
  if (
    runtime === "preparing" ||
    runtime === "queued" ||
    runtime === "starting" ||
    runtime === "running" ||
    runtime === "waiting"
  )
    return "working";
  // As in T3's sidebar, a failed run the user already opened settles; a failure with no failed
  // run has nothing to date it, so it stays.
  if (
    runtime === "failed" &&
    (thread.latestRun?.status !== "failed" || hasUnseenRunFailure(thread))
  )
    return "error";
  return "done";
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

export interface RailProject<T> {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly hasPendingDecision: boolean;
  readonly primaryThread: T;
  readonly threads: ReadonlyArray<T>;
}

/**
 * Projects for the collapsed rail, in recency order, flagging any with an operable pending
 * decision. `waitingProjectKeys` adds the projects whose only waiting thread is not listed, such
 * as a subagent's: the same list the decisions panel counts.
 */
export function railProjects<T extends GroupInput & StateInput>(
  threads: ReadonlyArray<T>,
  machineIds: ReadonlyArray<EnvironmentId>,
  operableIds: ReadonlySet<EnvironmentId>,
  waitingProjectKeys: ReadonlySet<string>,
): RailProject<T>[] {
  return groupThreads(threads, machineIds).flatMap((machine) => {
    const canAnswer = operableIds.has(machine.environmentId);
    return machine.projects.map((project) => {
      const pending = canAnswer
        ? project.threads.find((thread) => threadState(thread) === "needs-you")
        : undefined;
      const key = `${machine.environmentId}:${project.projectId}`;
      return {
        key,
        environmentId: machine.environmentId,
        projectId: project.projectId,
        hasPendingDecision: pending !== undefined || waitingProjectKeys.has(key),
        primaryThread: pending ?? project.threads[0]!,
        threads: project.threads,
      };
    });
  });
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
