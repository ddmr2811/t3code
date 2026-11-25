import type {
  EnvironmentThreadShell,
  ThreadStructure,
  ThreadStructureTurnItem,
} from "@t3tools/client-runtime/state/models";
import {
  deriveThreadActivityRun,
  deriveThreadPendingBackgroundTasks,
  deriveThreadStructureRuntime,
  pendingBackgroundTaskItem,
  presentPendingBackgroundWork,
} from "@t3tools/client-runtime/state/thread-execution";
import {
  PROVIDER_DISPLAY_NAMES,
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
  type ThreadId,
} from "@t3tools/contracts";
import { deriveSubagentElapsedMs } from "@t3tools/shared/orchestrationTiming";
import * as DateTime from "effect/DateTime";

import { threadState } from "../sidebar/sidebar.logic.ts";

/** Line and file counts the Spanish way, whatever the browser's language. */
export const formatCount = new Intl.NumberFormat("es").format;

export type TimelineRowKind = "user" | "assistant" | "reasoning" | "tool" | "notice" | "error";

const TOOL_TYPES = new Set<OrchestrationV2TurnItem["type"]>([
  "command_execution",
  "dynamic_tool",
  "file_change",
  "file_search",
  "web_search",
  "subagent",
]);

/** How the timeline shows an item, or null for the ones it leaves to later blocks or hides. */
export function rowKind(item: OrchestrationV2TurnItem): TimelineRowKind | null {
  if (item.type === "user_message") return "user";
  if (item.type === "assistant_message") return "assistant";
  if (item.type === "reasoning") return item.text.trim() === "" ? null : "reasoning";
  if (item.type === "error") return "error";
  if (item.type === "system_notice" || item.type === "compaction") return "notice";
  return TOOL_TYPES.has(item.type) ? "tool" : null;
}

export interface TimelineTurn {
  readonly key: string;
  readonly runId: string | null;
  readonly rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
}

/**
 * Consecutive shown rows of one run form a turn; rows outside any run stand on their own. A
 * hidden row that anchors collapsed work stays, since it carries the way to load that work.
 */
export function groupTurns(
  rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): ReadonlyArray<TimelineTurn> {
  const turns: Array<{
    key: string;
    runId: string | null;
    rows: OrchestrationV2ProjectedTurnItem[];
  }> = [];
  for (const row of rows) {
    if (rowKind(row.item) === null && row.item.deferredWork === undefined) continue;
    const runId = row.item.runId;
    const last = turns.at(-1);
    if (last !== undefined && runId !== null && last.runId === runId) last.rows.push(row);
    else turns.push({ key: row.item.id, runId, rows: [row] });
  }
  return turns;
}

export interface PlanStepChip {
  /** 1-based; equals `total` once every step is done. */
  readonly number: number;
  readonly total: number;
  readonly text: string;
  readonly steps: ReadonlyArray<{ readonly id: string; readonly status: string }>;
}

/**
 * Where the agent is in the latest run's plan: the running step, else the first not done.
 * A plan from an earlier run says nothing about this one.
 */
export function planStepChip(
  turnItems: ReadonlyArray<ThreadStructureTurnItem>,
  latestRunId: string | null,
): PlanStepChip | null {
  const plan = turnItems.findLast((item) => item.type === "todo_list");
  if (plan?.type !== "todo_list" || plan.steps.length === 0) return null;
  if (latestRunId === null || plan.runId !== latestRunId) return null;
  const { steps } = plan;
  const running = steps.findIndex((step) => step.status === "running");
  const index = running !== -1 ? running : steps.findIndex((step) => step.status !== "completed");
  const at = index === -1 ? steps.length - 1 : index;
  return {
    number: at + 1,
    total: steps.length,
    text: steps[at]!.text,
    steps: steps.map(({ id, status }) => ({ id, status })),
  };
}

const BACKGROUND_NOUN: Record<OrchestrationV2PendingBackgroundTask["kind"], string> = {
  subagent: "un subagente",
  command: "un comando",
  monitor: "un monitor",
  background_task: "una tarea en segundo plano",
};

export interface BackgroundWork {
  /**
   * «Subagente trabajando · <tarea>», or how many when there are several. «Te espera» only when
   * one of its threads asks the user something: the agent waiting on its own work is not that.
   */
  readonly title: string;
  /** When its one task started; null with several, as T3 shows no single clock for them. */
  readonly startedAtMs: number | null;
  readonly tasks: ReadonlyArray<{
    readonly taskId: string;
    readonly label: string;
    readonly asksYou: boolean;
    readonly childThreadId: ThreadId | undefined;
  }>;
}

