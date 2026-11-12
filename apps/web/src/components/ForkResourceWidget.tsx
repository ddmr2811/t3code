// Fork-only: every connected machine's T3 Code load and working threads in a small window,
// off until the user turns it on. This renderer portals into an empty same-origin popup; the
// desktop shell frames it and keeps the app in the tray (apps/desktop/src/window/ForkResourceWidget.ts).
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ThreadPendingApproval } from "@t3tools/client-runtime/state/thread-requests";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { AppWindowIcon, ChevronDownIcon, XIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { useNowMinute } from "../hooks/useNowMinute";
import { useThreadActions } from "../hooks/useThreadActions";
import { formatBytes } from "../lib/formatBytes";
import { useResourceTelemetry } from "../lib/resourceTelemetryState";
import { cn } from "../lib/utils";
import { useVisibleThreadShells } from "../state/entities";
import { useEnvironmentIdentities } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { useEnvironmentScope } from "../state/session";
import {
  childThreadApprovalsAtom,
  environmentThreadDetails,
  threadEnvironment,
} from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import {
  appendCpuSample,
  cpuSparklinePath,
  type ForkWidgetBounds,
  forkWaitingReason,
  forkWidgetDefaultSize,
  forkWidgetScale,
  forkWidgetTopProcesses,
  parseForkWidgetBounds,
} from "./ForkResourceWidget.logic";
import { isSidebarHiddenThread } from "./Sidebar.logic";
import { isWorkCompletedThread } from "./sidebar/forkInbox";

/** Must match the frame name the desktop shell allows. */
const WIDGET_WINDOW_NAME = "t3-fork-resource-widget";
const POSITION_KEY = "t3code:fork:resource-widget-position";
const SHIFT_KEY = "t3code:fork:resource-widget-shift";
const REFRESH_MS = 2_000;
const POSITION_SAVE_MS = 1_000;
const POSITION_SETTLE_MS = 700;
const ENABLED_KEY = "t3code:fork:resource-widget-enabled";
const AUTOSTART_KEY = "t3code:fork:autostart";

interface ForkBridge {
  readonly showMain: () => void;
  readonly quit: () => void;
  readonly setAutostart: (enabled: boolean) => void;
}

declare global {
  interface Window {
    /** Present in the desktop app only (apps/desktop/src/preload.ts). */
    readonly forkBridge?: ForkBridge;
  }
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string, value: boolean) {
  try {
    if (value) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
  } catch {
    // Without storage the option simply does not persist.
  }
  for (const listener of listeners) listener();
}

/** Whether the desktop shell can keep the widget alive and start with the system. */
export function forkWidgetHasDesktopShell(): boolean {
  return window.forkBridge !== undefined;
}

export function useForkWidgetEnabled(): boolean {
  return useSyncExternalStore(subscribe, () => readFlag(ENABLED_KEY));
}

export function setForkWidgetEnabled(enabled: boolean) {
  if (enabled) {
    writeFlag(ENABLED_KEY, true);
    if (widgetWindow === null) toggleForkResourceWidget();
    return;
  }
  closeWidget();
  if (readFlag(AUTOSTART_KEY)) setForkAutostart(false);
  writeFlag(ENABLED_KEY, false);
}

export function useForkAutostart(): boolean {
  return useSyncExternalStore(subscribe, () => readFlag(AUTOSTART_KEY));
}

export function setForkAutostart(enabled: boolean) {
  window.forkBridge?.setAutostart(enabled);
  writeFlag(AUTOSTART_KEY, enabled);
}

const listeners = new Set<() => void>();
let widgetWindow: Window | null = null;

function setWidgetWindow(next: Window | null) {
  if (widgetWindow === next) return;
  widgetWindow = next;
  for (const listener of listeners) listener();
}

let positionTimer: ReturnType<typeof setInterval> | undefined;
let lastSavedPosition = "";

function savePosition(popup: Window) {
  // A closing window reports 0,0, so only an open one is read.
  if (popup.closed) return;
  const bounds: ForkWidgetBounds = {
    left: popup.screenX,
    top: popup.screenY,
    width: popup.innerWidth,
    height: popup.innerHeight,
  };
  const value = JSON.stringify(bounds);
  if (value === lastSavedPosition) return;
  lastSavedPosition = value;
  try {
    localStorage.setItem(POSITION_KEY, value);
  } catch {
    // Losing the position is harmless.
  }
}

/** Saved while open: the app can quit, or the OS close the window, without telling this renderer first. */
function trackPosition(popup: Window) {
  clearInterval(positionTimer);
  positionTimer = setInterval(() => savePosition(popup), POSITION_SAVE_MS);
}

function closeWidget() {
  const popup = widgetWindow;
  if (popup === null) return;
  setWidgetWindow(null);
  clearInterval(positionTimer);
  if (!popup.closed) {
    savePosition(popup);
    popup.close();
  }
}

/** Opens from the click itself, so the popup is never treated as unrequested. */
export function toggleForkResourceWidget() {
  if (widgetWindow !== null) {
    closeWidget();
    return;
  }
  const popup = openWidgetWindow();
  if (popup === null) return;
  // Closed from its own side (Alt+F4, the OS): forget the window.
  popup.addEventListener("pagehide", () => {
    if (widgetWindow !== popup) return;
    clearInterval(positionTimer);
    setWidgetWindow(null);
  });
  trackPosition(popup);
  window.addEventListener("pagehide", closeWidget, { once: true });
  setWidgetWindow(popup);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function readSavedBounds(): ForkWidgetBounds | null {
  try {
    return parseForkWidgetBounds(localStorage.getItem(POSITION_KEY));
  } catch {
    // Without storage the widget opens at its default place and size.
    return null;
  }
}

/**
 * The shell puts the window's invisible resize border, not its content, at the asked position,
 * so the window reports a place a few pixels off. Measured on each open and added to the next
 * request, so the remembered position does not creep. Moving the window afterwards is not an
 * option: `moveTo` also enlarges it by that border.
 */
function readPlacementShift(): { x: number; y: number } {
  try {
    const [x = 0, y = 0] = (localStorage.getItem(SHIFT_KEY) ?? "").split(",").map(Number);
    // A window held back by the edge of the screen would give a meaningless figure.
    const sane = (value: number) => Number.isInteger(value) && Math.abs(value) <= 64;
    if (sane(x) && sane(y)) return { x, y };
  } catch {
    // Without storage the window opens those few pixels off.
  }
  return { x: 0, y: 0 };
}

function openWidgetWindow(): Window | null {
  const position = readSavedBounds();
  const fallback = forkWidgetDefaultSize(2);
  const size = {
    width: position?.width ?? fallback.width,
    height: position?.height ?? fallback.height,
  };
  const shift = readPlacementShift();
  const asked = position ? { left: position.left + shift.x, top: position.top + shift.y } : null;
  const features = [
    "popup=yes",
    `width=${size.width}`,
    `height=${size.height}`,
    ...(asked ? [`left=${asked.left}`, `top=${asked.top}`] : []),
  ].join(",");
  const child = window.open("about:blank", WIDGET_WINDOW_NAME, features);
  if (child === null) return null;
  if (asked) {
    setTimeout(() => {
      if (child.closed) return;
      const measured = `${asked.left - child.screenX},${asked.top - child.screenY}`;
      try {
        if (localStorage.getItem(SHIFT_KEY) !== measured) localStorage.setItem(SHIFT_KEY, measured);
      } catch {
        // Not remembering it only costs those few pixels again.
      }
    }, POSITION_SETTLE_MS);
  }
  const root = document.documentElement;
  child.document.title = "T3 Code machines";
  child.document.documentElement.className = root.className;
  child.document.documentElement.style.cssText = root.style.cssText;
  for (const attribute of root.attributes) {
    if (attribute.name.startsWith("data-")) {
      child.document.documentElement.setAttribute(attribute.name, attribute.value);
    }
  }
  for (const node of document.head.querySelectorAll('style, link[rel="stylesheet"]')) {
    const copy = child.document.importNode(node, true);
    // A popup at about:blank has no base URL, so relative stylesheet links would not load.
    if (node instanceof HTMLLinkElement && copy instanceof HTMLLinkElement) copy.href = node.href;
    child.document.head.append(copy);
  }
  child.document.body.className = "m-0 overflow-hidden bg-background text-foreground";
  return child;
}

/** A machine past this share of its CPU or memory is a poor place for the next task. */
const BUSY_SHARE = 0.85;
const SATURATED_SHARE = 0.95;
/** Numbers older than this are shown dimmed rather than passed off as current. */
const STALE_MS = 15_000;

function shareTone(share: number | null): string {
  if (share === null) return "text-foreground";
  if (share >= SATURATED_SHARE) return "text-destructive";
  if (share >= BUSY_SHARE) return "text-warning-foreground";
  return "text-foreground";
}

const CHART = { width: 56, height: 16 };
const TOP_PROCESSES = 3;
const NO_SAMPLES: ReadonlyArray<number> = [];
const NO_THREADS: ReadonlyArray<EnvironmentThreadShell> = [];

/** Kept outside React, so the chart survives the widget being closed and opened again. */
const cpuHistory = new Map<
  string,
  { readonly at: number; readonly samples: ReadonlyArray<number> }
>();

/** One sample per reading of the machine; asking again for the same reading adds nothing. */
function recordCpuSample(
  environmentId: string,
  share: number | null,
  readAt: number,
): ReadonlyArray<number> {
  const entry = cpuHistory.get(environmentId);
  if (share === null || entry?.at === readAt) return entry?.samples ?? NO_SAMPLES;
  const samples = appendCpuSample(entry?.samples ?? NO_SAMPLES, share);
  cpuHistory.set(environmentId, { at: readAt, samples });
  return samples;
}

const actionButton =
  "cursor-pointer rounded-sm border border-border px-1.5 py-0.5 text-2xs text-foreground hover:bg-accent disabled:cursor-default disabled:opacity-50";

/** What a provider offers when it names no choices of its own. */
const DEFAULT_APPROVAL_OPTIONS: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "decline", label: "Decline" },
  { decision: "accept", label: "Approve" },
];

