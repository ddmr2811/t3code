// Fork-only: reads a Prometheus node_exporter's text into the Dashboard's machine load.
import type { HostResourcesSnapshot } from "@t3tools/contracts";
import { isSharedAddressSpaceHost, isTailnetHost } from "@t3tools/shared/hostClassification";

/** Cumulative CPU seconds over every core; load is the change between two readings. */
export interface CpuCounters {
  readonly idleSeconds: number;
  readonly totalSeconds: number;
}

export interface NodeExporterMetrics {
  readonly cpu: CpuCounters | null;
  readonly cpuCount: number;
  readonly availableMemoryBytes: number | null;
  readonly totalMemoryBytes: number | null;
}

const SAMPLE = /^([A-Za-z_:][A-Za-z0-9_:]*)(?:\{([^}]*)\})?\s+(\S+)/;
const LABEL = /([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
// iowait is time a core waited with nothing to run, so it counts as idle.
const IDLE_MODES = new Set(["idle", "iowait"]);

/** The text exposition format; unknown and malformed lines are skipped. */
export function parseNodeExporterMetrics(text: string): NodeExporterMetrics {
  let idleSeconds = 0;
  let totalSeconds = 0;
  const cpus = new Set<string>();
  let availableMemoryBytes: number | null = null;
  let totalMemoryBytes: number | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("#")) continue;
    const match = SAMPLE.exec(line.trim());
    if (match === null) continue;
    const [, name, labels = "", raw = ""] = match;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) continue;
    if (name === "node_cpu_seconds_total") {
      const label = new Map([...labels.matchAll(LABEL)].map(([, key, text]) => [key, text]));
      const cpu = label.get("cpu");
      const mode = label.get("mode");
      if (cpu === undefined || mode === undefined) continue;
      cpus.add(cpu);
      totalSeconds += value;
      if (IDLE_MODES.has(mode)) idleSeconds += value;
    } else if (name === "node_memory_MemAvailable_bytes") {
      availableMemoryBytes = value;
    } else if (name === "node_memory_MemTotal_bytes") {
      totalMemoryBytes = value;
    }
  }
  return {
    cpu: cpus.size > 0 ? { idleSeconds, totalSeconds } : null,
    cpuCount: cpus.size,
    availableMemoryBytes,
    totalMemoryBytes,
  };
}

/** The busy share of the machine between two readings, or null without a forward step. */
export function cpuUtilizationBetween(
  previous: CpuCounters | null,
  next: CpuCounters | null,
): number | null {
  if (previous === null || next === null) return null;
  const total = next.totalSeconds - previous.totalSeconds;
  const idle = next.idleSeconds - previous.idleSeconds;
  // A restarted exporter resets its counters; that step says nothing about the load.
  if (total <= 0 || idle < 0) return null;
  return Math.min(1, Math.max(0, 1 - idle / total));
}

export function nodeExporterResources(
  metrics: NodeExporterMetrics,
  cpuUtilization: number | null,
  sampledAt: number,
): HostResourcesSnapshot | null {
  const total = metrics.totalMemoryBytes;
  const available = metrics.availableMemoryBytes;
  if (metrics.cpu === null && (total === null || available === null)) return null;
  return {
    sampledAt,
    cpuUtilization,
    cpuCount: metrics.cpuCount,
    availableMemoryBytes: Math.round(Math.min(total ?? 0, Math.max(0, available ?? 0))),
    totalMemoryBytes: Math.round(total ?? 0),
  };
}

/**
 * Why the server will not read this URL, or null when it will. Only plain http to a Tailscale
 * address or MagicDNS name, without credentials, so the setting cannot point the server at the
 * internet or the machine's own network.
 */
export function nodeExporterUrlProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "Not a URL.";
  }
  if (url.protocol !== "http:") return "Only http URLs are read.";
  if (url.username !== "" || url.password !== "") return "URLs with credentials are not read.";
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (isSharedAddressSpaceHost(host) || isTailnetHost(host)) return null;
  return "Only Tailscale addresses (100.64.0.0/10) and MagicDNS names (.ts.net) are read.";
}

export function nodeExporterHost(raw: string): string {
  try {
    return new URL(raw).hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  } catch {
    return "";
  }
}
