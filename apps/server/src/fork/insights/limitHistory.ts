// Fork-only: the limit history the server keeps for the charts, as pure functions over a small
// document: which accounts a sample reads, how a sample is appended, and the size it is held to.
import {
  type ForkLimitHistory,
  type ForkLimitHistoryPoint,
  ForkLimitHistorySeries,
  type ForkLimitHistoryWindow,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const LIMIT_SAMPLE_INTERVAL_MS = 5 * 60_000;
export const LIMIT_HISTORY_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** A week of samples, with room for a few extra. */
export const MAX_POINTS_PER_WINDOW = 2_100;
export const MAX_SERIES = 48;
/** A reading older than this is the last good one of a failing probe, not the limit now. */
const STALE_READING_MS = 2 * 60 * 60_000;

export const StoredLimitHistory = Schema.Struct({
  version: Schema.Literal(1),
  collectingSince: Schema.NullOr(Schema.Number),
  series: Schema.Array(ForkLimitHistorySeries),
});
export type StoredLimitHistory = typeof StoredLimitHistory.Type;

export const EMPTY_LIMIT_HISTORY: StoredLimitHistory = {
  version: 1,
  collectingSince: null,
  series: [],
};

export interface LimitSample {
  readonly key: string;
  readonly driver: string;
  readonly email: string | null;
  readonly credentialFingerprint: string | null;
  readonly workspaceId: string | null;
  readonly instanceId: string | null;
  readonly windows: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly label: string;
    readonly usedPercent: number;
  }>;
}

function readable(limits: ServerProviderUsageLimits | undefined, nowMs: number): boolean {
  if (limits === undefined || limits.unavailable !== undefined) return false;
  if (limits.windows.length === 0) return false;
  const checkedAt = Date.parse(limits.checkedAt);
  return Number.isFinite(checkedAt) && nowMs - checkedAt <= STALE_READING_MS;
}

const windowsOf = (limits: ServerProviderUsageLimits) =>
  limits.windows.map((window) => ({
    id: window.id,
    kind: window.kind,
    label: window.label,
    usedPercent: window.usedPercent,
  }));

/**
 * Where the samples come from plus who is signed in there, so a different login, or the same one
 * in another workspace, starts its own series instead of continuing someone else's.
 */
function seriesKey(
  source: string,
  login: {
    readonly email?: string | undefined;
    readonly credentialFingerprint?: string | undefined;
    readonly workspaceId?: string | undefined;
  },
): string {
  const who = login.email?.trim().toLowerCase() || login.credentialFingerprint || "";
  return `${source}|${who}|${login.workspaceId ?? ""}`;
}

/** Every account this server reads limits for right now: its own logins and its hubs'. */
export function limitSamples(
  providers: ReadonlyArray<ServerProvider>,
  sources: ReadonlyArray<UsageLimitSourceSnapshot>,
  nowMs: number,
): ReadonlyArray<LimitSample> {
  const native = providers.flatMap((provider): LimitSample[] => {
    const limits = provider.usageLimits;
    if (!provider.enabled || limits === undefined || !readable(limits, nowMs)) return [];
    return [
      {
        key: seriesKey(`native:${provider.instanceId}`, {
          email: provider.auth.email,
          credentialFingerprint: limits.credentialFingerprint,
          workspaceId: provider.auth.workspaceId,
        }),
        driver: provider.driver,
        email: provider.auth.email ?? null,
        credentialFingerprint: limits.credentialFingerprint ?? null,
        workspaceId: provider.auth.workspaceId ?? null,
        instanceId: provider.instanceId,
        windows: windowsOf(limits),
      },
    ];
  });
  const hubs = sources.flatMap((source) =>
    source.accounts.flatMap((account): LimitSample[] => {
      if (!readable(account.usageLimits, nowMs)) return [];
      return [
        {
          key: seriesKey(`hub:${source.id}:${account.id}`, {
            email: account.email,
            credentialFingerprint: account.usageLimits.credentialFingerprint,
            workspaceId: account.workspaceId,
          }),
          driver: account.driver,
          email: account.email ?? null,
          credentialFingerprint: account.usageLimits.credentialFingerprint ?? null,
          workspaceId: account.workspaceId ?? null,
          instanceId: null,
          windows: windowsOf(account.usageLimits),
        },
      ];
    }),
  );
  return [...native, ...hubs];
}

