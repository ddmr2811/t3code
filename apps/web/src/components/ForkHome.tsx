// Fork-only: a home page with what waits on the user, the projects, quick
// starts for the chosen project and recent threads. Reads client state only.
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import { useNavigate } from "@tanstack/react-router";
import {
  BugIcon,
  GitCompareIcon,
  PlayIcon,
  PlusIcon,
  ShieldCheckIcon,
  SquarePenIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { openCommandPalette } from "../commandPaletteBus";
import { isElectron } from "../env";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useNowMinute } from "../hooks/useNowMinute";
import { workspaceAreaProps } from "../lib/workspaceFocus";
import { cn } from "../lib/utils";
import { useProjects, useVisibleThreadShells } from "../state/entities";
import { useEnvironmentIdentities } from "../state/environments";
import { buildThreadRouteParams } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { isSidebarHiddenThread, sortScopedProjectsForSidebar } from "./Sidebar.logic";
import {
  forkWidgetHasDesktopShell,
  setForkAutostart,
  setForkWidgetEnabled,
  useForkAutostart,
  useForkWidgetEnabled,
} from "./ForkResourceWidget";
import { isWorkCompletedThread } from "./sidebar/forkInbox";
import { SidebarInset } from "./ui/sidebar";
import { WorkspacePageHeader } from "./WorkspacePageHeader";

const RECENT_THREAD_COUNT = 10;

const QUICK_ACTIONS: ReadonlyArray<{
  readonly label: string;
  readonly prompt: string;
  readonly icon: ReactNode;
}> = [
  {
    label: "Audit this codebase",
    prompt: "Audit this codebase for bugs, security vulnerabilities, and improvements.",
    icon: <ShieldCheckIcon className="size-4" />,
  },
  {
    label: "Add a new feature",
    prompt: "Add a new feature: ",
    icon: <PlusIcon className="size-4" />,
  },
  { label: "Fix a bug", prompt: "Fix this bug: ", icon: <BugIcon className="size-4" /> },
  {
    label: "Review recent changes",
    prompt: "Review the recent changes in this repository and report anything that looks wrong.",
    icon: <GitCompareIcon className="size-4" />,
  },
  {
    label: "Run tests",
    prompt: "Run the test suite and fix any failures.",
    icon: <PlayIcon className="size-4" />,
  },
];

const projectKey = (item: { readonly environmentId: string; readonly id: string }) =>
  `${item.environmentId}:${item.id}`;

function isOpenInboxThread(thread: EnvironmentThreadShell, nowMs: number): boolean {
  if (thread.archivedAt !== null || thread.deletedAt !== null) return false;
  if (isSidebarHiddenThread(thread)) return false;
  if (thread.settledOverride === "settled") return false;
  const snoozedUntil = thread.snoozedUntil === null ? Number.NaN : Date.parse(thread.snoozedUntil);
  return !(snoozedUntil > nowMs);
}

function SectionTitle({ children }: { readonly children: ReactNode }) {
  return (
    <h2 className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wider">
      {children}
    </h2>
  );
}

function ThreadRow(props: {
  readonly thread: EnvironmentThreadShell;
  readonly projectTitle: string | null;
  readonly machineLabel: string | null;
  readonly nowMs: number;
  readonly onOpen: (thread: EnvironmentThreadShell) => void;
}) {
  const { thread } = props;
  return (
    <li className="list-none">
      <button
        type="button"
        onClick={() => props.onOpen(thread)}
        className="flex w-full cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-accent"
      >
        <span className="min-w-0 flex-1 truncate">{thread.title}</span>
        {props.projectTitle ? (
          <span className="max-w-40 shrink-0 truncate rounded-sm bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
            {props.projectTitle}
          </span>
        ) : null}
        {props.machineLabel ? (
          <span className="max-w-28 shrink-0 truncate text-muted-foreground text-xs">
            {props.machineLabel}
          </span>
        ) : null}
        <span className="w-16 shrink-0 text-right text-muted-foreground text-xs tabular-nums">
          {formatRelativeTimeLabel(thread.updatedAt, props.nowMs)}
        </span>
      </button>
    </li>
  );
}

function OptionRow(props: {
  readonly title: string;
  readonly description: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-md px-3 py-2 hover:bg-accent">
      <input
        type="checkbox"
        className="mt-1 size-4 shrink-0 cursor-pointer accent-primary"
        checked={props.checked}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      <span className="flex min-w-0 flex-col">
        <span className="text-sm">{props.title}</span>
        <span className="text-muted-foreground text-xs">{props.description}</span>
      </span>
    </label>
  );
}

function ForkOptions() {
  const widgetEnabled = useForkWidgetEnabled();
  const autostart = useForkAutostart();
  const hasShell = forkWidgetHasDesktopShell();
  return (
    <section>
      <SectionTitle>Fork options</SectionTitle>
      <div className="flex flex-col">
        <OptionRow
          title="Machines widget"
          description={
            hasShell
              ? "A small always-on-top window with every connected machine. While it is open, closing this window keeps T3 Code running in the tray."
              : "A small window with every connected machine."
          }
          checked={widgetEnabled}
          onChange={setForkWidgetEnabled}
        />
        {hasShell && widgetEnabled ? (
          <OptionRow
            title="Start with the system"
            description="Starts T3 Code in the tray when you sign in, showing only the widget."
            checked={autostart}
            onChange={setForkAutostart}
          />
        ) : null}
      </div>
    </section>
  );
}

