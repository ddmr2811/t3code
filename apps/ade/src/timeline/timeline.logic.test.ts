import type { OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groupTurns, planStepChip } from "./timeline.logic.ts";

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

describe("planStepChip", () => {
  const plan = (...statuses: string[]) =>
    ({
      type: "todo_list",
      runId: "run-b",
      steps: statuses.map((status, i) => ({ id: `s${i}`, text: `Paso ${i}`, status })),
    }) as never;

  it("reads the latest plan, and the running step over an earlier one left pending", () => {
    const chip = planStepChip(
      [plan("running", "pending"), plan("completed", "pending", "running", "pending")],
      "run-b",
    );
    expect(chip).toMatchObject({ number: 3, total: 4, text: "Paso 2" });
  });

  it("without a running step, points at the first step not done", () => {
    expect(planStepChip([plan("completed", "pending", "pending")], "run-b")?.number).toBe(2);
  });

  it("shows nothing for a plan left by an earlier run", () => {
    expect(planStepChip([plan("completed", "running")], "run-c")).toBeNull();
  });
});
