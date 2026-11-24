import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { getThreadSortTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import type { EnvironmentId, OrchestrationProjectShell, ProjectId } from "@t3tools/contracts";

import { threadState } from "../sidebar/sidebar.logic.ts";

export interface HomeMachineProjects {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
}

export interface HomeProjectTarget {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
  readonly project: OrchestrationProjectShell;
}

type ThreadActivityInput = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "projectId"
  | "createdAt"
  | "updatedAt"
  | "latestUserMessageAt"
  | "latestUserAuthoredMessageAt"
>;

export function greetingForHour(hour: number): string {
  if (hour >= 5 && hour < 12) return "Buenos días.";
  if (hour >= 12 && hour < 20) return "Buenas tardes.";
  return "Buenas noches.";
}

export function homeProjectKey(environmentId: EnvironmentId, projectId: ProjectId): string {
  return `${environmentId}:${projectId}`;
}

/**
 * Active projects across enabled machines, pinned first, then most recently active by thread
 * recency (falling back to the project's own timestamp) and title. Projects with zero threads stay.
 */
export function homeProjects(
  machines: ReadonlyArray<HomeMachineProjects>,
  threads: ReadonlyArray<ThreadActivityInput>,
): HomeProjectTarget[] {
  const latestByProject = new Map<string, number>();
  for (const thread of threads) {
    const key = homeProjectKey(thread.environmentId, thread.projectId);
    const ts = getThreadSortTimestamp(thread, "updated_at");
    const current = latestByProject.get(key);
    if (current === undefined || ts > current) latestByProject.set(key, ts);
  }

  const targets: HomeProjectTarget[] = [];
  for (const machine of machines) {
    for (const project of machine.projects) {
      if (project.archivedAt != null) continue;
      targets.push({
        key: homeProjectKey(machine.environmentId, project.id),
        environmentId: machine.environmentId,
        machineLabel: machine.label,
        project,
      });
    }
  }

  return targets.toSorted((a, b) => {
    const aPinned = a.project.pinnedAt != null;
    const bPinned = b.project.pinnedAt != null;
    if (aPinned !== bPinned) return aPinned ? -1 : 1;
    if (aPinned && bPinned) {
      const pinDiff = Date.parse(b.project.pinnedAt!) - Date.parse(a.project.pinnedAt!);
      if (pinDiff !== 0) return pinDiff;
    }
    const aActivity = latestByProject.get(a.key) ?? Date.parse(a.project.updatedAt);
    const bActivity = latestByProject.get(b.key) ?? Date.parse(b.project.updatedAt);
    if (aActivity !== bActivity) return bActivity - aActivity;
    return (
      a.project.title.localeCompare(b.project.title, "es") ||
      a.machineLabel.localeCompare(b.machineLabel, "es") ||
      a.project.id.localeCompare(b.project.id)
    );
  });
}

export function workingThreadCount(
  threads: ReadonlyArray<Parameters<typeof threadState>[0]>,
): number {
  let count = 0;
  for (const thread of threads) {
    if (threadState(thread) === "working") count += 1;
  }
  return count;
}

const MAX_TITLE_LENGTH = 80;

/** Short title seed from the first non-empty line of the prompt; falls back for image-only sends. */
export function deriveInitialThreadTitle(text: string): string {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .find((line) => line.length > 0);
  if (firstLine === undefined) return "Nuevo hilo";
  if (firstLine.length <= MAX_TITLE_LENGTH) return firstLine;
  return `${firstLine.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
}
