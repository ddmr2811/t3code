// Fork-only: lists a thread's subagents under its sidebar row, so their state
// shows without opening the parent. Kept in its own file so upstream merges
// touch as little as possible.
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import {
  isSidebarHiddenThread,
  resolveSidebarThreadStatus,
  type SidebarThreadStatus,
} from "../Sidebar.logic";

const MAX_LISTED_CHILDREN = 8;

const STATUS_LABEL: Record<SidebarThreadStatus, string> = {
  approval: "Approval",
  input: "Input",
  request: "Request",
  preparing: "Starting",
  working: "Working",
  waiting: "Waiting",
  failed: "Failed",
  limited: "Limited",
  ready: "Done",
};

const STATUS_DOT: Record<SidebarThreadStatus, string> = {
  approval: "bg-amber-500",
  input: "bg-indigo-500",
  request: "bg-indigo-500",
  preparing: "bg-sky-500",
  working: "bg-sky-500",
  waiting: "bg-sidebar-muted-foreground/60",
  failed: "bg-red-500",
  limited: "bg-amber-500",
  ready: "bg-emerald-500/70",
};

const isLive = (status: SidebarThreadStatus) => status !== "ready";

/**
 * Subagent threads by the key of the sidebar row that stands for them: their
 * nearest listed ancestor in the same environment. Side chats are left out.
 */
export function buildForkChildrenByRowKey(
  threads: readonly EnvironmentThreadShell[],
): ReadonlyMap<string, readonly EnvironmentThreadShell[]> {
  const byKey = new Map<string, EnvironmentThreadShell>();
  for (const thread of threads) byKey.set(`${thread.environmentId}:${thread.id}`, thread);
  const children = new Map<string, EnvironmentThreadShell[]>();
  for (const thread of threads) {
    if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
    if (thread.lineage.relationshipToParent !== "subagent") continue;
    const seen = new Set<ThreadId>([thread.id]);
    let parentId = thread.lineage.parentThreadId;
    let row: EnvironmentThreadShell | undefined;
    while (parentId !== null && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = byKey.get(`${thread.environmentId}:${parentId}`);
      if (parent === undefined) break;
      if (!isSidebarHiddenThread(parent)) {
        row = parent;
        break;
      }
      parentId = parent.lineage.parentThreadId;
    }
    if (row === undefined) continue;
    const rowKey = scopedThreadKey(scopeThreadRef(row.environmentId, row.id));
    const list = children.get(rowKey);
    if (list) list.push(thread);
    else children.set(rowKey, [thread]);
  }
  for (const list of children.values()) {
    list.sort((left, right) => {
      const live =
        Number(isLive(resolveSidebarThreadStatus(right))) -
        Number(isLive(resolveSidebarThreadStatus(left)));
      return live || right.updatedAt.localeCompare(left.updatedAt);
    });
  }
  return children;
}

export function ForkThreadChildren(props: {
  readonly threads: readonly EnvironmentThreadShell[];
  readonly activeThreadKey: string | null;
  readonly onOpen: (threadRef: ScopedThreadRef) => void;
}) {
  const listed = props.threads.slice(0, MAX_LISTED_CHILDREN);
  const hidden = props.threads.length - listed.length;
  return (
    <li className="list-none" data-testid="sidebar-fork-children">
      <ul className="mb-1 ml-4 flex flex-col border-l border-sidebar-foreground/15 pl-1.5">
        {listed.map((thread) => {
          const threadRef = scopeThreadRef(thread.environmentId, thread.id);
          const status = resolveSidebarThreadStatus(thread);
          return (
            <li key={thread.id} className="list-none">
              <button
                type="button"
                onClick={() => props.onOpen(threadRef)}
                className={cn(
                  "flex h-6 w-full cursor-pointer items-center gap-1.5 rounded-sm px-1.5 text-left text-xs text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                  props.activeThreadKey === scopedThreadKey(threadRef) &&
                    "bg-sidebar-row-hover text-sidebar-foreground",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    STATUS_DOT[status],
                    (status === "working" || status === "preparing") && "animate-pulse",
                  )}
                />
                <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                <span className="shrink-0 text-2xs opacity-80">{STATUS_LABEL[status]}</span>
              </button>
            </li>
          );
        })}
        {hidden > 0 ? (
          <li className="list-none px-1.5 text-2xs text-sidebar-muted-foreground/70">
            +{hidden} more
          </li>
        ) : null}
      </ul>
    </li>
  );
}
