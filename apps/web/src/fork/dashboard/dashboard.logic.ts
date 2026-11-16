// Fork-only: what the Dashboard derives from client state, kept pure so it can be tested.
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import {
  EnvironmentId,
  isListedThreadLineage,
  type ForkTailnetPeer,
  type ForkTailnetStatus,
  type HostResourcesSnapshot,
  type UsageProviderKind,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { makeWindow } from "@t3tools/shared/usageFormat";
import type { MergedUsage } from "@t3tools/shared/usageMerge";

import { forkWaitingReason } from "../../components/ForkResourceWidget.logic";
import { isWorkCompletedThread } from "../../components/sidebar/forkInbox";

export interface MachineLoad {
  /** Shares of the whole machine, 0 to 1. */
  readonly cpuShare: number | null;
  readonly memoryShare: number | null;
  readonly cores: number | null;
  readonly usedMemoryBytes: number | null;
  readonly totalMemoryBytes: number | null;
}

export const NO_LOAD: MachineLoad = {
  cpuShare: null,
  memoryShare: null,
  cores: null,
  usedMemoryBytes: null,
  totalMemoryBytes: null,
};

export function machineLoad(host: HostResourcesSnapshot | null): MachineLoad {
  if (host === null) return NO_LOAD;
  const total = host.totalMemoryBytes;
  const used = Math.max(0, total - host.availableMemoryBytes);
  return {
    cpuShare: host.cpuUtilization,
    memoryShare: total > 0 ? used / total : null,
    cores: host.cpuCount > 0 ? host.cpuCount : null,
    usedMemoryBytes: total > 0 ? used : null,
    totalMemoryBytes: total > 0 ? total : null,
  };
}

const ROUND_TRIP_WINDOW = 4;

/**
 * The last few round trips, rounded to whole milliseconds. Their minimum is the latency: a
 * slower one also holds the server's own work, such as taking a fresh CPU sample.
 */
export function nextRoundTrips(
  previous: ReadonlyArray<number>,
  sampleMs: number,
): ReadonlyArray<number> {
  return [...previous, Math.max(0, Math.round(sampleMs))].slice(-ROUND_TRIP_WINDOW);
}

export interface DashboardEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connected: boolean;
  /** A fork server that streams its load; others are read on a timer. */
  readonly liveLoad?: boolean;
}

/** The map's two wings around the client: the first half left, the rest right. */
export function splitAroundHub<T>(machines: ReadonlyArray<T>): {
  readonly left: ReadonlyArray<T>;
  readonly right: ReadonlyArray<T>;
} {
  const half = Math.ceil(machines.length / 2);
  return { left: machines.slice(0, half), right: machines.slice(half) };
}

/** Connected machines first, then by name, so the map does not reshuffle while one reconnects. */
export function orderMachines<T extends DashboardEnvironment>(
  environments: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return environments.toSorted(
    (left, right) =>
      Number(right.connected) - Number(left.connected) || left.label.localeCompare(right.label),
  );
}

export function onlineSummary(environments: ReadonlyArray<DashboardEnvironment>): string {
  const online = environments.filter((environment) => environment.connected).length;
  return `${online} of ${environments.length} up`;
}

/** Host names compare without case or a trailing dot; nothing else is folded together. */
function hostKey(name: string): string {
  return name.trim().replace(/\.$/, "").toLowerCase();
}

export interface TailnetReading {
  readonly environmentId: EnvironmentId;
  readonly status: ForkTailnetStatus | null;
}

/** What a server says about itself without the fork's tailnet call (upstream and older forks). */
export interface TailnetEnvironment extends DashboardEnvironment {
  /** The machine's own name, which Tailscale reports as its host name unless told otherwise. */
  readonly hostname?: string | null;
  /** Hosts of the server's advertised tailnet endpoints: Tailscale IPs or its MagicDNS name. */
  readonly tailnetHosts?: ReadonlyArray<string>;
}

/** node_exporter machines, as stand-in environments identified by the host they are read at. */
export function exporterEnvironments(
  readings: ReadonlyArray<{ readonly name: string; readonly host: string }>,
): ReadonlyArray<TailnetEnvironment> {
  return readings.map((reading) => ({
    environmentId: EnvironmentId.make(`node-exporter:${reading.name}:${reading.host}`),
    label: reading.name,
    connected: true,
    tailnetHosts: reading.host === "" ? [] : [reading.host.toLowerCase()],
  }));
}

/** The host of each tailnet endpoint a server advertises, lowercased, without IPv6 brackets. */
export function tailnetEndpointHosts(
  endpoints: ReadonlyArray<{ readonly kind: string; readonly httpBaseUrl: string }> | undefined,
): ReadonlyArray<string> {
  return (endpoints ?? []).flatMap((endpoint) => {
    if (endpoint.kind !== "tailnet") return [];
    try {
      const host = hostKey(new URL(endpoint.httpBaseUrl).hostname.replace(/^\[(.*)\]$/, "$1"));
      return host === "" ? [] : [host];
    } catch {
      return [];
    }
  });
}

