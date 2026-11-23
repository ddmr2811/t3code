import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { getThreadSortTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";

import { type ThreadState, threadState } from "../sidebar/sidebar.logic.ts";

/** The order both views show the groups in: what needs you first. */
export const SESSION_GROUPS = [
  "needs-you",
  "error",
  "working",
  "done",
] as const satisfies ReadonlyArray<ThreadState>;

type SessionInput = Parameters<typeof threadState>[0] &
  Parameters<typeof getThreadSortTimestamp>[0] &
  Pick<EnvironmentThreadShell, "id">;

/** Threads of every machine by state, each group most recent first, whatever its machine. */
export function groupSessions<T extends SessionInput>(
  threads: ReadonlyArray<T>,
): Record<ThreadState, T[]> {
  const groups: Record<ThreadState, T[]> = { "needs-you": [], error: [], working: [], done: [] };
  const recency = (thread: T) => getThreadSortTimestamp(thread, "updated_at");
  const sorted = threads.toSorted((a, b) => recency(b) - recency(a) || a.id.localeCompare(b.id));
  for (const thread of sorted) groups[threadState(thread)].push(thread);
  return groups;
}

/** Open pull requests linked to these threads, each counted once, by the state of its CI. */
export function openPullRequests(
  threads: ReadonlyArray<Pick<EnvironmentThreadShell, "pullRequests">>,
) {
  const byUrl = new Map<string, "passing" | "failing" | "pending" | null>();
  for (const thread of threads) {
    for (const link of visibleThreadPullRequests(thread.pullRequests)) {
      if (link.snapshot?.state !== "open") continue;
      byUrl.set(link.url, link.snapshot.checksState ?? null);
    }
  }
  const checks = [...byUrl.values()];
  return {
    open: byUrl.size,
    failing: checks.filter((state) => state === "failing").length,
    pending: checks.filter((state) => state === "pending").length,
  };
}
