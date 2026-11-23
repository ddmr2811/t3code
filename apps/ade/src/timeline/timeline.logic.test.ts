import type { OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groupTurns } from "./timeline.logic.ts";

// Only the fields grouping reads; the rest of a real item does not change the outcome.
const row = (
  id: string,
  type: string,
  runId: string | null,
  extra: Record<string, unknown> = {},
): OrchestrationV2ProjectedTurnItem =>
  ({ sourceItemId: id, item: { id, type, runId, text: "x", ...extra } }) as never;

describe("groupTurns", () => {
  it("cuts turns at each run and keeps rows outside a run on their own", () => {
    const turns = groupTurns([
      row("u1", "user_message", "run-a"),
      row("cp", "checkpoint", "run-a"),
      row("a1", "assistant_message", "run-a"),
      row("n1", "system_notice", null),
      row("n2", "system_notice", null),
      row("u2", "user_message", "run-b"),
      row("cp2", "checkpoint", "run-b", { deferredWork: { cursor: "c", itemCount: 3 } }),
      row("e2", "error", "run-b"),
    ]);
    expect(turns.map((turn) => turn.rows.map((r) => r.item.id))).toEqual([
      ["u1", "a1"],
      ["n1"],
      ["n2"],
      ["u2", "cp2", "e2"],
    ]);
  });
});
