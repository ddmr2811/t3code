// Fork-only: "What the AI did" across every connected machine: each server answers its own feed,
// and the client adds the machine, merges them newest first, filters and groups them by day.
import type {
  EnvironmentId,
  ForkActivityActor,
  ForkActivityEntry,
  ForkActivityStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";

export interface MachineFeed {
  readonly environmentId: EnvironmentId;
  readonly machine: string;
  readonly entries: ReadonlyArray<ForkActivityEntry>;
}

export interface ActivityRow extends ForkActivityEntry {
  /** Unique across machines. */
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly machine: string;
}

export function mergeFeeds(feeds: ReadonlyArray<MachineFeed>, limit?: number) {
  const rows = feeds.flatMap((feed) =>
    feed.entries.map((entry): ActivityRow => ({
      ...entry,
      key: `${feed.environmentId}:${entry.id}`,
      environmentId: feed.environmentId,
      machine: feed.machine,
    })),
  );
  const sorted = rows.toSorted((a, b) =>
    a.at === b.at ? a.key.localeCompare(b.key) : Date.parse(b.at) - Date.parse(a.at),
  );
  return limit === undefined ? sorted : sorted.slice(0, limit);
}

export const ActivityFilters = Schema.Struct({
  project: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  machine: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  errorsOnly: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type ActivityFilters = typeof ActivityFilters.Type;

export const NO_FILTERS: ActivityFilters = { project: null, machine: null, errorsOnly: false };

export function filterRows(
  rows: ReadonlyArray<ActivityRow>,
  filters: ActivityFilters,
): ReadonlyArray<ActivityRow> {
  return rows.filter(
    (row) =>
      (filters.project === null || row.project === filters.project) &&
      (filters.machine === null || row.environmentId === filters.machine) &&
      (!filters.errorsOnly || row.status === "error"),
  );
}

export interface FilterOptions {
  readonly projects: ReadonlyArray<string>;
  readonly machines: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
}

/**
 * Projects seen in the feed and every machine asked, so a quiet machine can still be picked. A
 * saved filter for one that is gone stays listed, so it can be cleared.
 */
export function filterOptions(
  rows: ReadonlyArray<ActivityRow>,
  machines: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly label: string }>,
  filters: ActivityFilters,
  resolve: MessageResolver = m,
): FilterOptions {
  const projects = new Set(rows.flatMap((row) => (row.project === undefined ? [] : [row.project])));
  if (filters.project !== null) projects.add(filters.project);
  const known = machines.toSorted((a, b) => a.label.localeCompare(b.label));
  const missing =
    filters.machine !== null && !known.some((entry) => entry.environmentId === filters.machine)
      ? [
          {
            environmentId: filters.machine as EnvironmentId,
            label: resolve(msg("Disconnected machine")),
          },
        ]
      : [];
  return {
    projects: [...projects].toSorted((a, b) => a.localeCompare(b)),
    machines: [...known, ...missing],
  };
}

export interface DayGroup {
  /** `YYYY-MM-DD` in the viewer's zone. */
  readonly day: string;
  readonly label: string;
  readonly rows: ReadonlyArray<ActivityRow>;
}

const dayFormat = (timeZone: string | undefined) =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });

/** Rows in order, split where the day changes in `timeZone` (the viewer's when omitted). */
export function groupByDay(
  rows: ReadonlyArray<ActivityRow>,
  nowMs: number,
  timeZone?: string,
  resolve: MessageResolver = m,
): ReadonlyArray<DayGroup> {
  const format = dayFormat(timeZone);
  const today = format.format(nowMs);
  const yesterday = format.format(nowMs - 24 * 60 * 60_000);
  const long = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const groups: Array<{ day: string; label: string; rows: ActivityRow[] }> = [];
  for (const row of rows) {
    const atMs = Date.parse(row.at);
    const day = format.format(atMs);
    const last = groups.at(-1);
    if (last?.day === day) {
      last.rows.push(row);
      continue;
    }
    const label =
      day === today
        ? resolve(msg("Today"))
        : day === yesterday
          ? resolve(msg("Yesterday"))
          : long.format(atMs);
    groups.push({ day, label, rows: [row] });
  }
  return groups;
}

export const STATUS_LABEL: Readonly<Record<ForkActivityStatus, string>> = {
  ok: msg("OK", { $context: "activity status, the step went fine" }),
  error: msg("Error"),
  waiting: msg("Waiting on you"),
  running: msg("Running"),
};

export const ACTOR_LABEL: Readonly<Record<ForkActivityActor, string>> = {
  orchestrator: msg("Orchestrator"),
  worker: msg("Worker"),
  timer: msg("Timer"),
  user: msg("You"),
  unknown: msg("Unknown"),
};

export interface ActivityCounts {
  readonly errors: number;
  readonly waiting: number;
  readonly running: number;
}

export function countStatuses(rows: ReadonlyArray<ActivityRow>): ActivityCounts {
  let errors = 0;
  let waiting = 0;
  let running = 0;
  for (const row of rows) {
    if (row.status === "error") errors += 1;
    else if (row.status === "waiting") waiting += 1;
    else if (row.status === "running") running += 1;
  }
  return { errors, waiting, running };
}
