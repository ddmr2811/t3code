// Fork-only: the selected provider's usage limits, always visible in the composer footer.
import type { EnvironmentId, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import {
  collectProviderUsageLimits,
  formatDuration,
  limitsNotice,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import { useNavigate } from "@tanstack/react-router";

import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { useServerConfigs } from "../../state/entities";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const NO_SOURCES: readonly never[] = [];

/** Each chip reads as room left, like the Usage page. Opens that page on click. */
export function ForkComposerUsage(props: {
  readonly environmentId: EnvironmentId;
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly providers: readonly ServerProvider[];
}) {
  const { providerInstanceId, providers } = props;
  const navigate = useNavigate();
  const sources = useServerConfigs().get(props.environmentId)?.usageLimitSources ?? NO_SOURCES;
  const now = Date.parse(`${useNowMinute()}:00Z`);
  if (providerInstanceId === null) return null;
  const report = collectProviderUsageLimits(providerInstanceId, providers, sources, now);
  // Only this instance's data, as the thread details panel reads it.
  const limits =
    report?.accounts.find((entry) => entry.instanceId === providerInstanceId)?.limits ??
    providers.find((provider) => provider.instanceId === providerInstanceId)?.usageLimits;
  if (!limits || limitsNotice(limits) || limits.windows.length === 0) return null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label="Usage limits"
            data-testid="fork-composer-usage"
            onClick={() => void navigate({ to: "/usage" })}
            className="hidden h-7 shrink-0 cursor-pointer items-center gap-3 rounded-md px-2 text-muted-foreground text-xs hover:bg-accent hover:text-foreground sm:flex"
          />
        }
      >
        {limits.windows.map((window) => {
          const left = remainingPercent(window);
          return (
            <span key={window.id} className="flex items-center gap-1.5">
              <span className="max-w-24 truncate">{window.label}</span>
              <span className="relative h-[3px] w-10 rounded-full bg-muted-foreground/25">
                {left > 0 ? (
                  <span
                    className={cn(
                      "absolute inset-y-0 left-0 rounded-full",
                      left <= 10 ? "bg-error" : left <= 20 ? "bg-warning" : "bg-foreground/70",
                    )}
                    style={{ width: `max(${left}%, 4px)` }}
                  />
                ) : null}
              </span>
              <span
                className={cn(
                  "font-medium tabular-nums",
                  left <= 10
                    ? "text-error-foreground"
                    : left <= 20
                      ? "text-warning-foreground"
                      : "text-foreground/80",
                )}
              >
                {left}%
              </span>
            </span>
          );
        })}
      </TooltipTrigger>
      <TooltipPopup side="top">
        <div className="flex flex-col gap-0.5">
          {limits.windows.map((window) => {
            const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
            return (
              <span key={window.id}>
                {window.label}: {remainingPercent(window)}% left
                {resetsAt > now ? ` · resets in ${formatDuration(resetsAt - now)}` : ""}
              </span>
            );
          })}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
