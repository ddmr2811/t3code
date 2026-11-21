// Fork-only: four chart cards, dithered: the last week's spend, the room left in a subscription
// limit over the last day, this month's tokens by provider and the turns per day. Shown under the
// composer of a new thread and as a Dashboard panel.
import { useAtomValue } from "@effect/atom-react";
import type { UsageProviderKind } from "@t3tools/contracts";
import { formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import { collectLimitAccounts, type LimitAccount } from "@t3tools/shared/usageLimits";
import { formatResetsIn } from "@t3tools/shared/usageLimitsCopy";
import { ActivityIcon, ChartColumnBigIcon, ChartSplineIcon, GaugeIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { observeResize } from "../../lib/observeResize";

import { PROVIDER_ORDER, PROVIDER_PRESENTATION } from "../../components/usage/usageProviders";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { useClientSettings } from "../../hooks/useSettings";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { environmentPresentations } from "../../state/presentation";
import { formatRelativeTimeLabel, formatShortTimestamp } from "../../timestampFormat";
import { spendReadAt, windowRemaining } from "../dashboard/dashboard.logic";
import {
  DitherBackdrop,
  DotBars,
  DotHeatmap,
  DotLine,
  DotStack,
  PITCH,
  SERIES_TONES,
  heatWeeksFor,
  toneColor,
  useMeasuredWidth,
} from "./DitherChart";
import {
  collectingSince,
  dotRows,
  heatGrid,
  type HeroFit,
  heroFit,
  lastDays,
  monthDays,
  primaryWindow,
  providerLayers,
  remainingLine,
  seriesForAccount,
  spendByDay,
  stackLayers,
  sumActivity,
} from "./widgets.logic";
import { LIMIT_HISTORY_HOURS, useActivity, useLimitHistories, useWidgetUsage } from "./widgetsData";

const caption = "font-mono text-3xs uppercase tracking-widest text-muted-foreground";

function WidgetCard(props: {
  readonly icon: ReactNode;
  readonly title: ReactNode;
  readonly meta?: ReactNode;
  readonly footer?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="relative flex min-h-48 min-w-0 flex-col gap-2.5 rounded-xl border bg-card/90 p-3.5">
      <header className="flex min-h-6 min-w-0 items-center gap-2">
        <span aria-hidden className="text-muted-foreground [&_svg]:size-3.5">
          {props.icon}
        </span>
        <h3 className="min-w-0 truncate font-medium text-sm">{props.title}</h3>
        {props.meta ? <span className={cn("ms-auto shrink-0", caption)}>{props.meta}</span> : null}
      </header>
      {props.children}
      {props.footer ? (
        <footer className={cn("mt-auto flex items-center justify-between gap-3", caption)}>
          {props.footer}
        </footer>
      ) : null}
    </section>
  );
}

function Figure(props: {
  readonly value: ReactNode;
  readonly caption: ReactNode;
  readonly side?: ReactNode;
}) {
  return (
    <div className="flex items-end justify-between gap-3">
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-medium text-2xl tabular-nums tracking-tight">
          {props.value}
        </span>
        <span className="truncate text-muted-foreground text-xs">{props.caption}</span>
      </div>
      {props.side ? (
        <div className="flex shrink-0 flex-col items-end font-mono text-muted-foreground text-xs tabular-nums">
          {props.side}
        </div>
      ) : null}
    </div>
  );
}

function Quiet(props: { readonly children: ReactNode }) {
  return (
    <p className="flex flex-1 items-center justify-center text-center text-muted-foreground text-xs">
      {props.children}
    </p>
  );
}

const weekday = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });

const shortDay = (day: string) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

type WidgetUsage = ReturnType<typeof useWidgetUsage>;

const SPEND_ROWS = 22;
/** Servers sample limits this often. */
const LINE_STEP_MS = 5 * 60_000;

