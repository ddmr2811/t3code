import {
  EnvironmentId,
  type ForkTailnetPeer,
  type ForkTailnetStatus,
  USAGE_CONTRACT_VERSION,
} from "@t3tools/contracts";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import { describe, expect, it } from "vite-plus/test";

import {
  activeThreads,
  dashboardSpend,
  machineLoad,
  onlineSummary,
  orderMachines,
  pickTailnetSource,
  splitAroundHub,
  tailnetOnlyPeers,
} from "./dashboard.logic";

const dev = EnvironmentId.make("env-dev");
const nexo = EnvironmentId.make("env-nexo");
const pc = EnvironmentId.make("env-pc");

describe("machineLoad", () => {
  it("turns a host sample into shares of the whole machine", () => {
    expect(
      machineLoad({
        sampledAt: 1,
        cpuUtilization: 0.25,
        cpuCount: 8,
        availableMemoryBytes: 4,
        totalMemoryBytes: 16,
      }),
    ).toEqual({
      cpuShare: 0.25,
      memoryShare: 0.75,
      cores: 8,
      usedMemoryBytes: 12,
      totalMemoryBytes: 16,
    });
  });

  it("knows nothing without a sample or without memory figures", () => {
    expect(machineLoad(null).cpuShare).toBe(null);
    expect(
      machineLoad({
        sampledAt: 1,
        cpuUtilization: null,
        cpuCount: 0,
        availableMemoryBytes: 0,
        totalMemoryBytes: 0,
      }),
    ).toEqual({
      cpuShare: null,
      memoryShare: null,
      cores: null,
      usedMemoryBytes: null,
      totalMemoryBytes: null,
    });
  });
});

describe("machine layout", () => {
  const machines = [
    { environmentId: nexo, label: "nexo", connected: false },
    { environmentId: pc, label: "Desk", connected: true },
    { environmentId: dev, label: "dev-box", connected: true },
  ];

  it("puts connected machines first, then by name, and counts them", () => {
    expect(orderMachines(machines).map((machine) => machine.label)).toEqual([
      "Desk",
      "dev-box",
      "nexo",
    ]);
    expect(onlineSummary(machines)).toBe("2 of 3 up");
  });

  it("splits the map's wings with the odd machine on the left", () => {
    expect(splitAroundHub([1, 2, 3])).toEqual({ left: [1, 2], right: [3] });
    expect(splitAroundHub([1, 2])).toEqual({ left: [1], right: [2] });
    expect(splitAroundHub([])).toEqual({ left: [], right: [] });
  });
});

const peer = (overrides: Partial<ForkTailnetPeer> & { readonly id: string }): ForkTailnetPeer => ({
  hostName: overrides.id,
  dnsName: "",
  os: "linux",
  addresses: [],
  online: true,
  connection: "idle",
  relay: null,
  lastSeen: null,
  latencyMs: null,
  ...overrides,
});

const status = (
  self: string,
  peers: ReadonlyArray<ForkTailnetPeer> = [],
  available = true,
): ForkTailnetStatus => ({
  checkedAt: "2026-11-15T20:00:00.000Z",
  available,
  problem: available ? null : "Tailscale is not installed on this machine.",
  self: { id: self, hostName: self, dnsName: "", os: "linux", addresses: [] },
  peers,
});

describe("tailnetOnlyPeers", () => {
  const environments = [
    { environmentId: dev, label: "dev-box", connected: true },
    { environmentId: nexo, label: "Nexo", connected: true },
    { environmentId: pc, label: "Dani's PC", connected: true },
  ];
  const peers = [
    peer({ id: "nNexo", hostName: "nexo-server", dnsName: "nexo.tail0.ts.net" }),
    peer({ id: "nPc", hostName: "Desk" }),
    peer({ id: "nProd", hostName: "prod-box", latencyMs: 40, connection: "relay" }),
    peer({ id: "nOld", hostName: "old-box", online: false, connection: "offline" }),
  ];

  it("drops peers that a connected server reports as itself or that share a machine's name", () => {
    const view = tailnetOnlyPeers({
      sourceEnvironmentId: dev,
      readings: [
        { environmentId: dev, status: status("nDev", peers) },
        // The PC's own reading names it, though its label matches no host name.
        { environmentId: pc, status: status("nPc") },
        { environmentId: nexo, status: null },
      ],
      environments,
    });
    expect(view?.sourceEnvironmentId).toBe(dev);
    expect(view?.peers.map((entry) => entry.hostName)).toEqual(["prod-box", "old-box"]);
  });

  it("has nothing to show when the source has no Tailscale", () => {
    expect(
      tailnetOnlyPeers({
        sourceEnvironmentId: dev,
        readings: [{ environmentId: dev, status: status("nDev", peers, false) }],
        environments,
      }),
    ).toBe(null);
    expect(tailnetOnlyPeers({ sourceEnvironmentId: null, readings: [], environments })).toBe(null);
    expect(
      tailnetOnlyPeers({
        sourceEnvironmentId: dev,
        readings: [{ environmentId: dev, status: null }],
        environments,
      }),
    ).toBe(null);
  });
});