const isExporter = (environmentId: EnvironmentId) => environmentId.startsWith("node-exporter:");

export interface TailnetLinks {
  /** The nodes each machine is, every node given to one machine at most. */
  readonly nodes: ReadonlyMap<EnvironmentId, ReadonlyArray<string>>;
  /** Every node some machine claims, contested ones too: none of them is "without T3 Code". */
  readonly claimed: ReadonlySet<string>;
}

/**
 * The tailnet nodes each machine is, strongest evidence first: its own reading, an advertised
 * endpoint, a node_exporter's host, then an exact name. A node two machines claim at one level goes
 * to neither, and a name counts only when one machine holds it, so a saved look lands once.
 */
export function linkTailnet(input: {
  readonly peers: ReadonlyArray<ForkTailnetPeer>;
  readonly readings: ReadonlyArray<TailnetReading>;
  readonly environments: ReadonlyArray<TailnetEnvironment>;
}): TailnetLinks {
  const nodes = new Map<EnvironmentId, string[]>();
  const claimed = new Set<string>();
  /** Nodes decided at an earlier level, given or contested. */
  const settled = new Set<string>();
  const evidenced = new Set<EnvironmentId>();
  const settle = (claims: ReadonlyArray<readonly [EnvironmentId, string]>) => {
    const owners = new Map<string, Set<EnvironmentId>>();
    for (const [environmentId, nodeId] of claims) {
      evidenced.add(environmentId);
      claimed.add(nodeId);
      if (settled.has(nodeId)) continue;
      owners.set(nodeId, (owners.get(nodeId) ?? new Set()).add(environmentId));
    }
    for (const [nodeId, environmentIds] of owners) {
      settled.add(nodeId);
      if (environmentIds.size !== 1) continue;
      const [environmentId] = environmentIds;
      nodes.set(environmentId!, [...(nodes.get(environmentId!) ?? []), nodeId]);
    }
  };
  settle(
    input.readings.flatMap((reading) =>
      reading.status?.self ? [[reading.environmentId, reading.status.self.id] as const] : [],
    ),
  );
  const byHost = (environment: TailnetEnvironment) => {
    if (evidenced.has(environment.environmentId)) return [];
    const hosts = new Set(environment.tailnetHosts ?? []);
    return input.peers
      .filter(
        (peer) =>
          peer.addresses.some((address) => hosts.has(address.toLowerCase())) ||
          (peer.dnsName !== "" && hosts.has(hostKey(peer.dnsName))),
      )
      .map((peer) => [environment.environmentId, peer.id] as const);
  };
  const servers = input.environments.filter(
    (environment) => !isExporter(environment.environmentId),
  );
  const exporters = input.environments.filter((environment) =>
    isExporter(environment.environmentId),
  );
  settle(servers.flatMap(byHost));
  settle(exporters.flatMap(byHost));
  const byName = new Map<string, EnvironmentId[]>();
  for (const environment of servers) {
    if (evidenced.has(environment.environmentId)) continue;
    // The machine's own name when the server reports one; the label is a user's choice.
    const name = hostKey(environment.hostname || environment.label);
    if (name === "") continue;
    byName.set(name, [...(byName.get(name) ?? []), environment.environmentId]);
  }
  const nameClaims: Array<readonly [EnvironmentId, string]> = [];
  for (const peer of input.peers) {
    const names = [hostKey(peer.hostName)];
    if (peer.dnsName !== "") names.push(hostKey(peer.dnsName.split(".")[0] ?? ""));
    for (const environmentId of new Set(names.flatMap((name) => byName.get(name) ?? []))) {
      nameClaims.push([environmentId, peer.id]);
    }
  }
  // A name that two machines share, or that two nodes answer to, identifies nothing.
  const claimsPerMachine = new Map<EnvironmentId, number>();
  for (const [environmentId] of nameClaims) {
    claimsPerMachine.set(environmentId, (claimsPerMachine.get(environmentId) ?? 0) + 1);
  }
  for (const [, nodeId] of nameClaims) claimed.add(nodeId);
  settle(nameClaims.filter(([environmentId]) => claimsPerMachine.get(environmentId) === 1));
  return { nodes, claimed };
}

/** The tailnet's machines without T3 Code: every peer no machine above claims. */
export function tailnetOnlyPeers(input: {
  /** The source's reading: with latencies once its pings answer, without them until then. */
  readonly source: ForkTailnetStatus | null;
  readonly readings: ReadonlyArray<TailnetReading>;
  readonly environments: ReadonlyArray<TailnetEnvironment>;
}): ReadonlyArray<ForkTailnetPeer> | null {
  if (!input.source?.available) return null;
  const peers = input.source.peers;
  const { claimed } = linkTailnet({
    peers,
    readings: input.readings,
    environments: input.environments,
  });
  return peers.filter((peer) => !claimed.has(peer.id));
}

/**
 * The machine that reads the tailnet: the local server first, so latencies are measured from the
 * machine the user sits at, then the others in order. One whose reading says Tailscale is not
 * available there hands over to the next; one still loading keeps its turn.
 */
