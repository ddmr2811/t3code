// Fork-only: reads a Prometheus node_exporter's text into the Dashboard's machine load.
import * as NodeNet from "node:net";

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

/** Longer lines are dropped unread; real node_exporter lines are well under 1 KB. */
export const MAX_LINE_LENGTH = 4096;
/** A full node_exporter page is a few thousand lines; more than this is not one. */
const MAX_LINES = 50_000;
const CPU_SECONDS = "node_cpu_seconds_total";
const MEMORY_AVAILABLE = "node_memory_MemAvailable_bytes";
const MEMORY_TOTAL = "node_memory_MemTotal_bytes";
// iowait is time a core waited with nothing to run, so it counts as idle.
const IDLE_MODES = new Set(["idle", "iowait"]);

/** `{key="value",...}` from `start` (the brace), read once left to right; null if malformed. */
function readLabels(
  line: string,
  start: number,
): { readonly labels: Map<string, string>; readonly end: number } | null {
  const labels = new Map<string, string>();
  let index = start + 1;
  while (index < line.length) {
    const char = line[index];
    if (char === "}") return { labels, end: index + 1 };
    if (char === "," || char === " ") {
      index++;
      continue;
    }
    let keyEnd = index;
    while (keyEnd < line.length && line[keyEnd] !== "=") keyEnd++;
    if (line[keyEnd + 1] !== '"') return null;
    let value = "";
    let cursor = keyEnd + 2;
    while (cursor < line.length && line[cursor] !== '"') {
      if (line[cursor] === "\\") cursor++;
      value += line[cursor] ?? "";
      cursor++;
    }
    if (cursor >= line.length) return null;
    labels.set(line.slice(index, keyEnd).trim(), value);
    index = cursor + 1;
  }
  return null;
}

/** The sample's value: the first field after the name and labels, before any timestamp. */
function readValue(line: string, start: number): number | null {
  const field = line.slice(start).trim().split(" ", 1)[0] ?? "";
  const value = Number(field);
  return field !== "" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * The text exposition format, read in one pass without backtracking: only the three families
 * used, lines over MAX_LINE_LENGTH dropped unread, and at most MAX_LINES lines looked at.
 */
export function parseNodeExporterMetrics(text: string): NodeExporterMetrics {
  let idleSeconds = 0;
  let totalSeconds = 0;
  const cpus = new Set<string>();
  let availableMemoryBytes: number | null = null;
  let totalMemoryBytes: number | null = null;
  let lineStart = 0;
  for (let lines = 0; lineStart < text.length && lines < MAX_LINES; lines++) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const length = lineEnd - lineStart;
    const line = length > MAX_LINE_LENGTH ? "" : text.slice(lineStart, lineEnd);
    lineStart = lineEnd + 1;
    if (line.startsWith(CPU_SECONDS + "{")) {
      const labels = readLabels(line, CPU_SECONDS.length);
      const value = labels === null ? null : readValue(line, labels.end);
      const cpu = labels?.labels.get("cpu");
      const mode = labels?.labels.get("mode");
      if (value === null || cpu === undefined || mode === undefined) continue;
      cpus.add(cpu);
      totalSeconds += value;
      if (IDLE_MODES.has(mode)) idleSeconds += value;
    } else if (line.startsWith(MEMORY_AVAILABLE + " ")) {
      availableMemoryBytes = readValue(line, MEMORY_AVAILABLE.length) ?? availableMemoryBytes;
    } else if (line.startsWith(MEMORY_TOTAL + " ")) {
      totalMemoryBytes = readValue(line, MEMORY_TOTAL.length) ?? totalMemoryBytes;
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
 * Why the server will not read this URL, or null when it will. Only plain http to a literal
 * Tailscale IP, without credentials: no name is resolved, so the setting cannot be pointed at
 * the internet, this machine or its network, even by DNS that changes after it is checked.
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
  const tailnetIp =
    (NodeNet.isIPv4(host) && isSharedAddressSpaceHost(host)) ||
    (NodeNet.isIPv6(host) && isTailnetHost(host));
  return tailnetIp
    ? null
    : "Only Tailscale IPs (100.64.0.0/10 or fd7a:115c:a1e0::/48) are read; use the machine's Tailscale IP.";
}

export function nodeExporterHost(raw: string): string {
  try {
    return new URL(raw).hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  } catch {
    return "";
  }
}
