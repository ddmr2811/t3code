// Fork-only: what the dithered charts draw, as pure functions: day series, dot columns, stacked
// layers, the limit line and the activity grid. Rendering lives in DitherChart.tsx.
import type {
  ForkActivity,
  ForkLimitHistory,
  ForkLimitHistorySeries,
  ServerProviderUsageWindow,
  UsageProviderKind,
} from "@t3tools/contracts";
import type { LimitAccount } from "@t3tools/shared/usageLimits";
import type { DailyTotals } from "@t3tools/shared/usageMerge";

const DAY_MS = 24 * 60 * 60_000;

const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** `count` calendar days ending at `untilDay`, oldest first. */
export function lastDays(untilDay: string, count: number): ReadonlyArray<string> {
  const end = dayMs(untilDay);
  if (!Number.isFinite(end) || count <= 0) return [];
  return Array.from({ length: count }, (_, index) => dayOf(end - (count - 1 - index) * DAY_MS));
}

/** Days from the first of `untilDay`'s month to it. */
export function monthDays(untilDay: string): ReadonlyArray<string> {
  const dayOfMonth = Number(untilDay.slice(8, 10));
  return Number.isInteger(dayOfMonth) && dayOfMonth > 0 ? lastDays(untilDay, dayOfMonth) : [];
}

const finite = (value: number) => (Number.isFinite(value) && value > 0 ? value : 0);

/**
 * How many dot rows each value fills, out of `rows`, against the largest value. Any spend at all
 * shows one row, so a small day is never mistaken for none; nothing goes past the top.
 */
export function dotRows(values: ReadonlyArray<number>, rows: number): ReadonlyArray<number> {
  const clean = values.map(finite);
  const max = Math.max(0, ...clean);
  if (max === 0 || rows <= 0) return clean.map(() => 0);
  return clean.map((value) =>
    value === 0 ? 0 : Math.min(rows, Math.max(1, Math.round((value / max) * rows))),
  );
}

export interface SpendDay {
  readonly day: string;
  readonly costUsd: number;
  readonly tokens: number;
}

/** Every one of `days`, empty days included, from the merged daily totals. */
export function spendByDay(
  daily: ReadonlyArray<DailyTotals>,
  days: ReadonlyArray<string>,
): ReadonlyArray<SpendDay> {
  const byDay = new Map(daily.map((entry) => [entry.day, entry]));
  return days.map((day) => {
    const entry = byDay.get(day);
    return { day, costUsd: finite(entry?.costUsd ?? 0), tokens: finite(entry?.totalTokens ?? 0) };
  });
}

export interface ProviderLayer {
  readonly provider: UsageProviderKind;
  readonly total: number;
  /** Tokens per day, in the order of the days asked for. */
  readonly values: ReadonlyArray<number>;
}

/** Tokens per provider per day, biggest provider first: the bottom layer of the stack. */
export function providerLayers(
  daily: ReadonlyArray<DailyTotals>,
  days: ReadonlyArray<string>,
): ReadonlyArray<ProviderLayer> {
  const byDay = new Map(daily.map((entry) => [entry.day, entry]));
  const providers = new Set<UsageProviderKind>();
  for (const day of days) {
    for (const provider of byDay.get(day)?.byProvider.keys() ?? []) providers.add(provider);
  }
  return [...providers]
    .map((provider) => {
      const values = days.map((day) =>
        finite(byDay.get(day)?.byProvider.get(provider)?.totalTokens ?? 0),
      );
      return { provider, values, total: values.reduce((sum, value) => sum + value, 0) };
    })
    .filter((layer) => layer.total > 0)
    .toSorted((left, right) => right.total - left.total);
}

/** Running totals bottom up: `stack[layer][day]` is the top of that layer on that day. */
export function stackLayers(
  layers: ReadonlyArray<ProviderLayer>,
): ReadonlyArray<ReadonlyArray<number>> {
  const tops: number[][] = [];
  layers.forEach((layer, index) => {
    tops.push(layer.values.map((value, day) => value + (index > 0 ? tops[index - 1]![day]! : 0)));
  });
  return tops;
}

/** The window a limit card follows: the weekly one, else the session one, else the first. */
export function primaryWindow(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
): ServerProviderUsageWindow | null {
  return (
    windows.find((window) => window.kind === "weekly") ??
    windows.find((window) => window.kind === "session") ??
    windows[0] ??
    null
  );
}

const sameText = (left: string | null | undefined, right: string | null | undefined) =>
  !!left && !!right && left.trim().toLowerCase() === right.trim().toLowerCase();

/**
 * The series that belong to an account, from every server that reads it: the same login by
 * e-mail or credential, else the very provider instance the account came from.
 */
export function seriesForAccount(
  account: Pick<LimitAccount, "driver" | "email" | "key" | "limits">,
  histories: ReadonlyArray<{ readonly environmentId: string; readonly history: ForkLimitHistory }>,
): ReadonlyArray<ForkLimitHistorySeries> {
  const fingerprint = account.limits.credentialFingerprint;
  return histories.flatMap(({ environmentId, history }) =>
    history.series.filter((series) => {
      if (series.driver !== account.driver) return false;
      if (sameText(series.email, account.email)) return true;
      if (fingerprint && series.credentialFingerprint === fingerprint) return true;
      return (
        series.key.startsWith("native:") &&
        account.key === `${environmentId}:${series.key.slice(7)}`
      );
    }),
  );
}

export interface LinePoint {
  /** 0 at the start of the range, 1 at its end. */
  readonly x: number;
  /** Share of the window left, 0 to 1. */
  readonly y: number;
}

