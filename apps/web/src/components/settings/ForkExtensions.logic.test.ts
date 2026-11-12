import {
  EnvironmentId,
  type ForkExtensionCell,
  type ForkExtensionItem,
  type ForkExtensionProblem,
  type ForkExtensionsSnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  applyHealthProgress,
  buildMatrix,
  classifyMachineSupport,
  EMPTY_HEALTH_PROGRESS,
  HEALTH_STALE_MS,
  isForkHealthRunning,
  isHealthStale,
  isSnapshotCell,
  nextHealthDecision,
  type MachineState,
  reduceHealthEvent,
} from "./ForkExtensions.logic";

const PC = EnvironmentId.make("env-pc");
const VPS = EnvironmentId.make("env-vps");
const OLD = EnvironmentId.make("env-old");
const onlyClaude = { agent: "claude", available: true } as const;

const npxMissing: ForkExtensionProblem = {
  reason: "binaryNotFound",
  summary: "npx not found",
  nextStep: "Install Node.js on this machine.",
  rawOutput: null,
};

function cell(
  agent: ForkExtensionCell["agent"],
  overrides: Partial<ForkExtensionCell> = {},
): ForkExtensionCell {
  return {
    agent,
    state: "working",
    scopes: ["user"],
    projects: [],
    problem: null,
    usageCount: 0,
    lastUsedAt: null,
    stashDiscarded: false,
    ...overrides,
  };
}

function mcp(name: string, cells: ReadonlyArray<ForkExtensionCell>): ForkExtensionItem {
  return {
    id: `mcp:${name}`,
    kind: "mcp",
    name,
    source: `npx ${name}`,
    transport: "stdio",
    pluginId: null,
    readOnly: false,
    cells,
  };
}

function snapshot(
  items: ReadonlyArray<ForkExtensionItem>,
  overrides: Partial<ForkExtensionsSnapshot> = {},
): ForkExtensionsSnapshot {
  return {
    protocolVersion: 1,
    agents: [
      { agent: "claude", available: true },
      { agent: "codex", available: true },
    ],
    projects: [],
    items,
    healthCheckedAt: null,
    ...overrides,
  };
}

function machine(
  environmentId: EnvironmentId,
  label: string,
  overrides: Partial<MachineState> = {},
): MachineState {
  return {
    environmentId,
    label,
    support: "supported",
    canOperate: true,
    snapshot: null,
    error: null,
    isPending: false,
    isCheckingHealth: false,
    healthError: null,
    ...overrides,
  };
}

