// Fork-only: the charts' data. Spend and tokens come from the usage summaries every machine already
// answers; limits are pushed with each server's config; the limit history and the activity are
// the fork servers' own reads, asked for only while a chart is on screen.
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import {
  AuthDiagnosticsReadScope,
  type EnvironmentId,
  type ForkActivity,
  type ForkLimitHistory,
  type UsageSummaryInput,
  WS_METHODS,
} from "@t3tools/contracts";
import { makeWindow } from "@t3tools/shared/usageFormat";
import { AsyncResult, Atom } from "effect/reactivity";
import { useContext, useState } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { environmentPresentations } from "../../state/presentation";
import { useEnvironmentsWithScope } from "../../state/session";
import { useUsage } from "../../state/usage";
import { useVisibleInterval } from "../dashboard/visibleInterval";

/** The transcript scan behind spend and tokens is costly, so it repeats rarely. */
const WIDGET_USAGE_REFRESH_MS = 10 * 60_000;
/** Servers sample limits every five minutes; reading faster would show nothing new. */
const LIMIT_HISTORY_REFRESH_MS = 5 * 60_000;
/** The server keeps its count half an hour; asking sooner reads the same one. */
const ACTIVITY_REFRESH_MS = 30 * 60_000;
export const LIMIT_HISTORY_HOURS = 24;
/** A year of weeks; the grid shows as many as fit. */
const ACTIVITY_DAYS = 371;

/** Kept a few minutes after the last chart closes, so reopening a new thread reads no more. */
const KEEP_MS = 5 * 60_000;

const limitHistoryQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:fork-insights:limit-history",
  tag: WS_METHODS.forkInsightsLimitHistory,
  idleTtlMs: KEEP_MS,
  staleTimeMs: 60_000,
});

const activityQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:fork-insights:activity",
  tag: WS_METHODS.forkInsightsActivity,
  idleTtlMs: KEEP_MS,
  staleTimeMs: 60_000,
});

const limitHistoryOf = (environmentId: EnvironmentId) =>
  limitHistoryQuery({ environmentId, input: { hours: LIMIT_HISTORY_HOURS } });

const activityOf = (environmentId: EnvironmentId) =>
  activityQuery({ environmentId, input: { days: ACTIVITY_DAYS } });

export interface EnvironmentLimitHistory {
  readonly environmentId: EnvironmentId;
  readonly history: ForkLimitHistory;
}

const limitHistoriesAtom = Atom.family((key: string) =>
  Atom.make((get): ReadonlyArray<EnvironmentLimitHistory> =>
    (JSON.parse(key) as ReadonlyArray<EnvironmentId>).flatMap((environmentId) => {
      const history = AsyncResult.getOrElse(
        get(limitHistoryOf(environmentId)),
        (): ForkLimitHistory | null => null,
      );
      return history === null ? [] : [{ environmentId, history }];
    }),
  ).pipe(Atom.withLabel(`fork-widgets:limit-history:${key}`)),
);

interface ActivityReadings {
  readonly readings: ReadonlyArray<ForkActivity>;
  /** Machines asked that have not answered yet. */
  readonly pending: number;
}

const activitiesAtom = Atom.family((key: string) =>
  Atom.make((get): ActivityReadings => {
    const ids = JSON.parse(key) as ReadonlyArray<EnvironmentId>;
    let pending = 0;
    const readings = ids.flatMap((environmentId) => {
      const result = get(activityOf(environmentId));
      const value = AsyncResult.getOrElse(result, (): ForkActivity | null => null);
      if (value === null && result.waiting) pending += 1;
      return value === null ? [] : [value];
    });
    return { readings, pending };
  }).pipe(Atom.withLabel(`fork-widgets:activity:${key}`)),
);

/** Connected fork servers this client may read diagnostics from. */
function useInsightEnvironments(): ReadonlyArray<EnvironmentId> {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const candidates = [...presentations]
    .filter(
      ([, presentation]) =>
        presentation.entry.enabled &&
        presentation.connection.phase === "connected" &&
        (presentation.serverConfig?.environment.capabilities.forkInsights ?? 0) >= 1,
    )
    .map(([environmentId]) => ({ environmentId }));
  const readable = useEnvironmentsWithScope(candidates, AuthDiagnosticsReadScope);
  return candidates
    .map(({ environmentId }) => environmentId)
    .filter((environmentId) => readable.has(environmentId))
    .toSorted();
}

export function useLimitHistories(): {
  readonly histories: ReadonlyArray<EnvironmentLimitHistory>;
  /** No machine here keeps a history: an upstream or older server. */
  readonly unsupported: boolean;
} {
  const registry = useContext(RegistryContext);
  const environmentIds = useInsightEnvironments();
  const histories = useAtomValue(limitHistoriesAtom(JSON.stringify(environmentIds)));
  useVisibleInterval(() => {
    for (const environmentId of environmentIds) registry.refresh(limitHistoryOf(environmentId));
  }, LIMIT_HISTORY_REFRESH_MS);
  return { histories, unsupported: environmentIds.length === 0 };
}

export function useActivity(): ActivityReadings & { readonly unsupported: boolean } {
  const registry = useContext(RegistryContext);
  const environmentIds = useInsightEnvironments();
  const activity = useAtomValue(activitiesAtom(JSON.stringify(environmentIds)));
  useVisibleInterval(() => {
    for (const environmentId of environmentIds) registry.refresh(activityOf(environmentId));
  }, ACTIVITY_REFRESH_MS);
  return { ...activity, unsupported: environmentIds.length === 0 };
}

/** Enough days for both the last week and this month, so one scan answers both charts. */
function widgetUsageWindow(now: Date): UsageSummaryInput {
  const today = makeWindow(1, now);
  const dayOfMonth = Number(today.untilDay.slice(8, 10)) || 1;
  return makeWindow(Math.max(7, dayOfMonth), now);
}

/** The usage summary the spend and provider charts share, moved forward when the day changes. */
export function useWidgetUsage() {
  const [usageWindow, setUsageWindow] = useState(() => widgetUsageWindow(new Date()));
  const usage = useUsage(usageWindow);
  useVisibleInterval(() => {
    const next = widgetUsageWindow(new Date());
    if (next.untilDay !== usageWindow.untilDay || next.timeZone !== usageWindow.timeZone) {
      setUsageWindow(next);
    } else void usage.refresh();
  }, WIDGET_USAGE_REFRESH_MS);
  return { usage, untilDay: usageWindow.untilDay, timeZone: usageWindow.timeZone };
}