/**
 * This machine's threads that ask the user now, newline-joined so readers re-render only when
 * the list changes. A child whose own subagent asks counts too: the question reaches the user
 * through it.
 */
export function askingThreadIds(
  shells: ReadonlyArray<
    Parameters<typeof threadState>[0] & Pick<EnvironmentThreadShell, "environmentId" | "id">
  >,
  environmentId: string,
): string {
  return shells
    .filter((shell) => shell.environmentId === environmentId && threadState(shell) === "needs-you")
    .map((shell) => shell.id)
    .join("\n");
}

/**
 * Work an earlier run left going, such as a delegated task, as the bar above the composer says
 * it. `askingThreadIds` are the threads that wait on the user right now.
 */
export function backgroundWork(
  structure: ThreadStructure,
  askingThreadIds: ReadonlySet<string> = new Set(),
): BackgroundWork | null {
  const pending = deriveThreadPendingBackgroundTasks(structure);
  const work = presentPendingBackgroundWork(pending);
  if (work === null) return null;
  const tasks = work.items.map((item) => {
    const task = pending.find((candidate) => candidate.taskId === item.taskId)!;
    const named = task.description?.trim();
    return {
      taskId: item.taskId,
      label: named ? item.label : BACKGROUND_NOUN[item.kind],
      asksYou: item.childThreadId !== undefined && askingThreadIds.has(item.childThreadId),
      childThreadId: item.childThreadId,
    };
  });
  const verb = tasks.some((task) => task.asksYou)
    ? "Te espera"
    : work.items.every((item) => item.kind === "subagent")
      ? tasks.length === 1
        ? "Subagente trabajando"
        : "Subagentes trabajando"
      : "En marcha";
  const [only] = tasks.length === 1 ? tasks : [];
  const started =
    only === undefined
      ? undefined
      : pendingBackgroundTaskItem(
          pending.find((task) => task.taskId === only.taskId)!,
          structure.turnItems,
        )?.startedAt;
  return {
    title: `${verb} · ${only === undefined ? `${tasks.length} tareas` : only.label}`,
    startedAtMs: started ? DateTime.toEpochMillis(started) : null,
    tasks,
  };
}

/** A subagent card's clock: running time while it works, its whole run once it ended. */
export function subagentElapsedMs(
  item: Extract<OrchestrationV2TurnItem, { type: "subagent" }>,
  nowMs: number,
): number | null {
  const iso = (value: DateTime.Utc | null) => (value === null ? null : DateTime.formatIso(value));
  return deriveSubagentElapsedMs(
    { status: item.status, startedAt: iso(item.startedAt), completedAt: iso(item.completedAt) },
    nowMs,
  );
}

/** Elapsed time the Spanish way: «52 s», «3 min 05 s», «1 h 05 min». */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const pad = (value: number) => String(value).padStart(2, "0");
  if (minutes === 0) return `${seconds} s`;
  if (minutes < 60) return `${minutes} min ${pad(seconds % 60)} s`;
  return `${Math.floor(minutes / 60)} h ${pad(minutes % 60)} min`;
}

/** What the open run does now, as T3 shows it at the end of a thread, in Spanish; null when nothing. */
export function liveActivity(structure: ThreadStructure): string | null {
  const runtime = deriveThreadStructureRuntime(structure);
  const run = deriveThreadActivityRun(structure);
  // Its approval or question shows below; nothing is thinking meanwhile.
  const asks = structure.runtimeRequests.some((request) => request.status === "pending");
  if (asks || runtime === null || run === null || run.turnEnded === true) {
    return null;
  }
  switch (runtime.status) {
    case "preparing":
      return "Preparando el espacio de trabajo";
    case "queued":
      return "En cola";
    case "starting":
    case "running":
      break;
    default:
      return null;
  }
  if (run.providerStartingLabel !== undefined) {
    const instance = structure.runs.find(
      (candidate) => candidate.id === run.runId,
    )?.providerInstanceId;
    const driver = structure.providerSessions.findLast(
      (session) => session.providerInstanceId === instance,
    )?.driver;
    const name = driver === undefined ? undefined : PROVIDER_DISPLAY_NAMES[driver];
    return name === undefined ? "Arrancando" : `Arrancando ${name}`;
  }
  const latest = structure.turnItems.findLast(
    (item) =>
      item.runId === run.runId &&
      (TOOL_TYPES.has(item.type) || item.type === "assistant_message" || item.type === "reasoning"),
  );
  if (latest !== undefined && TOOL_TYPES.has(latest.type) && latest.status === "running") {
    return latest.type === "subagent"
      ? `Subagente trabajando · ${latest.title?.trim() || "sin título"}`
      : "Trabajando";
  }
  return "Pensando";
}