describe("buildMatrix", () => {
  it("joins rows by item id and marks a machine without the item as notInstalled", () => {
    const playwright = mcp("playwright", [cell("claude"), cell("codex")]);
    const matrix = buildMatrix(
      [
        machine(PC, "This PC", { snapshot: snapshot([playwright]) }),
        machine(VPS, "VPS", { snapshot: snapshot([]) }),
      ],
      "mcp",
    );

    expect(matrix.columns.map((column) => [column.machineLabel, column.agent])).toEqual([
      ["This PC", "claude"],
      ["This PC", "codex"],
      ["VPS", "claude"],
      ["VPS", "codex"],
    ]);
    expect(matrix.rows).toHaveLength(1);
    const row = matrix.rows[0]!;
    expect(row.item).toBe(playwright);
    expect(row.cells).toEqual([
      playwright.cells[0],
      playwright.cells[1],
      { state: "notInstalled" },
      { state: "notInstalled" },
    ]);
  });

  it("keeps the first machine's item and finds each machine's own cell", () => {
    const onPc = mcp("notion", [cell("claude", { usageCount: 3 })]);
    const onVps = mcp("notion", [cell("claude", { state: "disabled", usageCount: 4 })]);
    const matrix = buildMatrix(
      [
        machine(PC, "This PC", { snapshot: snapshot([onPc], { agents: [onlyClaude] }) }),
        machine(VPS, "VPS", { snapshot: snapshot([onVps], { agents: [onlyClaude] }) }),
      ],
      "mcp",
    );
    expect(matrix.rows[0]!.item).toBe(onPc);
    expect(matrix.rows[0]!.cells).toEqual([onPc.cells[0], onVps.cells[0]]);
    expect(matrix.rows[0]!.usageTotal).toBe(7);
  });

  it("keeps each machine's own copy of an item, whose source can differ", () => {
    const onPc = mcp("notion", [cell("claude")]);
    const onVps = { ...mcp("notion", [cell("claude")]), source: "https://mcp.notion.com/mcp" };
    const matrix = buildMatrix(
      [
        machine(PC, "This PC", { snapshot: snapshot([onPc], { agents: [onlyClaude] }) }),
        machine(VPS, "VPS", { snapshot: snapshot([onVps], { agents: [onlyClaude] }) }),
        machine(OLD, "Old", { snapshot: snapshot([], { agents: [onlyClaude] }) }),
      ],
      "mcp",
    );
    const row = matrix.rows[0]!;
    expect(row.item.source).toBe("npx notion");
    expect([...row.itemsByMachine]).toEqual([
      [PC, onPc],
      [VPS, onVps],
    ]);
  });

  it("gives a machine that needs a fork update one column and no installable cells", () => {
    const playwright = mcp("playwright", [cell("claude"), cell("codex")]);
    const matrix = buildMatrix(
      [
        machine(PC, "This PC", { snapshot: snapshot([playwright]) }),
        machine(OLD, "Old laptop", { support: "needsForkUpdate" }),
      ],
      "mcp",
    );

    expect(matrix.columns.at(-1)).toEqual({
      key: `${OLD}:machine`,
      environmentId: OLD,
      machineLabel: "Old laptop",
      agent: null,
      support: "needsForkUpdate",
      canOperate: false,
      problem: null,
    });
    const cells = matrix.rows[0]!.cells;
    expect(cells).toHaveLength(3);
    expect(cells[2]).toEqual({ state: "needsForkUpdate" });
    expect(cells.some((candidate) => candidate.state === "notInstalled")).toBe(false);
  });

  it("shows an offline machine as one column with its own state", () => {
    const matrix = buildMatrix(
      [
        machine(PC, "This PC", { snapshot: snapshot([mcp("a", [cell("claude")])]) }),
        machine(VPS, "VPS", { support: "offline", canOperate: false }),
      ],
      "mcp",
    );
    expect(
      matrix.columns.slice(2).map((column) => [column.agent, column.support, column.canOperate]),
    ).toEqual([[null, "offline", false]]);
    expect(matrix.rows[0]!.cells.slice(2)).toEqual([{ state: "offline" }]);
  });

  it("shows a machine this client may only read with per-agent columns it cannot operate", () => {
    const shared = mcp("a", [cell("claude"), cell("codex", { state: "disabled" })]);
    const matrix = buildMatrix(
      [
        machine(PC, "This PC", { snapshot: snapshot([mcp("a", [cell("claude"), cell("codex")])]) }),
        machine(OLD, "Shared", { canOperate: false, snapshot: snapshot([shared]) }),
      ],
      "mcp",
    );
    expect(
      matrix.columns.map((column) => [column.machineLabel, column.agent, column.canOperate]),
    ).toEqual([
      ["This PC", "claude", true],
      ["This PC", "codex", true],
      ["Shared", "claude", false],
      ["Shared", "codex", false],
    ]);
    expect(matrix.rows[0]!.cells.slice(2)).toEqual(shared.cells);
  });

  it("gives an unavailable agent with a read problem a column that carries the problem", () => {
    const codexBroken: ForkExtensionProblem = {
      reason: "commandFailed",
      summary: "codex mcp list failed",
      nextStep: "Run `codex mcp list` in a terminal to see why.",
      rawOutput: "boom",
    };
    const matrix = buildMatrix(
      [
        machine(PC, "This PC", {
          snapshot: snapshot([mcp("a", [cell("claude")])], {
            agents: [
              { agent: "claude", available: true },
              { agent: "codex", available: false, problem: codexBroken },
            ],
          }),
        }),
      ],
      "mcp",
    );
    expect(matrix.columns).toEqual([
      {
        key: `${PC}:claude`,
        environmentId: PC,
        machineLabel: "This PC",
        agent: "claude",
        support: "supported",
        canOperate: true,
        problem: null,
      },
      {
        key: `${PC}:codex`,
        environmentId: PC,
        machineLabel: "This PC",
        agent: "codex",
        support: "supported",
        canOperate: true,
        problem: codexBroken,
      },
    ]);
    expect(matrix.rows[0]!.cells[1]).toEqual({ state: "agentUnavailable" });
  });

  it("leaves out an agent the machine does not run and a machine still loading", () => {
    const matrix = buildMatrix(
      [
        machine(PC, "This PC", {
          snapshot: snapshot([mcp("a", [cell("claude")])], { agents: [onlyClaude] }),
        }),
        machine(VPS, "VPS", { isPending: true }),
      ],
      "mcp",
    );
    expect(matrix.columns.map((column) => column.key)).toEqual([`${PC}:claude`]);
  });

  it("says notApplicable where another machine says the item does not apply to that agent", () => {
    const connector = {
      ...mcp("claude.ai Gmail", [cell("claude"), cell("codex", { state: "notApplicable" })]),
      transport: "claudeAi" as const,
    };
    const matrix = buildMatrix(
      [
        machine(PC, "This PC", { snapshot: snapshot([connector]) }),
        machine(VPS, "VPS", { snapshot: snapshot([]) }),
      ],
      "mcp",
    );
    expect(matrix.rows[0]!.cells.slice(2)).toEqual([
      { state: "notInstalled" },
      { state: "notApplicable" },
    ]);
  });

  it("keeps only items of the requested kind", () => {
    const skill: ForkExtensionItem = {
      ...mcp("review", [cell("claude")]),
      id: "skill:review",
      kind: "skill",
      transport: null,
    };
    const machines = [machine(PC, "This PC", { snapshot: snapshot([mcp("a", []), skill]) })];
    expect(buildMatrix(machines, "skill").rows.map((row) => row.item.id)).toEqual(["skill:review"]);
    expect(buildMatrix(machines, "plugin").rows).toEqual([]);
  });

  it("sorts rows with problems first, then by total uses, then by name", () => {
    const items = [
      mcp("beta", [cell("claude", { usageCount: 2 })]),
      mcp("alpha", [cell("claude", { usageCount: 2 })]),
      mcp("gamma", [cell("claude", { usageCount: 9 })]),
      mcp("broken", [cell("claude", { state: "needsAttention", problem: npxMissing })]),
    ];
    const matrix = buildMatrix(
      [machine(PC, "This PC", { snapshot: snapshot(items, { agents: [onlyClaude] }) })],
      "mcp",
    );
    expect(matrix.rows.map((row) => [row.item.name, row.hasProblem])).toEqual([
      ["broken", true],
      ["gamma", false],
      ["alpha", false],
      ["beta", false],
    ]);
  });

  it("tells snapshot cells apart from placeholders", () => {
    expect(isSnapshotCell(cell("claude", { state: "notInstalled" }))).toBe(true);
    expect(isSnapshotCell({ state: "notInstalled" })).toBe(false);
    expect(isSnapshotCell({ state: "needsForkUpdate" })).toBe(false);
  });
});

