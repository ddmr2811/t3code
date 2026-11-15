// Fork-only: what the Dashboard derives from client state, kept pure so it can be tested.
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import type {
  EnvironmentId,
  ForkTailnetPeer,
  ForkTailnetStatus,
  HostResourcesSnapshot,
  UsageProviderKind,
} from "@t3tools/contracts";
import type { MergedUsage } from "@t3tools/shared/usageMerge";

import { forkWaitingReason } from "../../components/ForkResourceWidget.logic";
import { isSidebarHiddenThread } from "../../components/Sidebar.logic";
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

/** How a machine or peer name compares: case, dots and separators do not count. */
function nameKey(name: string): string {
  return (name.split(".")[0] ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export interface TailnetReading {
  readonly environmentId: EnvironmentId;
  readonly status: ForkTailnetStatus | null;
}

export interface TailnetView {
  /** The machine whose Tailscale reported the peers and measured their latency. */
  readonly sourceEnvironmentId: EnvironmentId;
  readonly peers: ReadonlyArray<ForkTailnetPeer>;
}

/**
 * The tailnet's machines that do not run T3 Code, from the source machine's reading. A peer is a
 * T3 machine when a connected fork server reports it as itself, or when its name matches one.
 */
export function tailnetOnlyPeers(input: {
  readonly sourceEnvironmentId: EnvironmentId | null;
  readonly readings: ReadonlyArray<TailnetReading>;
  readonly environments: ReadonlyArray<DashboardEnvironment>;
}): TailnetView | null {
  const source = input.readings.find(
    (reading) => reading.environmentId === input.sourceEnvironmentId,
  )?.status;
  if (input.sourceEnvironmentId === null || !source?.available) return null;
  const selfIds = new Set(
    input.readings.flatMap((reading) => (reading.status?.self ? [reading.status.self.id] : [])),
  );
  const environmentNames = new Set(
    input.environments.map((environment) => nameKey(environment.label)).filter(Boolean),
  );
  const isT3Machine = (peer: ForkTailnetPeer) =>
    selfIds.has(peer.id) ||
    environmentNames.has(nameKey(peer.hostName)) ||
    (peer.dnsName !== "" && environmentNames.has(nameKey(peer.dnsName)));
  return {
    sourceEnvironmentId: input.sourceEnvironmentId,
    peers: source.peers.filter((peer) => !isT3Machine(peer)),
  };
}

/** The local server first, so latencies are measured from the machine the user sits at. */
export function pickTailnetSource(
  candidates: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly supported: boolean }>,
  primaryEnvironmentId: EnvironmentId | null,
): EnvironmentId | null {
  const supported = candidates.filter((candidate) => candidate.supported);
  return (
    supported.find((candidate) => candidate.environmentId === primaryEnvironmentId)
      ?.environmentId ??
    supported[0]?.environmentId ??
    null
  );
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
    if (isSidebarHiddenThread(thread) || thread.settledOverride === "settled") continue;
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
