import type { ThreadStructureTurnItem } from "@t3tools/client-runtime/state/models";
import type { OrchestrationV2ProjectedTurnItem, OrchestrationV2TurnItem } from "@t3tools/contracts";

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