describe("classifyMachineSupport", () => {
  const base = {
    connectionPhase: "connected",
    hasServerConfig: true,
    forkExtensionsVersion: 1,
    operateAccess: "granted",
  } as const;

  it("supports a connected machine that announces the protocol and lets this client operate", () => {
    expect(classifyMachineSupport(base)).toEqual({
      support: "supported",
      isPending: false,
      canOperate: true,
    });
  });

  it("needs a fork update when the capability is absent or older than version 1", () => {
    expect(classifyMachineSupport({ ...base, forkExtensionsVersion: undefined })).toEqual({
      support: "needsForkUpdate",
      isPending: false,
      canOperate: false,
    });
    expect(classifyMachineSupport({ ...base, forkExtensionsVersion: 0 }).support).toBe(
      "needsForkUpdate",
    );
    expect(classifyMachineSupport({ ...base, connectionPhase: "unsupported" }).support).toBe(
      "needsForkUpdate",
    );
  });

  it("is offline while disconnected and pending while it connects", () => {
    expect(classifyMachineSupport({ ...base, connectionPhase: "offline" })).toEqual({
      support: "offline",
      isPending: false,
      canOperate: false,
    });
    expect(classifyMachineSupport({ ...base, connectionPhase: "connecting" })).toEqual({
      support: "offline",
      isPending: true,
      canOperate: false,
    });
    expect(classifyMachineSupport({ ...base, hasServerConfig: false })).toEqual({
      support: "offline",
      isPending: true,
      canOperate: false,
    });
  });

  it("reads a machine without operate access read-only, and does not wait for that access", () => {
    expect(classifyMachineSupport({ ...base, operateAccess: "denied" })).toEqual({
      support: "supported",
      isPending: false,
      canOperate: false,
    });
    expect(classifyMachineSupport({ ...base, operateAccess: "pending" })).toEqual({
      support: "supported",
      isPending: false,
      canOperate: false,
    });
  });
});

