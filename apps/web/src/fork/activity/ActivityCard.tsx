// Fork-only: the Dashboard panel with the newest few things the agents did on every machine.
import { Link } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { ArrowRightIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import { countStatuses, mergeFeeds } from "./activity.logic";
import { useActivityFeeds } from "./activityData";
import { ActivityList } from "./ActivityList";

const ACTIVITY_CARD_ROWS = 8;
const CARD_INPUT = { sinceHours: 72, limit: ACTIVITY_CARD_ROWS } as const;

export function ActivityCard({ nowMs }: { readonly nowMs: number }) {
  const { feeds, pending, machines } = useActivityFeeds(CARD_INPUT);
  const rows = mergeFeeds(feeds, ACTIVITY_CARD_ROWS);
  const counts = countStatuses(rows);
  const gt = useGT();

  const footer = (
    <Button variant="outline" size="sm" render={<Link to="/activity" />}>
      {gt("See all activity")}
      <ArrowRightIcon />
    </Button>
  );
  if (machines.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        {gt(
          "No connected server keeps an activity feed yet. Update the T3 Code server to see it here.",
        )}
      </p>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-muted-foreground text-sm">
          {pending > 0 ? gt("Reading the activity…") : gt("Nothing in the last 3 days.")}
        </p>
        {footer}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="font-mono text-2xs text-muted-foreground">
        {[
          gt("Newest {rows} on {count, plural, one {{count} machine} other {{count} machines}}", {
            rows: rows.length,
            count: machines.length,
          }),
          counts.errors > 0 ? gt("{count} failed", { count: counts.errors }) : null,
          counts.waiting > 0 ? gt("{count} waiting on you", { count: counts.waiting }) : null,
        ]
          .filter((part) => part !== null)
          .join(" · ")}
      </p>
      <ActivityList rows={rows} nowMs={nowMs} />
      <div className="flex">{footer}</div>
    </div>
  );
}