/**
 * Room left over `[sinceMs, untilMs]` in the window `windowId` (ids are the provider's, so the
 * same on every server), from every series' samples merged by time. A sample before the range
 * starts the line at its left edge.
 */
export function remainingLine(
  series: ReadonlyArray<ForkLimitHistorySeries>,
  windowId: string,
  sinceMs: number,
  untilMs: number,
): ReadonlyArray<LinePoint> {
  const span = untilMs - sinceMs;
  if (!(span > 0)) return [];
  const points = series
    .flatMap((entry) => entry.windows.filter((window) => window.id === windowId))
    .flatMap((window) => window.points)
    .toSorted((left, right) => left[0] - right[0]);
  const firstInside = points.findIndex((point) => point[0] >= sinceMs);
  const start = firstInside === -1 ? points.length - 1 : Math.max(0, firstInside - 1);
  return points.slice(Math.max(0, start)).map(([atMs, used]) => ({
    // `untilMs` is the minute shown; a sample taken since then still belongs at the right edge.
    x: Math.max(0, Math.min(1, (atMs - sinceMs) / span)),
    y: Math.max(0, Math.min(1, (100 - used) / 100)),
  }));
}

/** The earliest server that started collecting, so the label never claims more than it has. */
export function collectingSince(histories: ReadonlyArray<ForkLimitHistory>): number | null {
  const starts = histories.flatMap((history) =>
    history.collectingSince === null ? [] : [history.collectingSince],
  );
  return starts.length === 0 ? null : Math.min(...starts);
}

/** Turns per day added up across machines. */
export function sumActivity(readings: ReadonlyArray<ForkActivity>): ReadonlyMap<string, number> {
  const totals = new Map<string, number>();
  for (const reading of readings) {
    for (const entry of reading.days) {
      totals.set(entry.day, (totals.get(entry.day) ?? 0) + finite(entry.turns));
    }
  }
  return totals;
}

export interface HeatCell {
  readonly day: string;
  readonly count: number;
  /** 0 for none, 1 to 4 by share of the busiest day. */
  readonly level: 0 | 1 | 2 | 3 | 4;
}

export interface HeatGrid {
  /** One column per week, Monday first; days after today are null. */
  readonly weeks: ReadonlyArray<ReadonlyArray<HeatCell | null>>;
  /** A month's short name over the first week that starts in it. */
  readonly months: ReadonlyArray<{ readonly week: number; readonly label: string }>;
  readonly total: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The last `weekCount` weeks up to `today`, in the shape of a contribution grid. */
export function heatGrid(
  counts: ReadonlyMap<string, number>,
  today: string,
  weekCount: number,
): HeatGrid {
  const todayMs = dayMs(today);
  if (!Number.isFinite(todayMs) || weekCount <= 0) return { weeks: [], months: [], total: 0 };
  const mondayOffset = (new Date(todayMs).getUTCDay() + 6) % 7;
  const firstMs = todayMs - (mondayOffset + (weekCount - 1) * 7) * DAY_MS;
  let max = 0;
  let total = 0;
  for (let index = 0; index < weekCount * 7; index += 1) {
    const atMs = firstMs + index * DAY_MS;
    if (atMs > todayMs) break;
    const count = finite(counts.get(dayOf(atMs)) ?? 0);
    max = Math.max(max, count);
    total += count;
  }
  const weeks: (HeatCell | null)[][] = [];
  const months: { week: number; label: string }[] = [];
  for (let week = 0; week < weekCount; week += 1) {
    const column: (HeatCell | null)[] = [];
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const atMs = firstMs + (week * 7 + weekday) * DAY_MS;
      if (atMs > todayMs) {
        column.push(null);
        continue;
      }
      const day = dayOf(atMs);
      const count = finite(counts.get(day) ?? 0);
      const level =
        count === 0 || max === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((count / max) * 4)));
      column.push({ day, count, level: level as HeatCell["level"] });
      if (weekday === 0 && Number(day.slice(8, 10)) <= 7) {
        months.push({ week, label: MONTHS[Number(day.slice(5, 7)) - 1]! });
      }
    }
    weeks.push(column);
  }
  return { weeks, months, total };
}

export interface HeroFit {
  readonly columns: 2 | 4;
  readonly cards: 2 | 4;
  /** The grid's width in pixels; wider than the composer for a single row of four. */
  readonly width: number;
}

const HERO_TOP = 32;
const HERO_ROW = 236;
const HERO_GAP = 12;
const HERO_BOTTOM = 16;
const HERO_MAX_WIDTH = 1440;
const HERO_MIN_CARD = 300;

/**
 * How the cards fit under a new thread's composer without covering anything or running off the
 * window: two rows at the composer's width, else one row of four as wide as the lane allows,
 * else one row of two, else none.
 */
export function heroFit(input: {
  readonly below: number;
  readonly laneWidth: number;
  readonly composerWidth: number;
}): HeroFit | null {
  const room = input.below - HERO_TOP - HERO_BOTTOM;
  if (room >= 2 * HERO_ROW + HERO_GAP) {
    return { columns: 2, cards: 4, width: input.composerWidth };
  }
  if (room < HERO_ROW) return null;
  const wide = Math.min(input.laneWidth, HERO_MAX_WIDTH);
  if (wide >= 4 * HERO_MIN_CARD + 3 * HERO_GAP) return { columns: 4, cards: 4, width: wide };
  return { columns: 2, cards: 2, width: input.composerWidth };
}
