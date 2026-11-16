// Fork-only: the Dashboard's subscriptions: each account's 5-hour and weekly windows, and the
// last 7 days' spend at list price, from the same atoms as the Usage page.
import { useAtomValue } from "@effect/atom-react";
import type {
  ForkDashboardLayout,
  ServerProviderUsageWindow,
  UsageProviderKind,
} from "@t3tools/contracts";
import { formatCount, formatTokens, formatUsd, makeWindow } from "@t3tools/shared/usageFormat";
import {
  collectLimitAccounts,
  formatResetsIn,
  type LimitAccount,
} from "@t3tools/shared/usageLimits";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { Toggle } from "../../components/ui/toggle";
import { cn } from "../../lib/utils";
import { PROVIDER_ORDER, PROVIDER_PRESENTATION } from "../../components/usage/usageProviders";
import { environmentPresentations } from "../../state/presentation";
import { useUsage } from "../../state/usage";
import {
  currentUsageWindow,
  dashboardSpend,
  type ProviderSpend,
  spendReadAt,
  USAGE_DAYS,
  windowRemaining,
} from "./dashboard.logic";
import { setProviderHidden, visibleProviders } from "./dashboardLayout.logic";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { useVisibleInterval } from "./visibleInterval";
import { DotMeter } from "../widgets/DitherChart";

/** The transcript scan behind the spend is costly, so it repeats rarely; the limits are pushed. */
const USAGE_REFRESH_MS = 10 * 60_000;

const SHOWN_WINDOW_KINDS = new Set<ServerProviderUsageWindow["kind"]>(["session", "weekly"]);

function providerOfDriver(driver: LimitAccount["driver"]): UsageProviderKind | null {
  return PROVIDER_ORDER.find((kind) => PROVIDER_PRESENTATION[kind].driverKind === driver) ?? null;
}

/** Room left in the window: the filled bar is what remains, warned once little does. */
function WindowMeter(props: {
  readonly window: ServerProviderUsageWindow;
  readonly color: string;
  readonly nowMs: number;
  readonly compact: boolean;
}) {
  const { percent, low } = windowRemaining(props.window);
  const resets = formatResetsIn(props.window, props.nowMs);
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-0.5 font-mono text-2xs tabular-nums",
        props.compact ? "w-full" : "w-40",
      )}
    >
      <div className="flex justify-between gap-1">
        <span className="truncate text-muted-foreground">{props.window.label}</span>
        <span className={cn("shrink-0", low && "text-warning-foreground")}>{percent}% left</span>
      </div>
      <DotMeter share={percent / 100} color={low ? "var(--warning)" : props.color} />
      <span className="truncate text-muted-foreground">{resets ?? " "}</span>
    </div>
  );
}

function AccountRow(props: {
  readonly account: LimitAccount;
  readonly color: string;
  readonly nowMs: number;
  readonly compact: boolean;
}) {
  const { account } = props;
  const windows = account.limits.windows.filter((window) => SHOWN_WINDOW_KINDS.has(window.kind));
  const where = account.sourceLabel ?? account.environments.map((entry) => entry.label).join(", ");
  return (
    <li
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-2 border-t first:border-t-0",
        props.compact ? "px-3 py-2" : "px-4 py-2.5",
      )}
    >
      <div className={cn("flex flex-1 flex-col", props.compact ? "min-w-full" : "min-w-40")}>
        <span className="truncate text-sm">
          {account.displayName ?? account.email ?? "Account"}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
          {account.plan ? (
            <span className="shrink-0 rounded-sm border px-1 font-mono">{account.plan}</span>
          ) : null}
          <span className="truncate">{where}</span>
        </span>
      </div>
      <div className={props.compact ? "grid w-full grid-cols-2 gap-3" : "flex gap-3"}>
        {windows.length === 0 ? (
          <span className="text-2xs text-muted-foreground">No 5-hour or weekly window</span>
        ) : (
          windows.map((window) => (
            <WindowMeter
              key={`${window.kind}:${window.id}`}
              window={window}
              color={props.color}
              nowMs={props.nowMs}
              compact={props.compact}
            />
          ))
        )}
      </div>
    </li>
  );
}