const round1 = (value: number) => Math.round(Math.max(0, Math.min(100, value)) * 10) / 10;

/**
 * A flat stretch keeps its first and last sample: a reading equal to the two before it moves the
 * last one forward. Only while samples keep coming, so a gap still shows where it was.
 */
function appendPoint(
  points: ReadonlyArray<ForkLimitHistoryPoint>,
  point: ForkLimitHistoryPoint,
): ReadonlyArray<ForkLimitHistoryPoint> {
  const last = points.at(-1);
  const before = points.at(-2);
  if (
    last !== undefined &&
    before !== undefined &&
    last[1] === point[1] &&
    before[1] === point[1] &&
    point[0] - last[0] <= 2 * LIMIT_SAMPLE_INTERVAL_MS
  ) {
    return [...points.slice(0, -1), point];
  }
  return [...points, point];
}

function trimWindow(
  window: ForkLimitHistoryWindow,
  cutoffMs: number,
): ForkLimitHistoryWindow | null {
  const points = window.points
    .filter((point) => point[0] >= cutoffMs)
    .slice(-MAX_POINTS_PER_WINDOW);
  return points.length === 0 ? null : { ...window, points };
}

const lastSampleAt = (series: ForkLimitHistorySeries) =>
  Math.max(...series.windows.map((window) => window.points.at(-1)?.[0] ?? 0));

/**
 * Adds one round of samples and holds the document to its size: a week per window, a bounded
 * number of points, and the most recently read accounts.
 */
export function appendLimitSamples(
  history: StoredLimitHistory,
  samples: ReadonlyArray<LimitSample>,
  nowMs: number,
): StoredLimitHistory {
  const byKey = new Map(history.series.map((series) => [series.key, series]));
  for (const sample of samples) {
    const previous = byKey.get(sample.key);
    const windows = new Map((previous?.windows ?? []).map((window) => [window.id, window]));
    for (const reading of sample.windows) {
      const known = windows.get(reading.id);
      windows.set(reading.id, {
        id: reading.id,
        kind: reading.kind,
        label: reading.label,
        points: appendPoint(known?.points ?? [], [nowMs, round1(reading.usedPercent)]),
      });
    }
    byKey.set(sample.key, {
      key: sample.key,
      driver: sample.driver,
      email: sample.email,
      credentialFingerprint: sample.credentialFingerprint,
      workspaceId: sample.workspaceId,
      instanceId: sample.instanceId,
      windows: [...windows.values()],
    });
  }
  const cutoffMs = nowMs - LIMIT_HISTORY_RETENTION_MS;
  const series = [...byKey.values()]
    .flatMap((entry) => {
      const windows = entry.windows.flatMap((window) => trimWindow(window, cutoffMs) ?? []);
      return windows.length === 0 ? [] : [{ ...entry, windows }];
    })
    .toSorted((left, right) => lastSampleAt(right) - lastSampleAt(left))
    .slice(0, MAX_SERIES);
  return {
    version: 1,
    collectingSince: history.collectingSince ?? (samples.length > 0 ? nowMs : null),
    series,
  };
}

/** The last `sinceMs` of every window, with the sample before it so a line starts at the edge. */
export function limitHistorySince(history: StoredLimitHistory, sinceMs: number): ForkLimitHistory {
  const series = history.series.flatMap((entry) => {
    const windows = entry.windows.flatMap((window) => {
      const first = window.points.findIndex((point) => point[0] >= sinceMs);
      const start = first === -1 ? window.points.length - 1 : Math.max(0, first - 1);
      const points = window.points.slice(start);
      return points.length === 0 ? [] : [{ ...window, points }];
    });
    return windows.length === 0 ? [] : [{ ...entry, windows }];
  });
  return {
    collectingSince: history.collectingSince,
    sampleIntervalMs: LIMIT_SAMPLE_INTERVAL_MS,
    series,
  };
}
