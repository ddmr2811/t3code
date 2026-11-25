import {
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
  USAGE_CONTRACT_VERSION,
  type UsageProviderKind,
} from "@t3tools/contracts";
import { enumerateDays } from "@t3tools/shared/usageFormat";
import { countedBuckets, type EnvironmentUsage } from "@t3tools/shared/usageMerge";
import * as DateTime from "effect/DateTime";

import { bucketKind, bucketTokens, type FlatByEnvironment, type SpendKind } from "./spend.logic.ts";

export type SpendRange = "7d" | "1m" | "6m" | "1y" | "all";

const RANGE_DAYS = { "7d": 7, "1m": 30, "6m": 182, "1y": 365 } as const;

/**
 * Days to read for a range: the range and the period before it. «Todo» asks for nothing more:
 * it is everything already read, so it never starts a long scan by itself.
 */
export const windowDays = (range: SpendRange) => (range === "all" ? 0 : RANGE_DAYS[range] * 2);

// Usage names Claude after the provider; its driver is `claudeAgent`. The rest share the name.
export const usageDriver = (provider: UsageProviderKind) =>
  ProviderDriverKind.make(provider === "claude" ? "claudeAgent" : provider);

const addDays = (day: string, days: number) =>
  DateTime.formatIsoDateUtc(DateTime.add(DateTime.makeUnsafe(`${day}T00:00:00Z`), { days }));

export interface GastoRow {
  readonly provider: UsageProviderKind;
  readonly model: string;
  /** Machine and provider: usage does not say which account of a provider spent it. */
  readonly account: string;
  readonly kind: SpendKind;
  readonly tokens: number;
  /** Priced amount; 0 for a subscription or a model without a rate. */
  readonly costUsd: number;
  readonly requests: number;
}

interface GastoTotals {
  readonly tokens: number;
  /** Money billed per use (reported, or part reported), as the Gasto card counts it. */
  readonly costUsd: number;
  /** The part of `costUsd` from groups that also hold list-price estimates. */
  readonly mixedUsd: number;
  /** List price of tokens nobody billed; shown apart. */
  readonly estimatedUsd: number;
  /** Whether anything was billed per use: without it there is no amount to show. */
  readonly paid: boolean;
  /** Whether a subscription covers part of it. */
  readonly flat: boolean;
  readonly requests: number;
}

interface Gasto {
  readonly rows: ReadonlyArray<GastoRow>;
  readonly current: GastoTotals;
  /** Null for «Todo», which has no period before it. */
  readonly previous: GastoTotals | null;
  /** The chart's first day: the range's, or for «Todo» the first day with usage. */
  readonly firstDay: string;
  readonly unit: "day" | "week" | "month";
  readonly bins: ReadonlyArray<{
    readonly key: string;
    readonly tokens: number;
    readonly costUsd: number;
  }>;
}

const isPriced = (kind: SpendKind) => kind === "real" || kind === "mixed" || kind === "estimated";

function totals(rows: ReadonlyArray<GastoRow>): GastoTotals {
  const sum = (pick: (row: GastoRow) => number) => rows.reduce((acc, row) => acc + pick(row), 0);
  return {
    tokens: sum((row) => row.tokens),
    costUsd: sum((row) => (row.kind === "real" || row.kind === "mixed" ? row.costUsd : 0)),
    mixedUsd: sum((row) => (row.kind === "mixed" ? row.costUsd : 0)),
    estimatedUsd: sum((row) => (row.kind === "estimated" ? row.costUsd : 0)),
    paid: rows.some((row) => row.kind === "real" || row.kind === "mixed"),
    flat: rows.some((row) => row.kind === "flat"),
    requests: sum((row) => row.requests),
  };
}

export function binKey(day: string, unit: Gasto["unit"]): string {
  if (unit === "day") return day;
  if (unit === "month") return day.slice(0, 7);
  // 1 January 1970 was a Thursday; Monday is 0 here.
  const mondayBased = (Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000) + 3) % 7;
  return addDays(day, -mondayBased);
}

/**
 * Usage of the range by model and account, its totals against the period of the same length
 * before it, and its bars, from whatever window was read. Each group counts once across machines,
 * classified as the Gasto card classifies it.
 */
export function gasto(
  environments: ReadonlyArray<EnvironmentUsage>,
  flatByEnvironment: FlatByEnvironment,
  range: SpendRange,
  untilDay: string,
): Gasto {
  const days = range === "all" ? null : RANGE_DAYS[range];
  const since = days === null ? null : addDays(untilDay, 1 - days);
  const previousSince = since === null || days === null ? null : addDays(since, -days);
  const labels = new Map(environments.map((env) => [env.environmentId, env.label]));
  const current = new Map<string, GastoRow>();
  const previous = new Map<string, GastoRow>();
  const byDay = new Map<string, { tokens: number; costUsd: number }>();
  let firstDay = since ?? untilDay;
  for (const { environmentId, bucket } of countedBuckets(environments, USAGE_CONTRACT_VERSION)) {
    if (previousSince !== null && bucket.day < previousSince) continue;
    const kind = bucketKind(
      bucket,
      flatByEnvironment.get(environmentId)?.has(bucket.provider) === true,
    );
    const tokens = bucketTokens(bucket);
    const costUsd = isPriced(kind) ? bucket.costUsd : 0;
    if (tokens === 0 && costUsd === 0) continue;
    const isCurrent = since === null || bucket.day >= since;
    const provider = PROVIDER_DISPLAY_NAMES[usageDriver(bucket.provider)] ?? bucket.provider;
    const account = `${labels.get(environmentId) ?? environmentId} · ${provider}`;
    const into = isCurrent ? current : previous;
    const key = `${bucket.provider} ${bucket.model} ${account} ${kind}`;
    const row = into.get(key);
    into.set(key, {
      provider: bucket.provider,
      model: bucket.model,
      account,
      kind,
      tokens: (row?.tokens ?? 0) + tokens,
      costUsd: (row?.costUsd ?? 0) + costUsd,
      requests: (row?.requests ?? 0) + bucket.records,
    });
    if (!isCurrent) continue;
    if (bucket.day < firstDay) firstDay = bucket.day;
    const day = byDay.get(bucket.day) ?? { tokens: 0, costUsd: 0 };
    byDay.set(bucket.day, { tokens: day.tokens + tokens, costUsd: day.costUsd + costUsd });
  }
  const chartDays = enumerateDays(firstDay, untilDay);
  // Day, week (from Monday) or month, so the chart keeps between 1 and about 30 bars.
  const unit = chartDays.length <= 31 ? "day" : chartDays.length <= 182 ? "week" : "month";
  const bins = new Map<string, { key: string; tokens: number; costUsd: number }>();
  for (const day of chartDays) {
    const key = binKey(day, unit);
    const bin = bins.get(key) ?? { key, tokens: 0, costUsd: 0 };
    const add = byDay.get(day);
    bins.set(key, {
      key,
      tokens: bin.tokens + (add?.tokens ?? 0),
      costUsd: bin.costUsd + (add?.costUsd ?? 0),
    });
  }
  const rows = [...current.values()].toSorted(
    (a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens,
  );
  return {
    rows,
    current: totals(rows),
    previous: since === null ? null : totals([...previous.values()]),
    firstDay,
    unit,
    bins: [...bins.values()],
  };
}

/** Change against the period before (0.15 is 15 % more); null unless both periods have it. */
export function trend(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return (current - previous) / previous;
}