export function pickTailnetSource(
  candidates: ReadonlyArray<EnvironmentId>,
  primaryEnvironmentId: EnvironmentId | null,
  readings: ReadonlyArray<TailnetReading>,
): EnvironmentId | null {
  const unavailable = (environmentId: EnvironmentId) =>
    readings.find((reading) => reading.environmentId === environmentId)?.status?.available ===
    false;
  const ordered =
    primaryEnvironmentId !== null && candidates.includes(primaryEnvironmentId)
      ? [primaryEnvironmentId, ...candidates.filter((id) => id !== primaryEnvironmentId)]
      : candidates;
  return ordered.find((environmentId) => !unavailable(environmentId)) ?? null;
}

export const USAGE_DAYS = 7;

/** Below this share of a window left, its bar turns to the theme's warning colour. */
const LOW_REMAINING_PERCENT = 15;

/** A limit window as room left, the way the composer shows it. */
export function windowRemaining(window: { readonly usedPercent: number }): {
  readonly percent: number;
  readonly low: boolean;
} {
  const percent = Math.round(100 - Math.max(0, Math.min(100, window.usedPercent)));
  return { percent, low: percent < LOW_REMAINING_PERCENT };
}

/** When the spend was counted: the oldest machine's reading, so the label never flatters it. */
export function spendReadAt(
  environments: ReadonlyArray<{ readonly summary: { readonly readAt: string } | null }>,
): string | null {
  const times = environments.flatMap((environment) =>
    environment.summary === null ? [] : [environment.summary.readAt],
  );
  return times.length === 0 ? null : times.toSorted()[0]!;
}

/** The last 7 days as of `now`: the same window, by reference, until the day changes. */
export function currentUsageWindow(previous: UsageSummaryInput, now: Date): UsageSummaryInput {
  const next = makeWindow(USAGE_DAYS, now);
  return next.untilDay === previous.untilDay && next.timeZone === previous.timeZone
    ? previous
    : next;
}

export interface ProviderSpend {
  readonly provider: UsageProviderKind;
  readonly costUsd: number;
  readonly requests: number;
  readonly tokens: number;
}

export interface DashboardSpend {
  readonly costUsd: number;
  readonly requests: number;
  readonly tokens: number;
  readonly providers: ReadonlyArray<ProviderSpend>;
  /** The machines whose transcripts the totals add up. */
  readonly machines: ReadonlyArray<string>;
}

/**
 * The spend the usage page shows, merged across machines (shared transcript folders count once),
 * cut to the providers that have one.
 */
export function dashboardSpend(
  merged: MergedUsage,
  labels: ReadonlyMap<EnvironmentId, string>,
): DashboardSpend {
  const providers = merged.providers
    .filter((provider) => provider.records > 0 || provider.costUsd > 0)
    .map((provider) => ({
      provider: provider.provider,
      costUsd: provider.costUsd,
      requests: provider.records,
      tokens: provider.totalTokens,
    }))
    .toSorted((left, right) => right.costUsd - left.costUsd);
  return {
    costUsd: merged.costUsd,
    requests: merged.records,
    tokens: merged.totalTokens,
    providers,
    machines: merged.contributingEnvironments.map((id) => labels.get(id) ?? id),
  };
}

export type ActiveThreadState = "waiting" | "working";

type ActiveThreadInput = Pick<
  EnvironmentThreadShell,
  | "archivedAt"
  | "deletedAt"
  | "lineage"
  | "settledOverride"
  | "snoozedUntil"
  | "updatedAt"
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "pendingGuestMessageCount"
  | "interactionMode"
  | "latestRun"
  | "runtime"
>;

export interface ActiveThread<T> {
  readonly thread: T;
  readonly state: ActiveThreadState;
  /** What it waits for, or "Working". */
  readonly label: string;
}

/**
 * The threads that work or wait on an answer on any machine, waiting first, newest first.
 * Same split as the sidebar inbox and the widget; a stopped or failed run is not waiting.
 */
export function activeThreads<T extends ActiveThreadInput>(
  threads: ReadonlyArray<T>,
  nowMs: number,
): ReadonlyArray<ActiveThread<T>> {
  const active: ActiveThread<T>[] = [];
  for (const thread of threads) {
    if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
    if (!isListedThreadLineage(thread.lineage) || thread.settledOverride === "settled") continue;
    const snoozedUntil =
      thread.snoozedUntil === null ? Number.NaN : Date.parse(thread.snoozedUntil);
    if (snoozedUntil > nowMs) continue;
    if (isThreadWorking(thread)) {
      active.push({ thread, state: "working", label: "Working" });
      continue;
    }
    if (isWorkCompletedThread(thread)) continue;
    const reason = forkWaitingReason(thread);
    if (reason.dismissible) continue;
    active.push({ thread, state: "waiting", label: reason.label });
  }
  return active.toSorted(
    (left, right) =>
      Number(left.state === "working") - Number(right.state === "working") ||
      right.thread.updatedAt.localeCompare(left.thread.updatedAt),
  );
}