function ProviderPanel(props: {
  readonly provider: UsageProviderKind;
  readonly spend: ProviderSpend | null;
  readonly accounts: ReadonlyArray<LimitAccount>;
  readonly nowMs: number;
  readonly compact: boolean;
}) {
  const presentation = PROVIDER_PRESENTATION[props.provider];
  return (
    <section
      aria-label={presentation.label}
      className="flex min-w-0 flex-col rounded-lg border bg-card"
    >
      <header
        className={cn(
          "flex items-baseline gap-2 border-b",
          props.compact ? "px-3 py-2" : "px-4 py-3",
        )}
      >
        <span
          aria-hidden
          className="size-2 shrink-0 self-center rounded-full"
          style={{ backgroundColor: presentation.color }}
        />
        <span className="font-medium text-sm">{presentation.label}</span>
        <span className="text-2xs text-muted-foreground">
          {props.accounts.length} {props.accounts.length === 1 ? "account" : "accounts"}
        </span>
        <span
          className={cn("ms-auto font-mono tabular-nums", props.compact ? "text-sm" : "text-lg")}
        >
          {props.spend ? formatUsd(props.spend.costUsd) : "–"}
        </span>
        {props.compact ? null : <span className="text-2xs text-muted-foreground">list price</span>}
      </header>
      {props.spend && !props.compact ? (
        <p className="border-b px-4 py-1.5 font-mono text-2xs text-muted-foreground tabular-nums">
          {formatCount(props.spend.requests)} requests · {formatTokens(props.spend.tokens)} tokens
        </p>
      ) : null}
      {props.accounts.length > 0 ? (
        <ul className="flex flex-col">
          {props.accounts.map((account) => (
            <AccountRow
              key={account.key}
              account={account}
              color={presentation.color}
              nowMs={props.nowMs}
              compact={props.compact}
            />
          ))}
        </ul>
      ) : (
        <p className="px-4 py-3 text-muted-foreground text-xs">No subscription limits reported.</p>
      )}
    </section>
  );
}

/** In edit mode: which providers the Dashboard shows, as a row of toggles. */
function ProviderChoice(props: {
  readonly providers: ReadonlyArray<UsageProviderKind>;
  readonly layout: ForkDashboardLayout;
  readonly onChange: (layout: ForkDashboardLayout) => void;
}) {
  const hidden = new Set(props.layout.hiddenProviders);
  return (
    <div role="group" aria-label="Providers shown" className="flex flex-wrap items-center gap-1.5">
      <span className="me-1 text-muted-foreground text-xs">Shown</span>
      {props.providers.map((provider) => {
        const presentation = PROVIDER_PRESENTATION[provider];
        return (
          <Toggle
            key={provider}
            variant="outline"
            size="xs"
            pressed={!hidden.has(provider)}
            onPressedChange={(pressed) =>
              props.onChange(setProviderHidden(props.layout, provider, !pressed))
            }
          >
            <span
              aria-hidden
              className="size-1.5 rounded-full"
              style={{ backgroundColor: presentation.color }}
            />
            {presentation.label}
          </Toggle>
        );
      })}
    </div>
  );
}

