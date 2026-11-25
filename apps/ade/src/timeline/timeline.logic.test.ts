import type { OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { groupTurns, liveActivity, planStepChip } from "./timeline.logic.ts";

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

describe("liveActivity", () => {
  const at = DateTime.makeUnsafe("2026-11-25T08:00:00.000Z");
  const instance = "claude";
  const run = (id: string, ordinal: number, status: string) => ({
    id,
    ordinal,
    status,
    providerInstanceId: instance,
    activeAttemptId: `attempt-${id}`,
    requestedAt: at,
    startedAt: at,
    completedAt: status === "running" ? null : at,
  });
  // The provider opened its turn, so the run is past "Arrancando".
  const providerTurn = (runId: string) => ({
    id: `turn-${runId}`,
    runAttemptId: `attempt-${runId}`,
    ordinal: 1,
    status: "running",
    startedAt: at,
    completedAt: null,
  });
  const item = (type: string, status: string, extra: Record<string, unknown> = {}) => ({
    id: `item-${type}`,
    type,
    status,
    runId: "run-2",
    ...extra,
  });
  const structure = (extra: Record<string, unknown> = {}) =>
    ({
      thread: { providerInstanceId: instance, activeProviderThreadId: null, pullRequests: [] },
      runs: [run("run-2", 2, "running")],
      providerTurns: [providerTurn("run-2")],
      providerSessions: [],
      providerThreads: [],
      runtimeRequests: [],
      messages: [],
      turnItems: [item("reasoning", "completed")],
      ...extra,
    }) as never;

  it("says the agent thinks between tools, and names the subagent it waits on", () => {
    expect(liveActivity(structure()).now).toBe("Pensando");
    const subagent = item("subagent", "running", { title: "Actualizar servidores" });
    expect(liveActivity(structure({ turnItems: [subagent] })).now).toBe(
      "Esperando a Actualizar servidores",
    );
  });

  it("claims nothing while the agent asks, or once its turn ended", () => {
    const asking = structure({ runtimeRequests: [{ id: "request-1", status: "pending" }] });
    expect(liveActivity(asking).now).toBeNull();
    const ended = structure({ providerTurns: [{ ...providerTurn("run-2"), status: "completed" }] });
    expect(liveActivity(ended).now).toBeNull();
  });

  it("names a delegated task an earlier run left going while a new run thinks", () => {
    const delegated = structure({
      runs: [run("run-1", 1, "completed"), run("run-2", 2, "running")],
      providerThreads: [
        {
          id: "provider-thread-1",
          providerInstanceId: instance,
          pendingBackgroundTasks: [
            { taskId: "task-1", kind: "subagent", description: "Actualizar servidores F8-F9" },
          ],
        },
      ],
    });
    expect(liveActivity(delegated)).toEqual({
      now: "Pensando",
      background: "Esperando · Actualizar servidores F8-F9",
    });
  });
});
