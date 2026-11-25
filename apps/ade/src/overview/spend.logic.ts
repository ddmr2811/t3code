import {
  USAGE_CONTRACT_VERSION,
  type TurnTokenUsage,
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
 * `real`: pay-per-use money. `flat`: a subscription with a limit, so its list price is not paid.
 * `unpriced`: no rate is known, which is not the same as free.
 */
export type SpendKind = "real" | "flat" | "unpriced";

export interface SpendLine {
  readonly provider: UsageProviderKind;
  readonly model: string;
  readonly kind: SpendKind;
  readonly costUsd: number;
  readonly tokens: number;
}

export interface SpendPeriod {
  /** Only `real` lines add up here; flat and unpriced lines never do. */
  readonly realUsd: number;
  readonly lines: ReadonlyArray<SpendLine>;
}

const KIND_ORDER: Record<SpendKind, number> = { real: 0, flat: 1, unpriced: 2 };

function period(
  environments: ReadonlyArray<EnvironmentUsage>,
  flat: ReadonlySet<UsageProviderKind>,
): SpendPeriod {
  const lines = mergeUsage(environments, USAGE_CONTRACT_VERSION)
    .models.filter((model) => model.totalTokens > 0)
    .map((model): SpendLine => {
      const kind = flat.has(model.provider)
        ? "flat"
        : isModelCostUnknown(model)
          ? "unpriced"
          : "real";
      return {
        provider: model.provider,
        model: model.model,
        kind,
        costUsd: kind === "real" ? model.costUsd : 0,
        tokens: model.totalTokens,
      };
    })
    .toSorted(
      (a, b) =>
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || b.costUsd - a.costUsd || b.tokens - a.tokens,
    );
  return { realUsd: lines.reduce((sum, line) => sum + line.costUsd, 0), lines };
}

/** Today's and this week's spend across machines; shared transcript folders count once. */
export function spendSummary(
  environments: ReadonlyArray<EnvironmentUsage>,
  flat: ReadonlySet<UsageProviderKind>,
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
  return { today: period(todayOnly, flat), week: period(environments, flat) };
}

/**
 * The list price per token of each model, from this week's priced records. A bot's turn tokens
 * times this rate is its estimate, so it follows the server's `usagePricing` without asking for it.
 */
export function ratesByModel(
  environments: ReadonlyArray<EnvironmentUsage>,
): ReadonlyMap<string, number> {
  const rates = new Map<string, number>();
  for (const model of mergeUsage(environments, USAGE_CONTRACT_VERSION).models) {
    const pricedTokens = model.totalTokens - model.unpricedTokens;
    if (isModelCostUnknown(model) || pricedTokens <= 0) continue;
    rates.set(model.model, model.costUsd / pricedTokens);
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
    const rate = input.rates.get(usage.models?.[0] ?? turn.model ?? input.fallbackModel);
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