describe("pickTailnetSource", () => {
  it("prefers the local server, then the first machine that can answer", () => {
    const candidates = [
      { environmentId: nexo, supported: true },
      { environmentId: dev, supported: true },
      { environmentId: pc, supported: false },
    ];
    expect(pickTailnetSource(candidates, dev)).toBe(dev);
    expect(pickTailnetSource(candidates, pc)).toBe(nexo);
    expect(pickTailnetSource([{ environmentId: pc, supported: false }], pc)).toBe(null);
  });
});

describe("dashboardSpend", () => {
  it("reports the merged totals by provider and names the machines they come from", () => {
    const empty = mergeUsage([], USAGE_CONTRACT_VERSION);
    const provider = (
      kind: "claude" | "codex" | "cursor",
      costUsd: number,
      records: number,
      totalTokens: number,
    ) => ({
      provider: kind,
      costUsd,
      records,
      totalTokens,
      sessions: 1,
      costShare: 0,
      tokenShare: 0,
    });
    const spend = dashboardSpend(
      {
        ...empty,
        costUsd: 150,
        records: 30,
        totalTokens: 9_000,
        providers: [
          provider("codex", 50, 10, 4_000),
          provider("claude", 100, 20, 5_000),
          provider("cursor", 0, 0, 0),
        ],
        contributingEnvironments: [dev, nexo, pc],
      },
      new Map([
        [dev, "dev-box"],
        [nexo, "nexo"],
      ]),
    );
    expect(spend).toEqual({
      costUsd: 150,
      requests: 30,
      tokens: 9_000,
      providers: [
        { provider: "claude", costUsd: 100, requests: 20, tokens: 5_000 },
        { provider: "codex", costUsd: 50, requests: 10, tokens: 4_000 },
      ],
      machines: ["dev-box", "nexo", "env-pc"],
    });
  });
});

describe("activeThreads", () => {
  type Input = Parameters<typeof activeThreads>[0][number];
  const run = (status: string) =>
    ({
      runId: "run-1",
      status,
      requestedAt: null,
      startedAt: null,
      completedAt: null,
      assistantMessageId: null,
    }) as Input["latestRun"];
  const thread = (name: string, overrides: Partial<Input> = {}): Input & { name: string } => ({
    name,
    archivedAt: null,
    deletedAt: null,
    lineage: { relationshipToParent: null, sideChat: false } as Input["lineage"],
    settledOverride: null,
    snoozedUntil: null,
    updatedAt: "2026-11-15T10:00:00.000Z",
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    pendingGuestMessageCount: 0,
    interactionMode: "default",
    latestRun: run("completed"),
    runtime: null,
    ...overrides,
  });
  const working = { latestRun: run("running"), runtime: { status: "running" } as Input["runtime"] };
  const now = Date.parse("2026-11-15T12:00:00.000Z");

  it("lists waiting threads before working ones, newest first, and skips the rest", () => {
    const list = activeThreads(
      [
        thread("working", { ...working, updatedAt: "2026-11-15T11:00:00.000Z" }),
        thread("question", { hasPendingUserInput: true }),
        thread("approval", { hasPendingApprovals: true, updatedAt: "2026-11-15T11:30:00.000Z" }),
        thread("done"),
        thread("failed", { latestRun: run("failed") }),
        thread("archived", { hasPendingUserInput: true, archivedAt: "2026-11-15T09:00:00.000Z" }),
        thread("settled", { hasPendingUserInput: true, settledOverride: "settled" }),
        thread("snoozed", { hasPendingUserInput: true, snoozedUntil: "2026-11-16T00:00:00.000Z" }),
        thread("woke", { hasPendingUserInput: true, snoozedUntil: "2026-11-15T11:00:00.000Z" }),
        thread("subagent", {
          ...working,
          lineage: { relationshipToParent: "subagent", sideChat: false } as Input["lineage"],
        }),
      ],
      now,
    );
    expect(list.map((entry) => [entry.thread.name, entry.state, entry.label])).toEqual([
      ["approval", "waiting", "Needs approval"],
      ["question", "waiting", "Asks a question"],
      ["woke", "waiting", "Asks a question"],
      ["working", "working", "Working"],
    ]);
  });
});
