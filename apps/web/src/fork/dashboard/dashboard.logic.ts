// Fork-only: what the Dashboard derives from client state, kept pure so it can be tested.
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import type {
  EnvironmentId,
  ForkTailnetPeer,
  ForkTailnetStatus,
  HostResourcesSnapshot,
  UsageProviderKind,
  UsageSummaryInput,
} from "@t3tools/contracts";
import { makeWindow } from "@t3tools/shared/usageFormat";
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

/** Host names compare without case or a trailing dot; nothing else is folded together. */
function hostKey(name: string): string {
  return name.trim().replace(/\.$/, "").toLowerCase();
}

export interface TailnetReading {
  readonly environmentId: EnvironmentId;
  readonly status: ForkTailnetStatus | null;
}

/**
 * The tailnet's machines that do not run T3 Code. A peer that a connected fork server reports
 * as itself is a T3 machine. Names only stand in for machines whose identity no reading gives
 * (offline, upstream or without Tailscale), and only an exact host name counts, so a machine
 * whose identity is known never hides a different peer that happens to share its name.
 */
export function tailnetOnlyPeers(input: {
  /** The source's reading: with latencies once its pings answer, without them until then. */
  readonly source: ForkTailnetStatus | null;
  readonly readings: ReadonlyArray<TailnetReading>;
  readonly environments: ReadonlyArray<DashboardEnvironment>;
}): ReadonlyArray<ForkTailnetPeer> | null {
  if (!input.source?.available) return null;
  const selfByEnvironment = new Map(
    input.readings.flatMap((reading) =>
      reading.status?.self ? [[reading.environmentId, reading.status.self.id] as const] : [],
    ),
  );
  const selfIds = new Set(selfByEnvironment.values());
  const unidentifiedNames = new Set(
    input.environments
      .filter((environment) => !selfByEnvironment.has(environment.environmentId))
      .map((environment) => hostKey(environment.label))
      .filter((name) => name !== ""),
  );
  const isT3Machine = (peer: ForkTailnetPeer) =>
    selfIds.has(peer.id) ||
    unidentifiedNames.has(hostKey(peer.hostName)) ||
    (peer.dnsName !== "" && unidentifiedNames.has(hostKey(peer.dnsName.split(".")[0] ?? "")));
  return input.source.peers.filter((peer) => !isT3Machine(peer));
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