/** `compact` is the Dashboard column beside a chat: one provider per row, the totals in brief. */
export function DashboardSubscriptions({
  nowMs,
  layout,
  onLayoutChange,
  compact = false,
}: {
  readonly nowMs: number;
  readonly layout: ForkDashboardLayout;
  readonly onLayoutChange?: ((layout: ForkDashboardLayout) => void) | undefined;
  readonly compact?: boolean;
}) {
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  // Kept for the page's life: the usage query is keyed by this window.
  const [usageWindow, setUsageWindow] = useState(() => makeWindow(USAGE_DAYS));
  const usage = useUsage(usageWindow);
  // A new day moves the window, which reads afresh; otherwise read the same days again.
  useVisibleInterval(() => {
    const next = currentUsageWindow(usageWindow, new Date());
    if (next !== usageWindow) setUsageWindow(next);
    else void usage.refresh();
  }, USAGE_REFRESH_MS);
  const merged = usage.shown?.merged ?? usage.merged;
  const labels = new Map(
    usage.environments.map((environment) => [environment.environmentId, environment.label]),
  );
  const spend = dashboardSpend(merged, labels);
  const accounts = collectLimitAccounts(presentations);
  const accountsByProvider = new Map<UsageProviderKind, LimitAccount[]>();
  for (const account of accounts) {
    const provider = providerOfDriver(account.driver);
    if (provider === null) continue;
    accountsByProvider.set(provider, [...(accountsByProvider.get(provider) ?? []), account]);
  }
  const spendByProvider = new Map(spend.providers.map((entry) => [entry.provider, entry]));
  const reported = PROVIDER_ORDER.filter(
    (provider) => accountsByProvider.has(provider) || spendByProvider.has(provider),
  ).toSorted(
    (left, right) =>
      (spendByProvider.get(right)?.costUsd ?? 0) - (spendByProvider.get(left)?.costUsd ?? 0),
  );
  const providers = visibleProviders(reported, layout);
  // With providers hidden, the totals add up the ones shown, so the line matches the panels.
  const totals =
    providers.length === reported.length
      ? spend
      : providers.reduce(
          (sum, provider) => {
            const entry = spendByProvider.get(provider);
            return entry
              ? {
                  costUsd: sum.costUsd + entry.costUsd,
                  requests: sum.requests + entry.requests,
                  tokens: sum.tokens + entry.tokens,
                }
              : sum;
          },
          { costUsd: 0, requests: 0, tokens: 0 },
        );
  const hiddenCount = reported.length - providers.length;
  const loading = usage.isPending && usage.shown === null;
  const readAt = spendReadAt(usage.environments);

  return (
    <div className="flex flex-col gap-3">
      {onLayoutChange && reported.length > 0 ? (
        <ProviderChoice providers={reported} layout={layout} onChange={onLayoutChange} />
      ) : null}
      <p className="flex flex-wrap items-baseline gap-x-1.5 text-muted-foreground text-sm">
        {loading ? (
          "Reading the last 7 days…"
        ) : (
          <>
            <span className="font-mono text-foreground tabular-nums">
              {formatUsd(totals.costUsd)}
            </span>
            {compact ? "last 7 days" : "over the last 7 days"} ·{" "}
            <span className="font-mono tabular-nums">{formatCount(totals.requests)}</span> requests
            {compact ? null : (
              <>
                {" "}
                · <span className="font-mono tabular-nums">{formatTokens(totals.tokens)}</span>{" "}
                tokens
              </>
            )}
            {spend.machines.length > 0 && !compact ? (
              <span className="text-xs">· from {spend.machines.join(", ")}</span>
            ) : null}
            {hiddenCount > 0 ? (
              <span className="text-xs">
                · {hiddenCount} {hiddenCount === 1 ? "provider" : "providers"} hidden
              </span>
            ) : null}
            {usage.isPartial ? (
              <span className="text-xs">· some machines still counting</span>
            ) : null}
            {readAt !== null ? (
              <span className="text-xs">· updated {formatRelativeTimeLabel(readAt, nowMs)}</span>
            ) : null}
          </>
        )}
        <Link to="/usage" className="ms-auto text-xs text-primary hover:underline">
          Open usage →
        </Link>
      </p>
      {providers.length === 0 && !loading ? (
        <p className="text-muted-foreground text-sm">
          {reported.length === 0
            ? "No provider reports usage or limits yet."
            : "Every provider is hidden. Edit the dashboard to show one."}
        </p>
      ) : (
        <div
          className={cn(
            "grid",
            compact ? "gap-2" : "gap-3",
            !compact && providers.length > 1 && "xl:grid-cols-2",
          )}
        >
          {providers.map((provider) => (
            <ProviderPanel
              key={provider}
              provider={provider}
              spend={spendByProvider.get(provider) ?? null}
              accounts={accountsByProvider.get(provider) ?? []}
              nowMs={nowMs}
              compact={compact}
            />
          ))}
        </div>
      )}
    </div>
  );
}
