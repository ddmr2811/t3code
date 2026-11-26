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

export function homeProjectKey(environmentId: EnvironmentId, projectId: ProjectId): string {
  return `${environmentId}:${projectId}`;
}

const HOME_CHIPS = 5;

/** Inicio's chips: the five most recent, with a project picked from «Más…» in the last place. */
export function homeChips<T>(projects: ReadonlyArray<T>, selected: T | null): ReadonlyArray<T> {
  const recent = projects.slice(0, HOME_CHIPS);
  return selected === null || recent.includes(selected)
    ? recent
    : [...recent.slice(0, HOME_CHIPS - 1), selected];
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

const OVERNIGHT_SHOWN_MS = 12 * 60 * 60 * 1000;

/**
 * «Mientras dormías»: shown for 12 h after a coordinator's nightly pass ran, with the board
 * entries closed since the evening before it. Null when no nightly pass ran lately.
 */
export function overnightSummary(input: {
  readonly nightlyRuns: ReadonlyArray<string>;
  readonly entries: ReadonlyArray<{ readonly status: string; readonly updatedAt: string }>;
  readonly now: number;
}): { readonly ranAt: number; readonly closed: number } | null {
  const ranAt = Math.max(
    ...input.nightlyRuns.map(Date.parse).filter((ms) => input.now - ms < OVERNIGHT_SHOWN_MS),
  );
  if (!Number.isFinite(ranAt)) return null;
  const since = ranAt - OVERNIGHT_SHOWN_MS;
  const closed = input.entries.filter(
    (entry) => entry.status === "done" && Date.parse(entry.updatedAt) >= since,
  ).length;
  return { ranAt, closed };
}

export type ForYouEntry<N, T> =
  | { readonly key: string; readonly notice: N }
  | { readonly key: string; readonly item: T };

/**
 * «Para ti»: what the decisions panel waits on, in its order (bot notices, then threads), so
 * the first card is the panel's 1/N. What «Luego» set aside stays in the panel only.
 */
export function forYouEntries<
  N extends { readonly key: string },
  T extends { readonly key: string },
>(
  notices: ReadonlyArray<N>,
  items: ReadonlyArray<T>,
  snoozedKeys: ReadonlyArray<string>,
): ReadonlyArray<ForYouEntry<N, T>> {
  return [
    ...notices.map((notice) => ({ key: notice.key, notice })),
    ...items.map((item) => ({ key: item.key, item })),
  ].filter((entry) => !snoozedKeys.includes(entry.key));
}

const NUMBER_WORDS = [
  "",
  "Una",
  "Dos",
  "Tres",
  "Cuatro",
  "Cinco",
  "Seis",
  "Siete",
  "Ocho",
  "Nueve",
  "Diez",
];

export function forYouSentence(count: number): string {
  if (count === 0) return "Nada pendiente";
  if (count === 1) return "Una cosa espera tu decisión";
  return `${NUMBER_WORDS[count] ?? count} cosas esperan tu decisión`;
}

type ActivityInput = Parameters<typeof threadState>[0] &
  Pick<
    EnvironmentThreadShell,
    "createdAt" | "updatedAt" | "latestUserMessageAt" | "latestUserAuthoredMessageAt"
  >;

const ACTIVITY_WORKING = 5;
const ACTIVITY_FINISHED = 3;

/** Inicio's side column: what works now, most recent first, and the last runs that finished well. */
export function homeActivity<T extends ActivityInput>(
  threads: ReadonlyArray<T>,
): { readonly working: ReadonlyArray<T>; readonly finished: ReadonlyArray<T> } {
  const working = threads
    .filter((thread) => threadState(thread) === "working")
    .toSorted(
      (a, b) => getThreadSortTimestamp(b, "updated_at") - getThreadSortTimestamp(a, "updated_at"),
    );
  const finished = threads
    .filter(
      (thread) =>
        threadState(thread) === "done" &&
        thread.latestRun?.status === "completed" &&
        thread.latestRun.completedAt != null,
    )
    .toSorted(
      (a, b) => Date.parse(b.latestRun!.completedAt!) - Date.parse(a.latestRun!.completedAt!),
    );
  return {
    working: working.slice(0, ACTIVITY_WORKING),
    finished: finished.slice(0, ACTIVITY_FINISHED),
  };
}

/**
 * The newest thing that came to wait on the user after `since` and was not closed: the one
 * «Listo para que lo revises» shows. What already waited when the app opened is no news.
 */
export function reviewEvent<E extends { readonly key: string; readonly at: string | null }>(
  entries: ReadonlyArray<E>,
  since: number,
  dismissed: ReadonlySet<string>,
): E | null {
  let newest: E | null = null;
  for (const entry of entries) {
    const at = entry.at === null ? Number.NaN : Date.parse(entry.at);
    if (!(at > since) || dismissed.has(entry.key)) continue;
    if (newest === null || at > Date.parse(newest.at!)) newest = entry;
  }
  return newest;
}