const APPROVAL_KIND_LABELS: Record<ThreadPendingApproval["requestKind"], string> = {
  command: "Run a command",
  "file-read": "Read a file",
  "file-change": "Change a file",
  "mcp-elicitation": "Answer a tool",
  permission: "Grant a permission",
};

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0], fallback: string) {
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error ? failure.message : fallback;
}

/** One approval with the provider's own choices as buttons. */
function ApprovalCard(props: {
  /** The thread that asked, which for a subagent is not the one listed. */
  readonly thread: ScopedThreadRef;
  readonly from?: string;
  readonly approval: ThreadPendingApproval;
}) {
  const { thread, approval } = props;
  const canRespond = useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);
  const respond = useAtomCommand(threadEnvironment.respondToApproval, { reportFailure: false });
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = approval.options ?? DEFAULT_APPROVAL_OPTIONS;

  const decide = async (decision: ProviderApprovalDecision) => {
    if (!canRespond || responding) return;
    setResponding(true);
    setError(null);
    const result = await respond({
      environmentId: thread.environmentId,
      input: { threadId: thread.threadId, requestId: approval.requestId, decision },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setError(failureMessage(result, "Could not send the decision."));
    }
    setResponding(false);
  };

  return (
    <div className="flex flex-col gap-1">
      <p className="text-2xs text-muted-foreground">
        {APPROVAL_KIND_LABELS[approval.requestKind]}
        {props.from ? ` · from ${props.from}` : null}
      </p>
      <pre className="max-h-20 overflow-auto whitespace-pre-wrap break-words rounded-sm bg-background/60 px-1.5 py-1 font-mono text-2xs">
        {approval.detail || approval.requestKind}
      </pre>
      {approval.reason ? <p className="text-2xs text-muted-foreground">{approval.reason}</p> : null}
      {options.map((option) =>
        option.warning ? (
          <p key={option.decision} className="text-2xs text-warning-foreground">
            {option.label}: {option.warning}
          </p>
        ) : null,
      )}
      {approval.responseCapability === "live" ? (
        <div className="flex flex-wrap justify-end gap-1.5">
          {options.map((option) => (
            <button
              key={option.decision}
              type="button"
              disabled={!canRespond || responding}
              className={cn(
                actionButton,
                option.decision === "accept" &&
                  "border-transparent bg-primary text-primary-foreground hover:bg-primary/90",
              )}
              onClick={() => void decide(option.decision)}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : (
        <p className="text-2xs text-warning-foreground">
          The agent's process is gone. Open the thread to restart it.
        </p>
      )}
      {error !== null ? (
        <p role="alert" className="text-2xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** What a thread itself asks for: approvals to answer here, or a question's text. */
function WaitingRequest({ thread }: { readonly thread: ScopedThreadRef }) {
  // The thread list only says that something is pending; the request itself is in the thread.
  const requests = useAtomValue(environmentThreadDetails.pendingRequestsAtom(thread));
  if (requests === null) return <p className="text-2xs text-muted-foreground">Loading…</p>;
  const question = requests.userInputs[0]?.questions[0]?.question;
  return (
    <>
      {requests.approvals.map((approval) => (
        <ApprovalCard key={approval.requestId} thread={thread} approval={approval} />
      ))}
      {question ? <p className="line-clamp-3 text-2xs text-muted-foreground">{question}</p> : null}
    </>
  );
}

/** Approvals asked by a thread's subagents, the same ones the thread's own page lists. */
function WaitingChildApprovals({ thread }: { readonly thread: ScopedThreadRef }) {
  const approvals = useAtomValue(childThreadApprovalsAtom(thread));
  return approvals.map((entry) => (
    <ApprovalCard
      key={`${entry.thread.threadId}:${entry.approval.requestId}`}
      thread={entry.thread}
      from={entry.title}
      approval={entry.approval}
    />
  ));
}

function WaitingThread(props: {
  readonly thread: EnvironmentThreadShell;
  readonly onOpen: () => void;
  readonly onSettle: () => ReturnType<ReturnType<typeof useThreadActions>["settleThread"]>;
}) {
  const { thread } = props;
  const threadRef = { environmentId: thread.environmentId, threadId: thread.id };
  const reason = forkWaitingReason(thread);
  const [settling, setSettling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const settle = async () => {
    if (settling) return;
    setSettling(true);
    setError(null);
    const result = await props.onSettle();
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setError(failureMessage(result, "Could not mark the thread as done."));
    }
    setSettling(false);
  };

  return (
    <div role="listitem" className="flex flex-col gap-1 text-xs">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">{thread.title}</span>
        <span className="shrink-0 text-warning-foreground">{reason.label}</span>
        <button type="button" className={actionButton} onClick={props.onOpen}>
          Open
        </button>
        {reason.dismissible ? (
          <button
            type="button"
            className={actionButton}
            disabled={settling}
            onClick={() => void settle()}
          >
            Mark done
          </button>
        ) : null}
      </div>
      {reason.detail !== null ? (
        <p className="line-clamp-2 text-2xs text-muted-foreground">{reason.detail}</p>
      ) : null}
      {thread.hasPendingApprovals || thread.hasPendingUserInput ? (
        <WaitingRequest thread={threadRef} />
      ) : thread.pendingSubagentRequest === "approval" ? (
        <WaitingChildApprovals thread={threadRef} />
      ) : null}
      {error !== null ? (
        <p role="alert" className="text-2xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The threads of one machine that wait on the user, each with why and what can be done here. */
function WaitingPanel({ threads }: { readonly threads: ReadonlyArray<EnvironmentThreadShell> }) {
  const router = useRouter();
  const { settleThread } = useThreadActions();
  // What can be answered right here comes first.
  const answerable = (thread: EnvironmentThreadShell) =>
    Number(forkWaitingReason(thread).answerable);
  const ordered = threads.toSorted((left, right) => answerable(right) - answerable(left));
  return (
    <div
      role="list"
      aria-label="Threads waiting"
      className="col-span-full flex flex-col gap-1.5 border-border/60 border-t pt-1.5"
    >
      {ordered.map((thread) => (
        <WaitingThread
          key={thread.id}
          thread={thread}
          onOpen={() => {
            void router.navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId: thread.environmentId, threadId: thread.id },
            });
            window.forkBridge?.showMain();
          }}
          onSettle={() =>
            settleThread({ environmentId: thread.environmentId, threadId: thread.id })
          }
        />
      ))}
    </div>
  );
}

function MachineRow(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly workingThreads: number;
  readonly waitingThreads: ReadonlyArray<EnvironmentThreadShell>;
}) {
  const { environmentId } = props;
  const [waitingOpen, setWaitingOpen] = useState(false);
  // T3 Code's own footprint: the agents and server on that machine.
  const telemetry = useResourceTelemetry(environmentId);
  // The whole machine, whatever else runs on it. The server already samples this for load balancing.
  const host = useEnvironmentQuery(serverEnvironment.hostResources({ environmentId, input: {} }));
  const refreshTelemetry = telemetry.refresh;
  const refreshHost = host.refresh;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls this machine's load while the widget window is open
  useEffect(() => {
    const timer = setInterval(() => {
      refreshTelemetry();
      refreshHost();
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [refreshTelemetry, refreshHost]);
  const nowMs = Date.parse(`${useNowMinute()}:00Z`);

  const resources = host.data;
  const snapshot = telemetry.data;
  const agents = snapshot?.groups.backend;
  const cpuShare = resources?.cpuUtilization ?? null;
  const memoryShare =
    resources && resources.totalMemoryBytes > 0
      ? 1 - resources.availableMemoryBytes / resources.totalMemoryBytes
      : null;
  // Process CPU is per core; the machine's is a share of all cores.
  const machineShare = (cpuPercent: number) =>
    resources && resources.cpuCount > 0 ? cpuPercent / 100 / resources.cpuCount : null;
  const agentsCpuShare = agents ? machineShare(agents.currentCpuPercent) : null;
  const unreachable = !resources && (host.error !== null || !host.isPending);
  // The minute tick lags by up to a minute, so only clearly old samples count as stale.
  const stale = resources !== null && nowMs - host.dataUpdatedAt > STALE_MS + 60_000;
  const cell = "truncate text-end font-mono font-semibold tabular-nums";
  const percent = (share: number | null) => (share === null ? "…" : `${Math.round(share * 100)}%`);
  const cpuChart = cpuSparklinePath(
    recordCpuSample(environmentId, cpuShare, host.dataUpdatedAt),
    CHART.width,
    CHART.height,
  );
  const processes = snapshot ? forkWidgetTopProcesses(snapshot.processes, TOP_PROCESSES) : [];
  const waitingCount = props.waitingThreads.length;

  return (
    <div
      role="row"
      className={cn(
        "col-span-7 grid grid-cols-subgrid content-center items-center gap-y-1 rounded-md bg-muted/30 px-2.5 py-1.5 text-sm",
        stale && "opacity-50",
      )}
    >
      <span className="truncate font-medium">{props.label}</span>
      {unreachable ? (
        <span className="col-span-4 truncate text-end text-muted-foreground text-xs">
          {host.error ?? "No data"}
        </span>
      ) : (
        <>
          <span className={cn(cell, shareTone(cpuShare))}>{percent(cpuShare)}</span>
          <svg
            aria-hidden
            viewBox={`0 0 ${CHART.width} ${CHART.height}`}
            preserveAspectRatio="none"
            className="h-4 w-14 text-muted-foreground"
          >
            <path
              d={cpuChart}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.25"
              strokeLinejoin="round"
            />
          </svg>
          <span className={cn(cell, shareTone(memoryShare))}>
            {resources
              ? `${formatBytes(resources.totalMemoryBytes - resources.availableMemoryBytes)} / ${formatBytes(resources.totalMemoryBytes)}`
              : "…"}
          </span>
          <span className={cn(cell, "font-normal text-muted-foreground")}>
            {agents ? `${percent(agentsCpuShare)} · ${formatBytes(agents.currentRssBytes)}` : "…"}
          </span>
        </>
      )}
      <span
        className={cn(cell, props.workingThreads > 0 ? "text-foreground" : "text-muted-foreground")}
      >
        {props.workingThreads}
      </span>
      {waitingCount > 0 ? (
        <button
          type="button"
          aria-expanded={waitingOpen}
          aria-label={`${waitingCount} waiting on ${props.label}`}
          onClick={() => setWaitingOpen((open) => !open)}
          className={cn(
            cell,
            "flex cursor-pointer items-center gap-0.5 justify-self-end rounded-sm bg-warning/16 py-0.5 ps-1.5 pe-1 text-warning-foreground hover:bg-warning/30",
          )}
        >
          {waitingCount}
          <ChevronDownIcon
            className={cn("size-3 transition-transform", waitingOpen && "rotate-180")}
          />
        </button>
      ) : (
        <span className={cn(cell, "text-muted-foreground")}>0</span>
      )}
      {agents ? (
        <div className="col-span-full truncate text-2xs text-muted-foreground tabular-nums">
          {agents.processCount} {agents.processCount === 1 ? "process" : "processes"}
          {processes.map((process) => (
            <span key={process.pid}>
              {" · "}
              <span className="text-foreground/80">{process.name}</span>{" "}
              {percent(machineShare(process.cpuPercent))} {formatBytes(process.residentBytes)}
            </span>
          ))}
        </div>
      ) : null}
      {waitingOpen && waitingCount > 0 ? <WaitingPanel threads={props.waitingThreads} /> : null}
    </div>
  );
}

/** The popup's viewport, re-read whenever the user resizes it. */
function useWidgetViewport(popup: Window): { width: number; height: number } {
  const size = useSyncExternalStore(
    (listener) => {
      popup.addEventListener("resize", listener);
      return () => popup.removeEventListener("resize", listener);
    },
    () => `${popup.innerWidth}x${popup.innerHeight}`,
  );
  const [width = 0, height = 0] = size.split("x").map(Number);
  return { width, height };
}

function WidgetBody({ popup, onClose }: { readonly popup: Window; readonly onClose: () => void }) {
  const environments = useEnvironmentIdentities();
  const viewport = useWidgetViewport(popup);
  // The content is magnified to fill the window, so a bigger window reads from further away.
  const scale = forkWidgetScale({ ...viewport, machineCount: environments.length });
  const threads = useVisibleThreadShells();
  const working = new Map<string, number>();
  const waiting = new Map<string, EnvironmentThreadShell[]>();
  for (const thread of threads) {
    if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
    if (isSidebarHiddenThread(thread) || thread.settledOverride === "settled") continue;
    // Same split as the sidebar: working, finished, or waiting on the user.
    if (isThreadWorking(thread)) {
      working.set(thread.environmentId, (working.get(thread.environmentId) ?? 0) + 1);
    } else if (!isWorkCompletedThread(thread)) {
      waiting.set(thread.environmentId, [...(waiting.get(thread.environmentId) ?? []), thread]);
    }
  }
  const heading =
    "truncate text-3xs font-semibold uppercase tracking-widest text-muted-foreground/70";

  return (
    <div
      className="flex flex-col gap-2 p-2"
      style={{ zoom: scale, height: viewport.height / scale }}
    >
      {/* The window has no frame: this strip is its drag handle. */}
      <div className="flex items-center gap-2 [-webkit-app-region:drag]">
        <span className="flex-1 truncate px-1 text-xs font-medium text-muted-foreground">
          T3 Code machines
        </span>
        {window.forkBridge ? (
          <button
            type="button"
            aria-label="Open T3 Code"
            // Called without the click event: the bridge cannot clone it and would throw.
            onClick={() => window.forkBridge?.showMain()}
            className="flex size-5 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground [-webkit-app-region:no-drag]"
          >
            <AppWindowIcon className="size-3.5" />
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Close widget"
          onClick={onClose}
          className="flex size-5 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground [-webkit-app-region:no-drag]"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
      <div
        role="table"
        aria-label="Connected machines"
        className="grid min-h-0 flex-1 grid-cols-[minmax(4rem,1fr)_auto_auto_auto_auto_auto_auto] gap-x-3 gap-y-1.5 overflow-y-auto"
        // A taller window gives every machine a taller row instead of leaving the bottom empty.
        style={{
          gridTemplateRows: `auto repeat(${environments.length}, minmax(min-content, 1fr))`,
        }}
      >
        <div role="row" className="col-span-7 grid grid-cols-subgrid px-2.5">
          <span className={heading}>Machine</span>
          <span className={cn(heading, "text-end")}>CPU</span>
          <span className={cn(heading, "text-end")}>5 min</span>
          <span className={cn(heading, "text-end")}>Memory</span>
          <span className={cn(heading, "text-end")}>Agents</span>
          <span className={cn(heading, "text-end")}>Working</span>
          <span className={cn(heading, "text-end")}>Waiting</span>
        </div>
        {environments.map((environment) => (
          <MachineRow
            key={environment.environmentId}
            environmentId={environment.environmentId}
            label={environment.label}
            workingThreads={working.get(environment.environmentId) ?? 0}
            waitingThreads={waiting.get(environment.environmentId) ?? NO_THREADS}
          />
        ))}
      </div>
    </div>
  );
}

/** Mount once in the app shell. Renders nothing in the main window. */
export function ForkResourceWidgetHost() {
  const popup = useSyncExternalStore(subscribe, () => widgetWindow);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- on app start, reopens the widget the user enabled and re-applies start with the system
  useEffect(() => {
    // Browsers block a popup nobody clicked for; the desktop shell does not.
    if (window.forkBridge === undefined || !readFlag(ENABLED_KEY)) return;
    if (readFlag(AUTOSTART_KEY)) window.forkBridge.setAutostart(true);
    if (widgetWindow === null) toggleForkResourceWidget();
  }, []);
  if (popup === null || popup.closed) return null;
  return createPortal(<WidgetBody popup={popup} onClose={closeWidget} />, popup.document.body);
}
