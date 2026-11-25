import {
  USAGE_CONTRACT_VERSION,
  type UsageProviderKind,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { enumerateDays, makeWindow } from "@t3tools/shared/usageFormat";
import { countedBuckets, type EnvironmentUsage } from "@t3tools/shared/usageMerge";
import * as DateTime from "effect/DateTime";

import { bucketKind, bucketTokens, type FlatByEnvironment, type SpendKind } from "./spend.logic.ts";

export type SpendRange = "7d" | "1m" | "6m" | "1y" | "all";

const RANGE_DAYS = { "7d": 7, "1m": 30, "6m": 182, "1y": 365 } as const;
// «Todo» reads ten years back: the server only returns days that hold usage.
const ALL_DAYS = 3650;

export const rangeDays = (range: SpendRange) => (range === "all" ? ALL_DAYS : RANGE_DAYS[range]);

/** What to read: the range, plus as many days before it for the trend («Todo» has none). */
export function rangeWindow(range: SpendRange, now?: Date): UsageSummaryInput {
  return makeWindow(range === "all" ? ALL_DAYS : RANGE_DAYS[range] * 2, now);
}

/** The first day of the range itself; earlier days in the window are the previous period. */
export function rangeStart(range: SpendRange, untilDay: string): string {
  return addDays(untilDay, 1 - rangeDays(range));
}

const addDays = (day: string, days: number) =>
  DateTime.formatIsoDateUtc(DateTime.add(DateTime.makeUnsafe(`${day}T00:00:00Z`), { days }));

export interface GastoRow {
  readonly provider: UsageProviderKind;
  readonly model: string;
  /** The machine, and the transcript folder when the server names it (one per account). */
  readonly account: string;
  readonly kind: SpendKind;
  readonly tokens: number;
  /** Priced amount; 0 for a subscription or a model without a rate. */
  readonly costUsd: number;
  readonly requests: number;
}

export interface GastoTotals {
  readonly tokens: number;
  /** Reported plus list-price money; subscriptions and unpriced tokens add nothing. */
  readonly costUsd: number;
  /** The list-price part of `costUsd`, nothing billed. */
  readonly estimatedUsd: number;
  /** Whether any priced line counts: without one the cost is unknown, not zero. */
  readonly priced: boolean;
  readonly requests: number;
}

export interface GastoBin {
  readonly key: string;
  readonly tokens: number;
  readonly costUsd: number;
}

export interface Gasto {
  readonly rows: ReadonlyArray<GastoRow>;
  readonly current: GastoTotals;
  /** Null for «Todo», which has no period before it. */
  readonly previous: GastoTotals | null;
  readonly unit: "day" | "week" | "month";
  readonly bins: ReadonlyArray<GastoBin>;
}

// Providers keep transcripts in `<account home>/projects` or `/sessions`: the parent names the account.
const accountFolder = (path: string) => {
  const parts = path.split(/[\\/]/).filter((part) => part !== "");
  return parts.at(-2) ?? parts.at(-1) ?? path;
};

const isPriced = (kind: SpendKind) => kind === "real" || kind === "mixed" || kind === "estimated";

function totals(rows: ReadonlyArray<GastoRow>): GastoTotals {
  let tokens = 0;
  let costUsd = 0;
  let estimatedUsd = 0;
  let requests = 0;
  for (const row of rows) {
    tokens += row.tokens;
    costUsd += row.costUsd;
    if (row.kind === "estimated") estimatedUsd += row.costUsd;
    requests += row.requests;
  }
  return { tokens, costUsd, estimatedUsd, requests, priced: rows.some((r) => isPriced(r.kind)) };
}

/** Day, week (from Monday) or month, so a bar chart keeps between 7 and about 30 bars. */
export function binUnit(days: number): Gasto["unit"] {
  return days <= 31 ? "day" : days <= 182 ? "week" : "month";
}

export function binKey(day: string, unit: Gasto["unit"]): string {
  if (unit === "day") return day;
  if (unit === "month") return day.slice(0, 7);
  // 1 January 1970 was a Thursday; Monday is 0 here.
  const mondayBased = (Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000) + 3) % 7;
  return addDays(day, -mondayBased);
}

/**
 * Usage of the range by model and account, its totals against the period before, and its bars.
 * Each group counts once across machines, classified as the Gasto card classifies it.
 */
export function gasto(
  environments: ReadonlyArray<EnvironmentUsage>,
  flatByEnvironment: FlatByEnvironment,
  range: SpendRange,
  untilDay: string,
): Gasto {
  const since = rangeStart(range, untilDay);
  const labels = new Map(environments.map((env) => [env.environmentId, env.label]));
  const current = new Map<string, GastoRow>();
  const previous = new Map<string, GastoRow>();
  const byBin = new Map<string, { tokens: number; costUsd: number }>();
  let firstDay = untilDay;
  for (const { environmentId, bucket } of countedBuckets(environments, USAGE_CONTRACT_VERSION)) {
    const flat = flatByEnvironment.get(environmentId)?.has(bucket.provider) === true;
    const kind = bucketKind(bucket, flat);
    const machine = labels.get(environmentId) ?? environmentId;
    const account =
      bucket.sourcePath === undefined
        ? machine
        : `${machine} · ${accountFolder(bucket.sourcePath)}`;
    const tokens = bucketTokens(bucket);
    const costUsd = isPriced(kind) ? bucket.costUsd : 0;
    if (tokens === 0 && costUsd === 0) continue;
    const isCurrent = bucket.day >= since;
    if (isCurrent && bucket.day < firstDay) firstDay = bucket.day;
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
    const bin = byBin.get(bucket.day) ?? { tokens: 0, costUsd: 0 };
    byBin.set(bucket.day, { tokens: bin.tokens + tokens, costUsd: bin.costUsd + costUsd });
  }
  // «Todo» starts where the usage starts, not ten years back.
  const chartSince = range === "all" ? firstDay : since;
  const unit = binUnit(enumerateDays(chartSince, untilDay).length);
  const bins = new Map<string, GastoBin>();
  for (const day of enumerateDays(chartSince, untilDay)) {
    const key = binKey(day, unit);
    const bin = bins.get(key) ?? { key, tokens: 0, costUsd: 0 };
    const add = byBin.get(day);
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
    previous: range === "all" ? null : totals([...previous.values()]),
    unit,
    bins: [...bins.values()],
  };
}

/** Change against the period before (0.15 is 15 % more), or null with nothing to compare. */
export function trend(current: number, previous: number | null): number | null {
  if (previous === null || previous === 0) return null;
  return (current - previous) / previous;
}
