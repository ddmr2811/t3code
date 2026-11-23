// Fork-only: the one number that leads the screen. Opens and closes the decisions panel.
import { useGT } from "gt-react";
import { ArrowLeftIcon } from "@phosphor-icons/react/dist/csr/ArrowLeft";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/csr/ArrowRight";

import { DitherFill } from "../dither/DitherFill";
import { useDecisionsPanel } from "./decisionsState";

export function NeedsYouBlock() {
  const gt = useGT();
  const { threads, open, setOpen } = useDecisionsPanel();
  const count = threads.length;
  const label = gt(
    "{count, plural, =0 {Nothing is waiting on you} one {{count} thread needs you} other {{count} threads need you}}",
    { count },
  );
  const words = gt("{count, plural, =1 {needs you} other {need you}}", { count });
  if (count === 0) {
    // Nothing to open, so nothing to press.
    return (
      <div className="flex w-full shrink-0 items-center gap-3 px-4 py-2 text-muted-foreground">
        <span className="sr-only">{label}</span>
        <span aria-hidden className="font-black text-xl tabular-nums leading-none tracking-tighter">
          0
        </span>
        <span aria-hidden className="font-bold text-sm leading-tight">
          {words}
        </span>
      </div>
    );
  }
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls="fork-decisions-panel"
      aria-label={label}
      onClick={() => setOpen(!open)}
      className="relative isolate flex w-full shrink-0 items-center gap-3 overflow-hidden bg-primary px-4 py-3 text-left text-primary-foreground outline-none transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      <span aria-hidden className="font-black text-7xl tabular-nums leading-none tracking-tighter">
        {count}
      </span>
      <span aria-hidden className="flex min-w-0 flex-col gap-1">
        <span className="font-bold text-xl leading-tight">{words}</span>
        {/* The canvas pair keeps small text readable on any accent; the accent's own foreground may not. */}
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
      </span>
      {/* Its own slot after the words, out to the block's edges, so it never sits under a letter. */}
      <span aria-hidden className="relative -my-3 -me-4 min-w-0 flex-1 self-stretch">
        <DitherFill
          color="currentColor"
          edge="right"
          length={16}
          from={0.75}
          to={0}
          className="inset-0 opacity-30"
        />
      </span>
    </button>
  );
}