describe("health", () => {
  const now = Date.parse("2026-11-12T10:00:00.000Z");

  it("is stale when never checked or checked more than 10 minutes ago", () => {
    expect(HEALTH_STALE_MS).toBe(600_000);
    expect(isHealthStale(null, now)).toBe(true);
    expect(isHealthStale("2026-11-12T09:49:59.000Z", now)).toBe(true);
    expect(isHealthStale("2026-11-12T09:55:00.000Z", now)).toBe(false);
  });

  it("decides once per mount, from the first snapshot, whether opening the page checks health", () => {
    const fresh = snapshot([], { healthCheckedAt: "2026-11-12T09:58:00.000Z" });
    const idle = { wanted: false, nowMs: now };
    const waiting = nextHealthDecision(null, { ...idle, snapshot: null });
    expect(waiting).toEqual({ decided: false, active: false });
    expect(nextHealthDecision(waiting, { ...idle, snapshot: snapshot([]) })).toEqual({
      decided: true,
      active: true,
    });
    const skipped = nextHealthDecision(waiting, { ...idle, snapshot: fresh });
    expect(skipped).toEqual({ decided: true, active: false });
    // A later stale snapshot (10 minutes on the page) does not start one by itself.
    expect(
      nextHealthDecision(skipped, { ...idle, nowMs: now + HEALTH_STALE_MS * 2, snapshot: fresh }),
    ).toBe(skipped);
  });

  it("starts a check when asked and keeps it running once started", () => {
    const fresh = snapshot([], { healthCheckedAt: "2026-11-12T09:58:00.000Z" });
    const skipped = { decided: true, active: false };
    const asked = nextHealthDecision(skipped, { wanted: true, nowMs: now, snapshot: fresh });
    expect(asked).toEqual({ decided: true, active: true });
    expect(nextHealthDecision(asked, { wanted: false, nowMs: now, snapshot: fresh })).toBe(asked);
    expect(nextHealthDecision(null, { wanted: true, nowMs: now, snapshot: null })).toEqual({
      decided: true,
      active: true,
    });
  });

  it("collects health events and the finishing time", () => {
    const progress = [
      {
        _tag: "cell",
        itemId: "mcp:a",
        agent: "claude",
        state: "needsAttention",
        problem: npxMissing,
      } as const,
      { _tag: "done", checkedAt: "2026-11-12T10:00:00.000Z" } as const,
    ].reduce(reduceHealthEvent, EMPTY_HEALTH_PROGRESS);
    expect(progress).toEqual({
      cells: [{ itemId: "mcp:a", agent: "claude", state: "needsAttention", problem: npxMissing }],
      checkedAt: "2026-11-12T10:00:00.000Z",
    });
  });

  it("runs from the first value until done, and a failed check is not running", () => {
    expect(isForkHealthRunning(null)).toBe(false);
    expect(isForkHealthRunning(AsyncResult.initial(true))).toBe(true);
    expect(isForkHealthRunning(AsyncResult.success(EMPTY_HEALTH_PROGRESS))).toBe(true);
    expect(
      isForkHealthRunning(
        AsyncResult.success({ cells: [], checkedAt: "2026-11-12T10:00:00.000Z" }),
      ),
    ).toBe(false);
    expect(isForkHealthRunning(AsyncResult.failure(Cause.fail("boom")))).toBe(false);
  });

  it("lays a newer check over the snapshot, and steps aside once the snapshot catches up", () => {
    const base = snapshot([mcp("a", [cell("claude", { state: "unknown" }), cell("codex")])]);
    const progress = {
      cells: [{ itemId: "mcp:a", agent: "claude", state: "needsAttention", problem: npxMissing }],
      checkedAt: "2026-11-12T10:00:00.000Z",
    } as const;

    const applied = applyHealthProgress(base, progress);
    expect(applied.healthCheckedAt).toBe("2026-11-12T10:00:00.000Z");
    expect(applied.items[0]!.cells[0]).toEqual(
      cell("claude", { state: "needsAttention", problem: npxMissing }),
    );
    expect(applied.items[0]!.cells[1]).toBe(base.items[0]!.cells[1]);

    const caughtUp = snapshot(base.items, { healthCheckedAt: "2026-11-12T10:00:00.000Z" });
    expect(applyHealthProgress(caughtUp, progress)).toBe(caughtUp);
    expect(applyHealthProgress(base, null)).toBe(base);
  });
});
