import {
  type EnvironmentId,
  USAGE_CONTRACT_VERSION,
  type TurnTokenUsage,
  type UsageBucket,
  type UsageProviderKind,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { makeWindow } from "@t3tools/shared/usageFormat";
import { type EnvironmentUsage, isModelCostUnknown, mergeUsage } from "@t3tools/shared/usageMerge";

/** Monday to today in the browser's zone: the week the Gasto card counts. */
export function weekWindow(now?: Date): UsageSummaryInput {
  const { untilDay } = makeWindow(1, now);
  const [year = 0, month = 1, day = 1] = untilDay.split("-").map(Number);
  // 1 January 1970 was a Thursday; Monday is 0 here.
  const mondayBased = (Math.floor(Date.UTC(year, month - 1, day) / 86_400_000) + 3) % 7;
  return makeWindow(mondayBased + 1, now);
}

/**
 * `real`: money the provider reported. `estimated`: tokens at list price, nothing billed.
 * `flat`: a subscription with a limit on that machine, so its list price is not paid.
 * `unpriced`: no rate is known, which is not the same as free.
 */
export type SpendKind = "real" | "estimated" | "flat" | "unpriced";

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
  /** Only reported money; the cap counts this alone. */
  readonly realUsd: number;
  /** List price of tokens nobody billed; shown apart and labelled «est.». */
  readonly estimatedUsd: number;
  readonly lines: ReadonlyArray<SpendLine>;
}

/** Providers each machine pays as a flat subscription. A machine missing here pays per use. */
export type FlatByEnvironment = ReadonlyMap<EnvironmentId, ReadonlySet<UsageProviderKind>>;

const KIND_ORDER: Record<SpendKind, number> = { real: 0, estimated: 1, flat: 2, unpriced: 3 };

// mergeUsage keys models by provider and name. Tagging the name with its kind keeps the kinds
// apart through the merge (shared transcript folders still count once); the tag is cut after.
const KIND_TAG = "\u0000";

function bucketKind(bucket: UsageBucket, flat: boolean): SpendKind {
  if (flat) return "flat";
  if (bucket.costSource === "providerReported") return "real";
  return bucket.costSource === "modelPriced" ? "estimated" : "unpriced";
}

function period(
  environments: ReadonlyArray<EnvironmentUsage>,
  flatByEnvironment: FlatByEnvironment,
): SpendPeriod {
  const tagged = environments.map((environment) => {
    const flat = flatByEnvironment.get(environment.environmentId);
    return {
      ...environment,
      summary: {
        ...environment.summary,
        buckets: environment.summary.buckets.map((bucket) => ({
          ...bucket,
          model: `${bucket.model}${KIND_TAG}${bucketKind(bucket, flat?.has(bucket.provider) === true)}`,
        })),
      },
    };
  });
  const lines = mergeUsage(tagged, USAGE_CONTRACT_VERSION)
    .models.filter((model) => model.totalTokens > 0)
    .map((model): SpendLine => {
      const [name = model.model, kind = "unpriced"] = model.model.split(KIND_TAG) as [
        string,
        SpendKind,
      ];
      return {
        provider: model.provider,
        model: name,
        kind,
        costUsd: kind === "real" || kind === "estimated" ? model.costUsd : 0,
        tokens: model.totalTokens,
        unpricedTokens: kind === "unpriced" ? model.totalTokens : model.unpricedTokens,
      };
    })
    .toSorted(
      (a, b) =>
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.costUsd - a.costUsd || b.tokens - a.tokens,
    );
  const total = (kind: SpendKind) =>
    lines.reduce((sum, line) => sum + (line.kind === kind ? line.costUsd : 0), 0);
  return { realUsd: total("real"), estimatedUsd: total("estimated"), lines };
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

export const rateKey = (provider: UsageProviderKind, model: string) => `${provider} ${model}`;

/**
 * The list price per token of each provider's model, from this week's priced records. A bot's
 * turn tokens times this rate is its estimate, so it follows the server's `usagePricing`.
 */
export function ratesByModel(
  environments: ReadonlyArray<EnvironmentUsage>,
): ReadonlyMap<string, number> {
  const rates = new Map<string, number>();
  for (const model of mergeUsage(environments, USAGE_CONTRACT_VERSION).models) {
    const pricedTokens = model.totalTokens - model.unpricedTokens;
    if (isModelCostUnknown(model) || pricedTokens <= 0) continue;
    rates.set(rateKey(model.provider, model.model), model.costUsd / pricedTokens);
  }
  return rates;
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