function SpendCard(props: { readonly data: WidgetUsage; readonly nowMs: number }) {
  const [ref, width] = useMeasuredWidth();
  const { usage, untilDay } = props.data;
  const merged = usage.shown?.merged ?? usage.merged;
  const days = spendByDay(merged.daily, lastDays(untilDay, 7));
  const total = days.reduce((sum, day) => sum + day.costUsd, 0);
  const tokens = days.reduce((sum, day) => sum + day.tokens, 0);
  const today = days.at(-1);
  const loading = usage.isPending && usage.shown === null;
  const readAt = spendReadAt(usage.environments);
  return (
    <WidgetCard
      icon={<ChartColumnBigIcon />}
      title="Spend"
      meta="Est. USD"
      footer={
        <>
          <span>7-day spend</span>
          <span>{readAt ? `Updated ${formatRelativeTimeLabel(readAt, props.nowMs)}` : null}</span>
        </>
      }
    >
      <Figure
        value={loading ? "…" : formatUsd(total)}
        caption="List price, all machines"
        side={
          loading ? null : (
            <>
              <span>{formatTokens(tokens)} tokens</span>
              <span>Today {formatUsd(today?.costUsd ?? 0)}</span>
            </>
          )
        }
      />
      <div ref={ref} className="flex flex-col gap-1">
        <DotBars
          rows={dotRows(
            days.map((day) => day.costUsd),
            SPEND_ROWS,
          )}
          totalRows={SPEND_ROWS}
          width={width}
          highlight={days.length - 1}
          titles={days.map((day) => `${shortDay(day.day)}: ${formatUsd(day.costUsd)}`)}
        />
        <div
          className={cn("grid text-center", caption)}
          style={{ gridTemplateColumns: `repeat(${Math.max(1, days.length)}, minmax(0, 1fr))` }}
        >
          {days.map((day) => (
            <span key={day.day}>{weekday(day.day)}</span>
          ))}
        </div>
      </div>
    </WidgetCard>
  );
}

const accountName = (account: LimitAccount) =>
  account.displayName ?? account.email ?? String(account.driver);

