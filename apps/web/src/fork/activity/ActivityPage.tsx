// Fork-only: every machine's "What the AI did" for the last three days, by day, with filters this
// client remembers.
import { Link } from "@tanstack/react-router";
import { T, useGT, useMessages } from "gt-react";
import { LayoutDashboardIcon } from "lucide-react";

import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { Button } from "../../components/ui/button";
import { Label } from "../../components/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { SidebarInset } from "../../components/ui/sidebar";
import { Switch } from "../../components/ui/switch";
import { isElectron } from "../../env";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useNowMinute } from "../../hooks/useNowMinute";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import {
  ActivityFilters,
  countStatuses,
  filterOptions,
  filterRows,
  groupByDay,
  mergeFeeds,
  NO_FILTERS,
} from "./activity.logic";
import { useActivityFeeds } from "./activityData";
import { ActivityList } from "./ActivityList";

const PAGE_HOURS = 72;
const PAGE_INPUT = { sinceHours: PAGE_HOURS, limit: 500 } as const;
/** Across machines; more rows than this would only slow the page down. */
const PAGE_ROWS = 500;
const FILTERS_KEY = "t3code:fork-activity-filters";
const ALL = "__all";

export function ActivityPage() {
  const gt = useGT();
  const m = useMessages();
  const contentArea = workspaceAreaProps("home", 1, gt("What the AI did"));
  const nowMs = Date.parse(`${useNowMinute()}:00Z`);
  const [filters, setFilters] = useLocalStorage(FILTERS_KEY, NO_FILTERS, ActivityFilters);
  const { feeds, pending, failed, machines } = useActivityFeeds(PAGE_INPUT);
  const all = mergeFeeds(feeds, PAGE_ROWS);
  const options = filterOptions(all, machines, filters, m);
  const rows = filterRows(all, filters);
  const groups = groupByDay(rows, nowMs, undefined, m);
  const counts = countStatuses(rows);
  const filtered = filters.project !== null || filters.machine !== null || filters.errorsOnly;
  const projectLabel = (value: string | null) =>
    value === null || value === ALL ? gt("All projects") : value;
  const machineLabel = (value: string | null) =>
    value === null || value === ALL
      ? gt("All machines")
      : (options.machines.find((machine) => machine.environmentId === value)?.label ?? value);

  return (
    <SidebarInset
      {...contentArea}
      role="main"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        {isElectron ? <WorkspacePageHeader electron /> : null}
        <div className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-[100rem] min-w-0 flex-col gap-8 px-4 py-10 sm:px-8">
            <header className="flex flex-wrap items-end gap-x-6 gap-y-3">
              <div className="flex min-w-0 flex-col gap-1">
                <h1 className="font-serif text-3xl tracking-tight">
                  <T>What the AI did</T>
                </h1>
                <p className="text-muted-foreground text-sm">
                  {gt(
                    "The last {hours} hours on {count, plural, one {{count} machine} other {{count} machines}}. Titles and one-line summaries only; it refreshes every 30 seconds while open.",
                    { hours: PAGE_HOURS, count: machines.length },
                  )}
                </p>
              </div>
              <span className="ms-auto flex">
                <Button variant="outline" size="sm" render={<Link to="/dashboard" />}>
                  <LayoutDashboardIcon />
                  <T>Dashboard</T>
                </Button>
              </span>
            </header>

            <div className="flex flex-wrap items-center gap-3">
              <Select
                value={filters.project ?? ALL}
                onValueChange={(value) =>
                  setFilters((current) => ({
                    ...current,
                    project: typeof value === "string" && value !== ALL ? value : null,
                  }))
                }
              >
                <SelectTrigger size="sm" className="w-full sm:w-56" aria-label={gt("Project")}>
                  <SelectValue>{(value: string | null) => projectLabel(value)}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="start" alignItemWithTrigger={false}>
                  <SelectItem value={ALL}>
                    <T>All projects</T>
                  </SelectItem>
                  {options.projects.map((project) => (
                    <SelectItem key={project} value={project}>
                      {project}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <Select
                value={filters.machine ?? ALL}
                onValueChange={(value) =>
                  setFilters((current) => ({
                    ...current,
                    machine: typeof value === "string" && value !== ALL ? value : null,
                  }))
                }
              >
                <SelectTrigger size="sm" className="w-full sm:w-56" aria-label={gt("Machine")}>
                  <SelectValue>{(value: string | null) => machineLabel(value)}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="start" alignItemWithTrigger={false}>
                  <SelectItem value={ALL}>
                    <T>All machines</T>
                  </SelectItem>
                  {options.machines.map((machine) => (
                    <SelectItem key={machine.environmentId} value={machine.environmentId}>
                      {machine.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <Label>
                <Switch
                  checked={filters.errorsOnly}
                  onCheckedChange={(errorsOnly) =>
                    setFilters((current) => ({ ...current, errorsOnly }))
                  }
                />
                <T>Only errors</T>
              </Label>
              {filtered ? (
                <Button variant="ghost" size="sm" onClick={() => setFilters(NO_FILTERS)}>
                  <T>Clear filters</T>
                </Button>
              ) : null}
            </div>

            <p className="font-mono text-2xs text-muted-foreground" aria-live="polite">
              {[
                gt("{count, plural, one {{count} entry} other {{count} entries}}", {
                  count: rows.length,
                }),
                counts.errors > 0
                  ? gt("{count, plural, one {{count} failed} other {{count} failed}}", {
                      count: counts.errors,
                      $context: "activity entries that failed",
                    })
                  : null,
                counts.waiting > 0 ? gt("{count} waiting on you", { count: counts.waiting }) : null,
                counts.running > 0 ? gt("{count} running", { count: counts.running }) : null,
                pending > 0 ? gt("reading {count} more", { count: pending }) : null,
                failed > 0
                  ? gt(
                      "{count, plural, one {{count} could not be read} other {{count} could not be read}}",
                      { count: failed, $context: "machines whose activity feed could not be read" },
                    )
                  : null,
              ]
                .filter((part) => part !== null)
                .join(" · ")}
            </p>

            {machines.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                {gt(
                  "No connected server keeps an activity feed yet. Update the T3 Code server to see it here.",
                )}
              </p>
            ) : groups.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                {pending > 0
                  ? gt("Reading the activity…")
                  : filtered
                    ? gt("Nothing matches these filters.")
                    : gt("Nothing in the last {hours} hours.", { hours: PAGE_HOURS })}
              </p>
            ) : (
              groups.map((group) => (
                <section key={group.day} aria-label={group.label} className="flex flex-col gap-2">
                  <h2 className="flex items-baseline gap-2 font-medium text-sm">
                    {group.label}
                    <span className="font-mono text-2xs text-muted-foreground">
                      {group.rows.length}
                    </span>
                  </h2>
                  <ActivityList rows={group.rows} />
                </section>
              ))
            )}
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}
