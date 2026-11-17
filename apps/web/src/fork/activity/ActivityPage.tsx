// Fork-only: every machine's "What the AI did" for the last three days, by day, with filters this
// client remembers.
import { Link } from "@tanstack/react-router";
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
  const contentArea = workspaceAreaProps("home", 1, "What the AI did");
  const nowMs = Date.parse(`${useNowMinute()}:00Z`);
  const [filters, setFilters] = useLocalStorage(FILTERS_KEY, NO_FILTERS, ActivityFilters);
  const { feeds, pending, failed, machines } = useActivityFeeds(PAGE_INPUT);
  const all = mergeFeeds(feeds, PAGE_ROWS);
  const options = filterOptions(all, machines, filters);
  const rows = filterRows(all, filters);
  const groups = groupByDay(rows, nowMs);
  const counts = countStatuses(rows);
  const filtered = filters.project !== null || filters.machine !== null || filters.errorsOnly;
  const projectLabel = (value: string | null) =>
    value === null || value === ALL ? "All projects" : value;
  const machineLabel = (value: string | null) =>
    value === null || value === ALL
      ? "All machines"
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
                <h1 className="font-serif text-3xl tracking-tight">What the AI did</h1>
                <p className="text-muted-foreground text-sm">
                  The last {PAGE_HOURS} hours on {machines.length}{" "}
                  {machines.length === 1 ? "machine" : "machines"}. Titles and one-line summaries
                  only; it refreshes every 30 seconds while open.
                </p>
              </div>
              <span className="ms-auto flex">
                <Button variant="outline" size="sm" render={<Link to="/dashboard" />}>
                  <LayoutDashboardIcon />
                  Dashboard
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
                <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Project">
                  <SelectValue>{(value: string | null) => projectLabel(value)}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="start" alignItemWithTrigger={false}>
                  <SelectItem value={ALL}>All projects</SelectItem>
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
                <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Machine">
                  <SelectValue>{(value: string | null) => machineLabel(value)}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="start" alignItemWithTrigger={false}>
                  <SelectItem value={ALL}>All machines</SelectItem>
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
                Only errors
              </Label>
              {filtered ? (
                <Button variant="ghost" size="sm" onClick={() => setFilters(NO_FILTERS)}>
                  Clear filters
                </Button>
              ) : null}
            </div>

            <p className="font-mono text-2xs text-muted-foreground" aria-live="polite">
              {rows.length} {rows.length === 1 ? "entry" : "entries"}
              {counts.errors > 0 ? ` · ${counts.errors} failed` : ""}
              {counts.waiting > 0 ? ` · ${counts.waiting} waiting on you` : ""}
              {counts.running > 0 ? ` · ${counts.running} running` : ""}
              {pending > 0 ? ` · reading ${pending} more` : ""}
              {failed > 0 ? ` · ${failed} could not be read` : ""}
            </p>

            {machines.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No connected server keeps an activity feed yet. Update the T3 Code server to see it
                here.
              </p>
            ) : groups.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                {pending > 0
                  ? "Reading the activity…"
                  : filtered
                    ? "Nothing matches these filters."
                    : `Nothing in the last ${PAGE_HOURS} hours.`}
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
