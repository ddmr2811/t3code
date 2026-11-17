// Fork-only: the Dashboard panel with the newest few things the agents did on every machine.
import { Link } from "@tanstack/react-router";
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

  const footer = (
    <Button variant="outline" size="sm" render={<Link to="/activity" />}>
      See all activity
      <ArrowRightIcon />
    </Button>
  );
  if (machines.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No connected server keeps an activity feed yet. Update the T3 Code server to see it here.
      </p>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-muted-foreground text-sm">
          {pending > 0 ? "Reading the activity…" : "Nothing in the last 3 days."}
        </p>
        {footer}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="font-mono text-2xs text-muted-foreground">
        Newest {rows.length} on {machines.length} {machines.length === 1 ? "machine" : "machines"}
        {counts.errors > 0 ? ` · ${counts.errors} failed` : ""}
        {counts.waiting > 0 ? ` · ${counts.waiting} waiting on you` : ""}
      </p>
      <ActivityList rows={rows} nowMs={nowMs} />
      <div className="flex">{footer}</div>
    </div>
  );
}
