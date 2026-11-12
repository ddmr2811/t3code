// Fork-only: the whole machine's CPU for the Diagnostics panel, in place of the shell's
// "CPU speed limit", which misreads idle cores as a held-back CPU on Windows.
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { formatBytes } from "../../lib/formatBytes";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

const REFRESH_MS = 2_000;
const BUSY_SHARE = 0.85;
const SATURATED_SHARE = 0.95;

/** The server samples this for load balancing, so it covers work outside T3 Code too. */
export function useForkMachineCpu(environmentId: EnvironmentId | null): {
  readonly value: string;
  readonly detail: string | undefined;
  readonly tone: "default" | "warning" | "danger";
} {
  const host = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.hostResources({ environmentId, input: {} }),
  );
  const refresh = host.refresh;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the machine's load while the Diagnostics panel is open
  useEffect(() => {
    if (environmentId === null) return;
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  }, [environmentId, refresh]);

  const resources = host.data;
  if (resources === null) {
    return { value: host.error === null ? "..." : "Unknown", detail: undefined, tone: "default" };
  }
  const share = resources.cpuUtilization;
  const usedMemory = resources.totalMemoryBytes - resources.availableMemoryBytes;
  return {
    value: share === null ? "Unknown" : `${Math.round(share * 100)}%`,
    detail: `${resources.cpuCount} cores · ${formatBytes(usedMemory)} of ${formatBytes(resources.totalMemoryBytes)} memory`,
    tone:
      share === null || share < BUSY_SHARE
        ? "default"
        : share < SATURATED_SHARE
          ? "warning"
          : "danger",
  };
}
