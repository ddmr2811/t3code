// Fork-only: the thread's big header. Title first, its state as a tag with its glyph,
// and project, machine and branch in small type above.
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useMessages } from "gt-react";

import { resolveThreadStatusPill } from "~/components/Sidebar.logic";
import { cn } from "~/lib/utils";
import { useProject, useThreadShell } from "~/state/entities";
import { useEnvironment } from "~/state/environments";
import { textDirection } from "~/textDirection";
import { DitherFill } from "../dither/DitherFill";
import { ThreadStatusGlyph } from "./ThreadStatusGlyph";

// The header shows what state the thread is in, not whether it is news, so a finished
// or failed run keeps its tag after the thread is opened.
const SHOW_SETTLED_STATES = new Date(0).toISOString();

export function ForkThreadHero({ threadRef }: { threadRef: ScopedThreadRef }) {
  const m = useMessages();
  const thread = useThreadShell(threadRef);
  const project = useProject(
    thread === null ? null : scopeProjectRef(thread.environmentId, thread.projectId),
  );
  const machine = useEnvironment(threadRef.environmentId)?.label ?? null;
  if (thread === null) return null;
  const status = resolveThreadStatusPill({
    thread: { ...thread, lastVisitedAt: SHOW_SETTLED_STATES },
  });
  const context = [project?.isScratch ? null : project?.title, machine, thread.branch].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return (
    <div
      data-fork-thread-hero=""
      className="relative isolate flex shrink-0 items-end justify-between gap-4 overflow-hidden border-b px-3 pt-3 pb-4 sm:px-5"
    >
      {/* Dithered in the state's colour, or the accent when the thread has no state to show. */}
      <DitherFill
        color={status ? "currentColor" : "ink"}
        edge="right"
        matrix="blue-noise"
        length={48}
        from={0.6}
        to={0}
        className={cn("-z-10 inset-y-0 right-0 w-1/2 opacity-35", status?.colorClass)}
      />
      <div className="min-w-0">
        {context.length > 0 ? (
          <p className="truncate font-mono text-2xs text-muted-foreground uppercase tracking-wider">
            {context.join(" · ")}
          </p>
        ) : null}
        <h1
          className="truncate font-bold text-2xl tracking-tight sm:text-4xl"
          dir={textDirection(thread.title)}
        >
          {thread.title}
        </h1>
      </div>
      {status ? (
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-2 rounded-lg border border-current/40 bg-background px-3 py-1.5 font-semibold text-sm sm:text-base",
            status.colorClass,
          )}
        >
          <ThreadStatusGlyph kind={status.kind} pulse={status.pulse} className="size-4.5" />
          {m(status.label)}
        </span>
      ) : null}
    </div>
  );
}
