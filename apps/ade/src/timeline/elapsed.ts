import { secondTick, toServerClock } from "@t3tools/client-runtime/clock";
import type { EnvironmentId } from "@t3tools/contracts";

import { formatElapsed } from "./timeline.logic.ts";

/**
 * Ref callback that writes the elapsed time into its node and, while `live`, rewrites it on the
 * shared second tick, so a running clock never re-renders the rows around it. `now` is on the
 * machine's clock, as the start times it is measured from are.
 */
export function tickElapsed(
  environmentId: EnvironmentId,
  elapsedMs: (nowMs: number) => number | null,
  live: boolean,
) {
  return (node: HTMLElement | null) => {
    if (node === null) return;
    const write = () => {
      const ms = elapsedMs(toServerClock(environmentId, secondTick.getSnapshot()));
      const text = ms === null ? "" : formatElapsed(ms);
      if (node.textContent !== text) node.textContent = text;
    };
    write();
    return live ? secondTick.subscribe(write) : undefined;
  };
}
