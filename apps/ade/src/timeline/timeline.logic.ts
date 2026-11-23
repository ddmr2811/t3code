import type { OrchestrationV2ProjectedTurnItem, OrchestrationV2TurnItem } from "@t3tools/contracts";

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
