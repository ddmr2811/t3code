import {
  type EnvironmentId,
  USAGE_CONTRACT_VERSION,
  type TurnTokenUsage,
  type UsageBucket,
  type UsageSummary,
  type UsageProviderKind,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { makeWindow } from "@t3tools/shared/usageFormat";
import { countedBuckets, type EnvironmentUsage } from "@t3tools/shared/usageMerge";

/** Monday to today in the browser's zone: the week the Gasto card counts. */
export function weekWindow(now?: Date): UsageSummaryInput {
  const { untilDay } = makeWindow(1, now);
  const [year = 0, month = 1, day = 1] = untilDay.split("-").map(Number);
  // 1 January 1970 was a Thursday; Monday is 0 here.
  const mondayBased = (Math.floor(Date.UTC(year, month - 1, day) / 86_400_000) + 3) % 7;
  return makeWindow(mondayBased + 1, now);
}

/**
 * `real`: money the provider reported. `mixed`: a group the server marks priced but where some
 * records were reported, so its amount is part real and part list price; it counts toward the cap.
 * `estimated`: tokens at list price, nothing billed. `flat`: a subscription with a limit on that
 * machine, so its list price is not paid. `unpriced`: no rate is known, which is not free.
 */
export type SpendKind = "real" | "mixed" | "estimated" | "flat" | "unpriced";

export interface SpendLine {
  readonly provider: UsageProviderKind;
  readonly model: string;
  readonly kind: SpendKind;
  readonly costUsd: number;
  readonly tokens: number;
  /** Tokens of this line no rate covers; shown beside its amount, never priced at 0. */
  readonly unpricedTokens: number;
}

export interface SpendPeriod {
  /** Reported money plus groups that include some; the cap counts this. */
  readonly realUsd: number;
  /** The part of `realUsd` from groups that also include list-price estimates. */
  readonly mixedUsd: number;
  /** List price of tokens nobody billed; shown apart and labelled «est.». */
  readonly estimatedUsd: number;
  readonly lines: ReadonlyArray<SpendLine>;
}

/** Providers each machine pays as a flat subscription. A machine missing here pays per use. */
export type FlatByEnvironment = ReadonlyMap<EnvironmentId, ReadonlySet<UsageProviderKind>>;

const KIND_ORDER: Record<SpendKind, number> = {
  real: 0,
  mixed: 1,
  estimated: 2,
  flat: 3,
  unpriced: 4,
};

// Older servers do not say how many records were reported, so a priced group may be mixed.
const isListPriceOnly = (bucket: UsageBucket) =>
  bucket.costSource === "modelPriced" && bucket.providerReportedRecords === 0;

function bucketKind(bucket: UsageBucket, flat: boolean): SpendKind {
  if (flat) return "flat";
  if (bucket.costSource === "providerReported") return "real";
  if (bucket.costSource === "unpriced") return "unpriced";
  return isListPriceOnly(bucket) ? "estimated" : "mixed";
}

const bucketTokens = (bucket: UsageBucket) =>
  bucket.totals.uncachedInputTokens +
  bucket.totals.cachedInputTokens +
  bucket.totals.cacheCreationTokens +
  bucket.totals.outputTokens;

const bucketUnpricedTokens = (bucket: UsageBucket) =>
  bucket.unpricedTokens ??
  (bucket.records === 0
    ? 0
    : Math.round((bucketTokens(bucket) * bucket.unpricedRecords) / bucket.records));

/** Each group once (shared transcript folders and partial rescans deduplicated), then classified. */
function period(
  environments: ReadonlyArray<EnvironmentUsage>,
  flatByEnvironment: FlatByEnvironment,
): SpendPeriod {
  const byLine = new Map<string, SpendLine>();
  for (const { environmentId, bucket } of countedBuckets(environments, USAGE_CONTRACT_VERSION)) {
    const flat = flatByEnvironment.get(environmentId)?.has(bucket.provider) === true;
    const kind = bucketKind(bucket, flat);
    const key = `${bucket.provider} ${bucket.model} ${kind}`;
    const line = byLine.get(key);
    const priced = kind === "flat" || kind === "unpriced" ? 0 : bucket.costUsd;
    byLine.set(key, {
      provider: bucket.provider,
      model: bucket.model,
      kind,
      costUsd: (line?.costUsd ?? 0) + priced,
      tokens: (line?.tokens ?? 0) + bucketTokens(bucket),
      unpricedTokens:
        (line?.unpricedTokens ?? 0) +
        (kind === "unpriced" ? bucketTokens(bucket) : bucketUnpricedTokens(bucket)),
    });
  }
  const lines = [...byLine.values()]
    .filter((line) => line.tokens > 0)
    .toSorted(
      (a, b) =>
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.costUsd - a.costUsd || b.tokens - a.tokens,
    );
  const total = (kind: SpendKind) =>
    lines.reduce((sum, line) => sum + (line.kind === kind ? line.costUsd : 0), 0);
  return {
    realUsd: total("real") + total("mixed"),
    mixedUsd: total("mixed"),
    estimatedUsd: total("estimated"),
    lines,
  };
}

/** Today's and this week's spend across machines; shared transcript folders count once. */
export function spendSummary(
  environments: ReadonlyArray<EnvironmentUsage>,
  flatByEnvironment: FlatByEnvironment,
): { readonly today: SpendPeriod; readonly week: SpendPeriod } {
  const todayOnly = environments.map((environment) => ({
    ...environment,
    summary: {
      ...environment.summary,
      buckets: environment.summary.buckets.filter(
        (bucket) => bucket.day === environment.summary.untilDay,
      ),
    },
  }));
  return {
    today: period(todayOnly, flatByEnvironment),
    week: period(environments, flatByEnvironment),
  };
}

/** Whether a machine's own summary says some transcripts could not be read: its total is short. */
export const summaryIncomplete = (summary: UsageSummary) =>
  summary.sources.some((source) => source.status === "failed" || source.status === "partial");

export const rateKey = (provider: UsageProviderKind, model: string) => `${provider} ${model}`;

/**
 * The list price per token of each provider's model, from this week's groups priced from the
 * rate table alone, never from reported money. A bot's turn tokens times it is its estimate.
 */
export function ratesByModel(
  environments: ReadonlyArray<EnvironmentUsage>,
): ReadonlyMap<string, number> {
  const sums = new Map<string, { usd: number; tokens: number }>();
  for (const { bucket } of countedBuckets(environments, USAGE_CONTRACT_VERSION)) {
    if (!isListPriceOnly(bucket)) continue;
    const key = rateKey(bucket.provider, bucket.model);
    const sum = sums.get(key) ?? { usd: 0, tokens: 0 };
    sums.set(key, {
      usd: sum.usd + bucket.costUsd,
      tokens: sum.tokens + bucketTokens(bucket) - bucketUnpricedTokens(bucket),
    });
  }
  return new Map(
    [...sums].flatMap(([key, sum]) => (sum.tokens > 0 ? [[key, sum.usd / sum.tokens]] : [])),
  );
}

export interface EstimateTurn {
  readonly model?: string | undefined;
  readonly endedAtMs: number | null;
  readonly turnTokenUsage?: TurnTokenUsage | undefined;
}

/** A bot's estimate for one day: priced tokens in dollars, plus the tokens no rate covers. */
export function botEstimate(input: {
  readonly turns: ReadonlyArray<EstimateTurn>;
  readonly fallbackModel: string;
  /** The bot's provider; null when its instance is unknown, so nothing gets a rate. */
  readonly provider: UsageProviderKind | null;
  readonly day: string;
  readonly timeZone: string;
  readonly rates: ReadonlyMap<string, number>;
}): { readonly usd: number; readonly unpricedTokens: number } | null {
  const dayOf = new Intl.DateTimeFormat("en-CA", { timeZone: input.timeZone });
  let usd = 0;
  let unpricedTokens = 0;
  let counted = false;
  for (const turn of input.turns) {
    const usage = turn.turnTokenUsage;
    if (usage === undefined || turn.endedAtMs === null) continue;
    if (dayOf.format(turn.endedAtMs) !== input.day) continue;
    const tokens =
      (usage.inputTokens ?? 0) +
      (usage.outputTokens ?? 0) +
      (usage.otherUsage?.inputTokens ?? 0) +
      (usage.otherUsage?.outputTokens ?? 0);
    if (tokens === 0) continue;
    counted = true;
    const model = usage.models?.[0] ?? turn.model ?? input.fallbackModel;
    const rate =
      input.provider === null ? undefined : input.rates.get(rateKey(input.provider, model));
    if (rate === undefined) unpricedTokens += tokens;
    else usd += tokens * rate;
  }
  return counted ? { usd, unpricedTokens } : null;
}

export interface RulerTick {
  readonly at: number;
  readonly filled: boolean;
  readonly major: boolean;
}

/** 26 marks from 0 to the cap; those up to the value are filled, every fifth is taller. */
export function rulerTicks(valueUsd: number, capUsd: number, steps = 25): RulerTick[] {
  return Array.from({ length: steps + 1 }, (_, index) => ({
    at: (index * capUsd) / steps,
    filled: valueUsd > 0 && (index * capUsd) / steps <= valueUsd,
    major: index % 5 === 0,
  }));
}
