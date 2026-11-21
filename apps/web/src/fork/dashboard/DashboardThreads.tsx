// Fork-only: the Dashboard's list of threads that work or wait on an answer, on every machine.
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { Link } from "@tanstack/react-router";
import { T, useMessages, Var } from "gt-react";

import { cn } from "../../lib/utils";
import { useVisibleThreadShells } from "../../state/entities";
import { useEnvironmentIdentities } from "../../state/environments";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { activeThreads } from "./dashboard.logic";

/** `compact` is the Dashboard column beside a chat, which leaves out the machine column. */
export function DashboardThreads({
  nowMs,
  compact = false,
}: {
  readonly nowMs: number;
  readonly compact?: boolean;
}) {
  const threads = useVisibleThreadShells();
  const environments = useEnvironmentIdentities();
  const labels = new Map(
    environments.map((environment) => [environment.environmentId, environment.label]),
  );
  const m = useMessages();
  const list = activeThreads(threads, nowMs, m);
  const waiting = list.filter((entry) => entry.state === "waiting").length;

  if (list.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        <T>Nothing is working or waiting on you.</T>
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="font-mono text-2xs text-muted-foreground">
        <T>
          <Var>{waiting}</Var> waiting · <Var>{list.length - waiting}</Var> working
        </T>
      </p>
      <ul className="flex flex-col overflow-hidden rounded-lg border bg-card">
        {list.map(({ thread, state, label }) => (
          <li key={`${thread.environmentId}:${thread.id}`} className="border-t first:border-t-0">
            <Link
              to="/$environmentId/$threadId"
              params={buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id))}
              className={cn(
                "flex min-w-0 items-center gap-3 py-2 text-sm hover:bg-accent",
                compact ? "px-3" : "px-4",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  state === "waiting" ? "bg-warning" : "bg-success",
                )}
              />
              <span className="min-w-0 flex-1 truncate">{thread.title}</span>
              <span
                className={cn(
                  "shrink-0 text-xs",
                  state === "waiting" ? "text-warning-foreground" : "text-muted-foreground",
                )}
              >
                {label}
              </span>
              {compact ? null : (
                <span className="hidden w-28 shrink-0 truncate text-end font-mono text-2xs text-muted-foreground sm:block">
                  {labels.get(thread.environmentId) ?? ""}
                </span>
              )}
              <span className="w-16 shrink-0 text-end font-mono text-2xs text-muted-foreground tabular-nums">
                {formatRelativeTimeLabel(thread.updatedAt, nowMs, m)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