export function ForkHome() {
  const contentArea = workspaceAreaProps("home", 1, "Home");
  const navigate = useNavigate();
  const handleNewThread = useNewThreadHandler();
  const allProjects = useProjects();
  const threads = useVisibleThreadShells();
  const environments = useEnvironmentIdentities();
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(null);
  // The minute tick is UTC without a zone suffix; it also refreshes the relative labels.
  const nowMs = Date.parse(`${useNowMinute()}:00Z`);

  const machineLabelById = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  const showMachines = environments.length > 1;
  const projects = sortScopedProjectsForSidebar(
    allProjects.filter((project) => project.archivedAt == null),
    threads,
    "updated_at",
  );
  const projectByKey = new Map(projects.map((project) => [projectKey(project), project] as const));
  const selectedProject: EnvironmentProject | null =
    (selectedProjectKey === null ? undefined : projectByKey.get(selectedProjectKey)) ??
    projects[0] ??
    null;

  const openThreads = threads.filter((thread) => isOpenInboxThread(thread, nowMs));
  const byRecency = (left: EnvironmentThreadShell, right: EnvironmentThreadShell) =>
    right.updatedAt.localeCompare(left.updatedAt);
  const needsInput = openThreads
    .filter((thread) => !isThreadWorking(thread) && !isWorkCompletedThread(thread))
    .toSorted(byRecency);
  const recentThreads = threads
    .filter((thread) => thread.archivedAt === null && !isSidebarHiddenThread(thread))
    .toSorted(byRecency)
    .slice(0, RECENT_THREAD_COUNT);

  const openThread = (thread: EnvironmentThreadShell) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
    });
  };
  const startThread = (project: EnvironmentProject, prompt?: string) => {
    void handleNewThread(
      scopeProjectRef(project.environmentId, project.id),
      prompt === undefined ? undefined : { prompt },
    );
  };
  const renderThreadRows = (list: readonly EnvironmentThreadShell[]) =>
    list.map((thread) => (
      <ThreadRow
        key={`${thread.environmentId}:${thread.id}`}
        thread={thread}
        projectTitle={
          projectByKey.get(`${thread.environmentId}:${thread.projectId}`)?.title ?? null
        }
        machineLabel={showMachines ? (machineLabelById.get(thread.environmentId) ?? null) : null}
        nowMs={nowMs}
        onOpen={openThread}
      />
    ));

  return (
    <SidebarInset
      {...contentArea}
      role="main"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none"
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        {/* The desktop window only moves where CSS opts in, so keep a titlebar strip. */}
        {isElectron ? <WorkspacePageHeader electron /> : null}
        <div className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-12">
            <header className="text-center">
              <h1 className="font-semibold text-2xl">What should we work on?</h1>
              <p className="mt-1 text-muted-foreground text-sm">
                {needsInput.length === 0
                  ? "Nothing is waiting on you."
                  : `${needsInput.length} ${needsInput.length === 1 ? "thread is" : "threads are"} waiting on you.`}
              </p>
            </header>

            {needsInput.length > 0 ? (
              <section>
                <SectionTitle>Needs your input</SectionTitle>
                <ul className="flex flex-col">{renderThreadRows(needsInput)}</ul>
              </section>
            ) : null}

            <section>
              <SectionTitle>Your projects</SectionTitle>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {projects.map((project) => {
                  const key = projectKey(project);
                  const selected = selectedProject !== null && projectKey(selectedProject) === key;
                  const machine = showMachines
                    ? (machineLabelById.get(project.environmentId) ?? null)
                    : null;
                  return (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => setSelectedProjectKey(key)}
                      onDoubleClick={() => startThread(project)}
                      className={cn(
                        "flex min-w-0 cursor-pointer flex-col rounded-lg border px-3 py-2 text-left hover:bg-accent",
                        selected ? "border-primary/60 bg-accent/50" : "border-border",
                      )}
                    >
                      <span className="truncate font-medium text-sm">{project.title}</span>
                      <span className="truncate text-muted-foreground text-xs">
                        {machine ?? project.workspaceRoot}
                      </span>
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={() => openCommandPalette({ open: "add-project" })}
                  className="flex cursor-pointer items-center gap-2 rounded-lg border border-border border-dashed px-3 py-2 text-left text-muted-foreground text-sm hover:bg-accent hover:text-foreground"
                >
                  <PlusIcon className="size-4" />
                  Add project
                </button>
              </div>
            </section>

            {selectedProject !== null ? (
              <section>
                <SectionTitle>Start in {selectedProject.title}</SectionTitle>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <button
                    type="button"
                    onClick={() => startThread(selectedProject)}
                    className="flex cursor-pointer items-center gap-2 rounded-lg border border-primary/60 px-3 py-2 text-left font-medium text-sm hover:bg-accent"
                  >
                    <SquarePenIcon className="size-4" />
                    New thread
                  </button>
                  {QUICK_ACTIONS.map((action) => (
                    <button
                      key={action.label}
                      type="button"
                      onClick={() => startThread(selectedProject, action.prompt)}
                      className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-left text-sm hover:bg-accent"
                    >
                      {action.icon}
                      <span className="truncate">{action.label}</span>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}

            {recentThreads.length > 0 ? (
              <section>
                <SectionTitle>Recent threads</SectionTitle>
                <ul className="flex flex-col">{renderThreadRows(recentThreads)}</ul>
              </section>
            ) : null}

            <ForkOptions />
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}
