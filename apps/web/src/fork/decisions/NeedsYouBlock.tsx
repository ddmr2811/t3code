// Fork-only: the one number that leads the screen. Opens and closes the decisions panel.
import { useGT } from "gt-react";
import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { useDecisionsPanel } from "./decisionsState";

export function NeedsYouBlock() {
  const gt = useGT();
  const { threads, open, setOpen } = useDecisionsPanel();
  const count = threads.length;
  const waiting = count > 0;
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls="fork-decisions-panel"
      aria-label={gt(
        "{count, plural, =0 {Nothing is waiting on you} one {{count} thread needs you} other {{count} threads need you}}",
        { count },
      )}
      onClick={() => setOpen(!open)}
      className={cn(
        "relative isolate flex w-full shrink-0 items-center gap-3 overflow-hidden px-4 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        waiting
          ? "bg-primary py-3 text-primary-foreground hover:bg-primary/90"
          : "py-2 text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      {waiting ? (
        // Static ordered dots in the corner; no motion.
        <span
          aria-hidden
          className="-z-10 absolute inset-y-0 right-0 w-2/3 opacity-25 [background-image:radial-gradient(currentColor_1px,transparent_1.5px)] [background-size:6px_6px] [mask-image:linear-gradient(to_left,black,transparent)]"
        />
      ) : null}
      <span
        aria-hidden
        className={cn(
          "font-black tabular-nums leading-none tracking-tighter",
          waiting ? "text-7xl" : "text-xl",
        )}
      >
        {count}
      </span>
      <span aria-hidden className="flex min-w-0 flex-col gap-1">
        <span className={cn("font-bold leading-tight", waiting ? "text-xl" : "text-sm")}>
          {gt("{count, plural, =1 {needs you} other {need you}}", { count })}
        </span>
        {waiting || open ? (
          // The canvas pair keeps small text readable on any accent; the accent's own foreground may not.
          <span className="inline-flex w-fit items-center gap-1 rounded-sm bg-background px-1.5 py-0.5 font-mono text-2xs text-foreground uppercase tracking-wider">
            {open ? (
              <>
                <ArrowLeftIcon className="size-3" />
                {gt("Close", { $context: "verb, closes the decisions panel" })}
              </>
            ) : (
              <>
                {gt("Answer", { $context: "verb, opens the decisions panel to answer" })}
                <ArrowRightIcon className="size-3" />
              </>
            )}
          </span>
        ) : null}
      </span>
    </button>
  );
}