function LimitCard(props: { readonly nowMs: number }) {
  const [ref, width] = useMeasuredWidth();
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const accounts = collectLimitAccounts(presentations).filter(
    (account) => primaryWindow(account.limits.windows) !== null,
  );
  const { histories, unsupported } = useLimitHistories();
  const [chosen, setChosen] = useState<string | null>(null);
  // Until one is picked, the account closest to its limit.
  const tightest = accounts.toSorted(
    (left, right) =>
      windowRemaining(primaryWindow(left.limits.windows)!).percent -
      windowRemaining(primaryWindow(right.limits.windows)!).percent,
  )[0];
  const account = accounts.find((entry) => entry.key === chosen) ?? tightest ?? null;
  const limitWindow = account ? primaryWindow(account.limits.windows) : null;

  if (account === null || limitWindow === null) {
    return (
      <WidgetCard icon={<GaugeIcon />} title="Limits">
        <Quiet>No subscription limits reported.</Quiet>
      </WidgetCard>
    );
  }
  const { percent, low } = windowRemaining(limitWindow);
  const resets = formatResetsIn(limitWindow, props.nowMs);
  // The range moves on the sample grid, not each minute, so the line redraws only when a sample can land.
  const untilMs = Math.ceil(props.nowMs / LINE_STEP_MS) * LINE_STEP_MS;
  const sinceMs = untilMs - LIMIT_HISTORY_HOURS * 60 * 60_000;
  const line = remainingLine(
    seriesForAccount(account, histories),
    limitWindow.id,
    sinceMs,
    untilMs,
  );
  const started = collectingSince(histories.map((entry) => entry.history));
  const collecting = started !== null && started > sinceMs;
  const title =
    accounts.length > 1 ? (
      <Select
        value={account.key}
        onValueChange={(value) => {
          if (typeof value === "string") setChosen(value);
        }}
      >
        <SelectTrigger size="xs" variant="ghost" aria-label="Account shown">
          <SelectValue>
            {(value: string | null) =>
              accountName(accounts.find((entry) => entry.key === value) ?? account)
            }
          </SelectValue>
        </SelectTrigger>
        <SelectPopup align="start" alignItemWithTrigger={false}>
          {accounts.map((entry) => (
            <SelectItem key={entry.key} value={entry.key}>
              {accountName(entry)}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    ) : (
      accountName(account)
    );
  return (
    <WidgetCard
      icon={<GaugeIcon />}
      title={title}
      meta={resets ? <span className={cn(low && "text-warning-foreground")}>{resets}</span> : null}
      footer={
        <>
          <span>
            {unsupported
              ? "History needs a fork server"
              : collecting
                ? `Collecting since ${formatShortTimestamp(new Date(started).toISOString(), timestampFormat)}`
                : "Last 24 hours"}
          </span>
          <span>Remaining</span>
        </>
      }
    >
      <Figure
        value={<span className={cn(low && "text-warning-foreground")}>{percent}% remaining</span>}
        caption={limitWindow.label}
        side={<span>Updated {formatRelativeTimeLabel(account.limits.checkedAt, props.nowMs)}</span>}
      />
      <div ref={ref} className="relative mt-auto">
        <DotLine
          points={line}
          width={width}
          height={SPEND_ROWS * PITCH}
          tone={low ? "warning" : "accent"}
        />
        {line.length < 2 && !unsupported ? (
          <span className={cn("absolute inset-0 flex items-center justify-center", caption)}>
            {started === null ? "Collecting from the next sample" : "Collecting…"}
          </span>
        ) : null}
      </div>
    </WidgetCard>
  );
}

const providerLabel = (provider: UsageProviderKind) => PROVIDER_PRESENTATION[provider].label;

function UsageCard(props: { readonly data: WidgetUsage }) {
  const [ref, width] = useMeasuredWidth();
  const { usage, untilDay } = props.data;
  const merged = usage.shown?.merged ?? usage.merged;
  const days = monthDays(untilDay);
  const layers = providerLayers(merged.daily, days).toSorted(
    (left, right) =>
      right.total - left.total ||
      PROVIDER_ORDER.indexOf(left.provider) - PROVIDER_ORDER.indexOf(right.provider),
  );
  const total = layers.reduce((sum, layer) => sum + layer.total, 0);
  const loading = usage.isPending && usage.shown === null;
  const middle = days[Math.floor((days.length - 1) / 2)];
  return (
    <WidgetCard
      icon={<ChartSplineIcon />}
      title="Usage"
      meta={loading ? null : `${formatTokens(total)} this month`}
    >
      {layers.length === 0 ? (
        <Quiet>{loading ? "Reading usage…" : "No tokens this month yet."}</Quiet>
      ) : (
        <>
          <div ref={ref} className="flex flex-col gap-1">
            <DotStack
              tops={stackLayers(layers)}
              tones={layers.map((_, index) => SERIES_TONES[index % SERIES_TONES.length]!)}
              width={width}
              height={24 * PITCH}
            />
            <div className={cn("flex justify-between", caption)}>
              <span>{days[0] ? shortDay(days[0]) : null}</span>
              {days.length > 2 && middle ? <span>{shortDay(middle)}</span> : null}
              <span>{days.at(-1) ? shortDay(days.at(-1)!) : null}</span>
            </div>
          </div>
          <ul className="mt-auto flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {layers.map((layer, index) => (
              <li key={layer.provider} className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="size-2 rounded-xs"
                  style={{ backgroundColor: toneColor(SERIES_TONES[index % SERIES_TONES.length]!) }}
                />
                {providerLabel(layer.provider)}
                <span className="font-mono text-muted-foreground tabular-nums">
                  {formatTokens(layer.total)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </WidgetCard>
  );
}

function ActivityCard(props: { readonly today: string; readonly timeZone: string }) {
  const [ref, width] = useMeasuredWidth();
  const { readings, pending, unsupported } = useActivity();
  const weeks = heatWeeksFor(width);
  const grid = heatGrid(sumActivity(readings, props.timeZone), props.today, weeks);
  return (
    <WidgetCard
      icon={<ActivityIcon />}
      title="Activity"
      meta={readings.length > 0 ? `${grid.total.toLocaleString("en-US")} turns` : null}
      footer={
        <>
          <span>{`Last ${weeks} weeks`}</span>
          <span>{pending > 0 ? "Counting…" : "All machines"}</span>
        </>
      }
    >
      <div ref={ref} className="flex min-h-0 flex-1 items-center">
        {unsupported ? (
          <Quiet>Activity needs a fork server.</Quiet>
        ) : width > 0 ? (
          <DotHeatmap grid={grid} width={width} />
        ) : null}
      </div>
    </WidgetCard>
  );
}

/** `hero` sits under a new thread's composer, laid out by `fit`; `panel` fills a Dashboard row. */
export function ForkWidgetGrid(props: {
  readonly variant: "hero" | "panel";
  readonly fit?: HeroFit;
}) {
  // The minute tick is UTC without a zone suffix; it refreshes the relative labels.
  const nowMs = Date.parse(`${useNowMinute()}:00Z`);
  const data = useWidgetUsage();
  const cards = props.fit?.cards ?? 4;
  return (
    <div
      className={cn(
        "relative grid gap-3",
        props.variant === "panel" && "md:grid-cols-2 2xl:grid-cols-4",
      )}
      style={
        props.fit
          ? { gridTemplateColumns: `repeat(${props.fit.columns}, minmax(0, 1fr))` }
          : undefined
      }
    >
      {props.variant === "hero" ? (
        <div className="-inset-x-24 -inset-y-10 absolute -z-10">
          <DitherBackdrop />
        </div>
      ) : null}
      <SpendCard data={data} nowMs={nowMs} />
      <LimitCard nowMs={nowMs} />
      {cards === 4 ? <ActivityCard today={data.untilDay} timeZone={data.timeZone} /> : null}
      {cards === 4 ? <UsageCard data={data} /> : null}
    </div>
  );
}

/** The room under the composer and the lane's width, kept current as either changes. */
function useHeroFit(): readonly [(element: HTMLElement | null) => () => void, HeroFit | null] {
  const [fit, setFit] = useState<HeroFit | null>(null);
  const ref = (element: HTMLElement | null) => {
    const composer = element?.parentElement;
    const overlay = element?.closest("[data-chat-composer-overlay]");
    const lane = element?.closest(".chat-composer-lane");
    if (!element || !composer || !overlay || !lane) return () => undefined;
    const measure = () => {
      const style = getComputedStyle(lane);
      const laneWidth =
        lane.clientWidth -
        parseFloat(style.paddingInlineStart) -
        parseFloat(style.paddingInlineEnd);
      const next = heroFit({
        below: overlay.getBoundingClientRect().bottom - composer.getBoundingClientRect().bottom,
        laneWidth,
        composerWidth: composer.clientWidth,
      });
      setFit((previous) =>
        previous?.columns === next?.columns &&
        previous?.cards === next?.cards &&
        previous?.width === next?.width
          ? previous
          : next,
      );
    };
    return observeResize([overlay, composer], measure);
  };
  return [ref, fit] as const;
}

/** Under a new thread's composer, out of its way: below it, and only as much as the window holds. */
export function ForkNewThreadWidgets() {
  const enabled = useClientSettings((settings) => settings.forkNewThreadWidgets);
  // Not mounted at all on narrow windows, so hidden cards never ask for data.
  const wide = useMediaQuery("md");
  const [ref, fit] = useHeroFit();
  if (!enabled || !wide) return null;
  return (
    <div
      ref={ref}
      className="absolute start-1/2 top-full -translate-x-1/2 pt-8 rtl:translate-x-1/2"
      style={{ width: fit?.width ?? "100%" }}
    >
      {fit ? <ForkWidgetGrid variant="hero" fit={fit} /> : null}
    </div>
  );
}
