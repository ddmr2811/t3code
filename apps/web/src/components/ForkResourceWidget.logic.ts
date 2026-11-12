// Fork-only: sizing and derived data of the machines widget (ForkResourceWidget.tsx).
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ResourceTelemetryProcess } from "@t3tools/contracts";

/** The widget's layout at scale 1, in CSS pixels: its width, its fixed parts, and one machine row. */
const NATURAL_WIDTH = 620;
const NATURAL_CHROME_HEIGHT = 60;
const NATURAL_ROW_HEIGHT = 38;
/** A machine's opened details: its figures, the split by group and its heaviest processes. */
const NATURAL_DETAILS_HEIGHT = 262;
const MIN_SCALE = 0.6;
const MAX_SCALE = 3;

const FORK_WIDGET_MIN_SIZE = { width: 240, height: 110 };

/** How many processes a machine's details list. */
export const FORK_WIDGET_PROCESS_COUNT = 10;

/** The window opens at this size until the user resizes it: every machine with its details. */
export function forkWidgetDefaultSize(machineCount: number): { width: number; height: number } {
  return {
    width: NATURAL_WIDTH,
    height:
      NATURAL_CHROME_HEIGHT +
      (NATURAL_ROW_HEIGHT + NATURAL_DETAILS_HEIGHT) * Math.max(2, machineCount),
  };
}

/**
 * How much to magnify the widget so its content fills the window: the largest scale at which
 * every machine row, with the details that are open, still fits both ways. Open details never
 * shrink the widget below its natural size: past that point they scroll instead.
 */
export function forkWidgetScale(input: {
  readonly width: number;
  readonly height: number;
  readonly machineCount: number;
  /** Machines whose details are open. */
  readonly detailCount?: number;
}): number {
  const rowsHeight = NATURAL_CHROME_HEIGHT + NATURAL_ROW_HEIGHT * Math.max(1, input.machineCount);
  const widthFit = input.width / NATURAL_WIDTH;
  const rowsFit = Math.min(widthFit, input.height / rowsHeight);
  const everythingFit = Math.min(
    widthFit,
    input.height / (rowsHeight + NATURAL_DETAILS_HEIGHT * (input.detailCount ?? 0)),
  );
  const fit = Math.max(everythingFit, Math.min(1, rowsFit));
  if (!Number.isFinite(fit) || fit <= 0) return 1;
  return Math.round(Math.min(MAX_SCALE, Math.max(MIN_SCALE, fit)) * 100) / 100;
}

/** The machines whose details the user closed; anything malformed means none. */
export function parseForkWidgetCollapsed(raw: string | null): ReadonlyArray<string> {
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export interface ForkWidgetBounds {
  readonly left: number;
  readonly top: number;
  /** Absent in bounds saved before the widget remembered its size. */
  readonly width?: number;
  readonly height?: number;
}

/** Reads bounds saved by an earlier session; anything malformed is ignored. */
export function parseForkWidgetBounds(raw: string | null): ForkWidgetBounds | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? "null");
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { left, top, width, height } = parsed as Record<string, unknown>;
  if (typeof left !== "number" || typeof top !== "number") return null;
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    width < FORK_WIDGET_MIN_SIZE.width ||
    height < FORK_WIDGET_MIN_SIZE.height
  ) {
    return { left, top };
  }
  return { left, top, width, height };
}

/** Five minutes of machine CPU at the widget's two-second refresh. */
export const FORK_WIDGET_CPU_SAMPLES = 150;

/** Adds the newest sample and drops the ones that no longer fit the chart. */
export function appendCpuSample(
  samples: ReadonlyArray<number>,
  share: number,
): ReadonlyArray<number> {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(share) ? share : 0));
  return [...samples, clamped].slice(-FORK_WIDGET_CPU_SAMPLES);
}

/**
 * The SVG path of a CPU chart. Its height is always the whole machine, so two machines compare
 * at a glance, and the newest sample sits at the right edge while the chart fills up.
 */
export function cpuSparklinePath(
  samples: ReadonlyArray<number>,
  width: number,
  height: number,
): string {
  if (samples.length < 2) return "";
  const step = width / (FORK_WIDGET_CPU_SAMPLES - 1);
  const start = width - step * (samples.length - 1);
  return samples
    .map((share, index) => {
      const x = Math.round((start + step * index) * 10) / 10;
      const y = Math.round((height - share * height) * 10) / 10;
      return `${index === 0 ? "M" : "L"}${x},${y}`;
    })
    .join(" ");
}

