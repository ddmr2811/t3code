// Fork-only: the Dashboard's polling, which stops while its tab is hidden.
import { useEffect, useEffectEvent } from "react";

interface VisibilitySource {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/**
 * Calls `tick` every `intervalMs` while the page is visible. Hiding it stops the timer; showing it
 * again ticks at once when a tick is overdue, then resumes. The first tick waits a full interval,
 * since a view reads its data when it mounts.
 */
export function startVisibleInterval(
  tick: () => void,
  intervalMs: number,
  source: VisibilitySource = document,
): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastTickAt = Date.now();
  const run = () => {
    lastTickAt = Date.now();
    tick();
  };
  const sync = () => {
    clearInterval(timer);
    timer = undefined;
    if (source.visibilityState !== "visible") return;
    if (Date.now() - lastTickAt >= intervalMs) run();
    timer = setInterval(run, intervalMs);
  };
  source.addEventListener("visibilitychange", sync);
  sync();
  return () => {
    clearInterval(timer);
    source.removeEventListener("visibilitychange", sync);
  };
}

export function useVisibleInterval(tick: () => void, intervalMs: number): void {
  const onTick = useEffectEvent(tick);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls while the Dashboard's tab is visible, tied to visibilitychange
  useEffect(() => startVisibleInterval(() => onTick(), intervalMs), [intervalMs]);
}
