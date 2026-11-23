// Fork-only: one "What the AI did" row per entry. Wide screens put everything on one line; a
// phone gets two: time, status and machine, then the summary cut with an ellipsis.
import type { ForkActivityStatus } from "@t3tools/contracts";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { RadioButtonIcon } from "@phosphor-icons/react/dist/csr/RadioButton";
import { XCircleIcon } from "@phosphor-icons/react/dist/csr/XCircle";
import type { Icon as PhosphorIcon } from "@phosphor-icons/react/dist/lib/types";
import { ChatCircleDotsIcon } from "@phosphor-icons/react/dist/csr/ChatCircleDots";
import { useMessages } from "gt-react";

import { Badge } from "../../components/ui/badge";
import { useClientSettings } from "../../hooks/useSettings";
import { formatRelativeTimeLabel, formatShortTimestamp } from "../../timestampFormat";
import { ACTOR_LABEL, type ActivityRow, STATUS_LABEL } from "./activity.logic";

const STATUS_LOOK: Readonly<
  Record<
    ForkActivityStatus,
    { readonly variant: "success" | "error" | "warning" | "info"; readonly icon: PhosphorIcon }
  >
> = {
  ok: { variant: "success", icon: CheckCircleIcon },
  error: { variant: "error", icon: XCircleIcon },
  waiting: { variant: "warning", icon: ChatCircleDotsIcon },
  running: { variant: "info", icon: RadioButtonIcon },
};

/** Colour, icon and words together, so the state never rests on colour alone. */
function ActivityStatusBadge({ status }: { readonly status: ForkActivityStatus }) {
  const { variant, icon: Icon } = STATUS_LOOK[status];
  const m = useMessages();
  return (
    <Badge variant={variant}>
      <Icon aria-hidden />
      {m(STATUS_LABEL[status])}
    </Badge>
  );
}

/** With `nowMs`, times read as how long ago, for a list not grouped by day. */
export function ActivityList({
  rows,
  nowMs,
}: {
  readonly rows: ReadonlyArray<ActivityRow>;
  readonly nowMs?: number;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const m = useMessages();
  return (
    <ul className="flex flex-col overflow-hidden rounded-lg border bg-card">
      {rows.map((row) => (
        <li
          key={row.key}
          className="flex min-w-0 flex-col gap-1 border-t px-4 py-2.5 first:border-t-0 sm:flex-row sm:items-center sm:gap-3 sm:py-2"
        >
          <div className="flex min-w-0 items-center gap-2 sm:contents">
            <time
              dateTime={row.at}
              className="w-18 shrink-0 whitespace-nowrap font-mono text-muted-foreground text-xs tabular-nums sm:order-1"
            >
              {nowMs === undefined
                ? formatShortTimestamp(row.at, timestampFormat)
                : formatRelativeTimeLabel(row.at, nowMs, m)}
            </time>
            <span className="flex shrink-0 sm:order-2 sm:w-32">
              <ActivityStatusBadge status={row.status} />
            </span>
            <span className="ms-auto min-w-0 truncate text-end font-mono text-2xs text-muted-foreground sm:order-6 sm:ms-0 sm:w-28 sm:shrink-0">
              {row.machine}
            </span>
          </div>
          <p className="min-w-0 truncate text-sm sm:order-3 sm:flex-1">{row.summary}</p>
          <span className="hidden w-36 shrink-0 truncate text-muted-foreground text-xs sm:order-4 sm:block">
            {row.project ?? ""}
          </span>
          <span className="hidden w-24 shrink-0 truncate text-muted-foreground text-xs sm:order-5 lg:block">
            {m(ACTOR_LABEL[row.actor])}
          </span>
        </li>
      ))}
    </ul>
  );
}