type ProcessInput = Pick<
  ResourceTelemetryProcess,
  | "identity"
  | "name"
  | "command"
  | "category"
  | "cpuPercent"
  | "residentBytes"
  | "ioReadBytesPerSecond"
  | "ioWriteBytesPerSecond"
>;

export interface ForkWidgetProcess {
  readonly pid: number;
  readonly name: string;
  /** Per core, as the monitor reports it: 100 is one core kept busy. */
  readonly cpuPercent: number;
  readonly residentBytes: number;
  readonly readBytesPerSecond: number;
  readonly writeBytesPerSecond: number;
}

/** The app's own processes all carry the app's name, which tells them apart from nothing. */
const CATEGORY_NAMES: Partial<Record<ProcessInput["category"], string>> = {
  server: "T3 server",
  "electron-main": "App",
  "electron-renderer": "App window",
  "electron-gpu": "App graphics",
  "electron-utility": "App helper",
  "resource-monitor": "Resource monitor",
};

function processName(process: Pick<ProcessInput, "name" | "command" | "category">): string {
  const byCategory = CATEGORY_NAMES[process.category];
  if (byCategory !== undefined) return byCategory;
  const first = (process.command.trim().split(/\s+/)[0] ?? "").replace(/^['"]|['"]$/g, "");
  const fromCommand = first.split(/[\\/]/).findLast((segment) => segment.length > 0) ?? first;
  return (process.name.trim() || fromCommand || "process").replace(/\.exe$/i, "");
}

/** The T3 Code processes that weigh most on a machine: busiest first, then largest. */
export function forkWidgetTopProcesses(
  processes: ReadonlyArray<ProcessInput>,
  count: number,
): ReadonlyArray<ForkWidgetProcess> {
  return processes
    .toSorted(
      (left, right) =>
        right.cpuPercent - left.cpuPercent || right.residentBytes - left.residentBytes,
    )
    .slice(0, count)
    .map((process) => ({
      pid: process.identity.pid,
      name: processName(process),
      cpuPercent: process.cpuPercent,
      residentBytes: process.residentBytes,
      readBytesPerSecond: process.ioReadBytesPerSecond,
      writeBytesPerSecond: process.ioWriteBytesPerSecond,
    }));
}

export interface ForkWaitingReason {
  /** What the thread waits for, in a couple of words. */
  readonly label: string;
  /** Whether the widget itself can answer: an approval's own buttons. */
  readonly answerable: boolean;
  /** Nothing is pending; the thread just did not end well, so it can simply be marked done. */
  readonly dismissible: boolean;
  readonly detail: string | null;
}

const STOPPED_RUN_LABELS: Record<string, string> = {
  interrupted: "Interrupted",
  failed: "Failed",
  cancelled: "Cancelled",
  rolled_back: "Rolled back",
};

/**
 * Why a thread counts as waiting on the user, in the order the sidebar's inbox checks
 * (sidebar/forkInbox.ts). Call it only for a thread that is neither working nor completed.
 */
export function forkWaitingReason(
  thread: Pick<
    EnvironmentThreadShell,
    | "hasActionableProposedPlan"
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "pendingSubagentRequest"
    | "pendingGuestMessageCount"
    | "interactionMode"
    | "latestRun"
    | "runtime"
  >,
): ForkWaitingReason {
  const pending = (label: string): ForkWaitingReason => ({
    label,
    answerable: false,
    dismissible: false,
    detail: null,
  });
  if (thread.hasPendingApprovals) return { ...pending("Needs approval"), answerable: true };
  if (thread.hasPendingUserInput) return pending("Asks a question");
  if (thread.pendingSubagentRequest === "approval")
    return { ...pending("Subagent needs approval"), answerable: true };
  if (thread.pendingSubagentRequest === "user_input") return pending("Subagent asks a question");
  if ((thread.pendingGuestMessageCount ?? 0) > 0) return pending("Guest message waiting");
  if (thread.interactionMode === "plan" && thread.hasActionableProposedPlan)
    return pending("Plan ready to review");
  const error = thread.runtime?.lastError ?? null;
  if (error !== null)
    return { label: "Error", answerable: false, dismissible: true, detail: error };
  const status = thread.latestRun?.status;
  return {
    label: status === undefined ? "Not started" : (STOPPED_RUN_LABELS[status] ?? "Stopped"),
    answerable: false,
    dismissible: true,
    detail: null,
  };
}
