import {
  EnvironmentId,
  type ForkTailnetPeer,
  type ForkTailnetStatus,
  USAGE_CONTRACT_VERSION,
} from "@t3tools/contracts";
import { makeWindow } from "@t3tools/shared/usageFormat";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import { describe, expect, it } from "vite-plus/test";

import {
  activeThreads,
  currentUsageWindow,
  dashboardSpend,
  machineLoad,
  nextRoundTrips,
  onlineSummary,
  orderMachines,
  pickTailnetSource,
  splitAroundHub,
  tailnetEndpointHosts,
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

describe("nextRoundTrips", () => {
  it("keeps the last four whole-millisecond samples", () => {
    let samples: ReadonlyArray<number> = [];
    for (const sample of [208.4, 9.6, 11, 207, 12.2]) samples = nextRoundTrips(samples, sample);
    expect(samples).toEqual([10, 11, 207, 12]);
    expect(Math.min(...samples)).toBe(10);
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
  const nas = EnvironmentId.make("env-nas");
  const offline = EnvironmentId.make("env-offline");
  const environments = [
    { environmentId: dev, label: "dev-box", connected: true },
    { environmentId: nexo, label: "Nexo", connected: true },
    { environmentId: pc, label: "Dani's PC", connected: true },
    { environmentId: nas, label: "NAS", connected: true },
    { environmentId: offline, label: "old-box", connected: false },
  ];
  const peers = [
    peer({ id: "nNexo", hostName: "nexo-server", dnsName: "nexo.tail0.ts.net" }),
    peer({ id: "nPc", hostName: "Desk" }),
    peer({ id: "nProd", hostName: "prod-box", latencyMs: 40, connection: "relay" }),
    peer({ id: "nOld", hostName: "old-box", online: false, connection: "offline" }),
    peer({ id: "nOtherNas", hostName: "nas" }),
    peer({ id: "nDevbox", hostName: "devbox" }),
  ];
  const readings = [
    { environmentId: dev, status: status("nDev", peers) },
    // The PC's own reading names it, though its label matches no host name.
    { environmentId: pc, status: status("nPc") },
    // The NAS environment is a different machine from the tailnet's "nas" peer.
    { environmentId: nas, status: status("nNas") },
    { environmentId: nexo, status: null },
  ];

  it("drops peers a server reports as itself, and by exact name those of unidentified machines", () => {
    const list = tailnetOnlyPeers({ source: status("nDev", peers), readings, environments });
    expect(list?.map((entry) => entry.hostName)).toEqual(["prod-box", "nas", "devbox"]);
  });

  it("lets a known identity win over a matching name", () => {
    // Without the NAS's own reading, its label is all there is, and the name stands in.
    const list = tailnetOnlyPeers({
      source: status("nDev", peers),
      readings: readings.filter((reading) => reading.environmentId !== nas),
      environments,
    });
    expect(list?.map((entry) => entry.hostName)).toEqual(["prod-box", "devbox"]);
  });

  it("matches a server without the tailnet call by the tailnet endpoint it advertises", () => {
    // "jarvisvps" runs a server that does not report itself; its endpoint holds jarvis's IP.
    const vps = EnvironmentId.make("env-vps");
    const tailnet = [
      peer({ id: "nJarvis", hostName: "jarvis", addresses: ["100.116.26.117", "fd7a::7"] }),
      peer({ id: "nProd", hostName: "prod-box", dnsName: "prod-box.tail0.ts.net" }),
      peer({ id: "nVps", hostName: "jarvisvps" }),
    ];
    const hidden = (environment: Parameters<typeof tailnetOnlyPeers>[0]["environments"][number]) =>
      tailnetOnlyPeers({
        source: status("nDev", tailnet),
        readings: [],
        environments: [environment],
      })?.map((entry) => entry.hostName);
    const base = { environmentId: vps, label: "jarvisvps", connected: true };
    // The endpoint identifies the machine, so its label no longer hides the "jarvisvps" peer.
    expect(hidden({ ...base, tailnetHosts: ["100.116.26.117"] })).toEqual([
      "prod-box",
      "jarvisvps",
    ]);
    expect(hidden({ ...base, tailnetHosts: ["prod-box.tail0.ts.net"] })).toEqual([
      "jarvis",
      "jarvisvps",
    ]);
    // An endpoint no peer holds identifies nothing; the host name stands in, not the label too.
    expect(hidden({ ...base, tailnetHosts: ["100.64.0.99"], hostname: "jarvis" })).toEqual([
      "prod-box",
      "jarvisvps",
    ]);
    // Without a host name, as for an offline machine, the label is all there is.
    expect(hidden(base)).toEqual(["jarvis", "prod-box"]);
  });

  it("reads the host of each advertised tailnet endpoint and skips LAN ones", () => {
    expect(
      tailnetEndpointHosts([
        { kind: "tailnet", httpBaseUrl: "http://100.116.26.117:3773/" },
        { kind: "tailnet", httpBaseUrl: "https://Jarvis.tail0.ts.net/" },
        { kind: "tailnet", httpBaseUrl: "http://[fd7a:115c:a1e0::7]:3773/" },
        { kind: "lan", httpBaseUrl: "http://192.168.1.20:3773/" },
        { kind: "tailnet", httpBaseUrl: "not a url" },
      ]),
    ).toEqual(["100.116.26.117", "jarvis.tail0.ts.net", "fd7a:115c:a1e0::7"]);
    expect(tailnetEndpointHosts(undefined)).toEqual([]);
  });

  it("has nothing to show when the source has no Tailscale", () => {
    expect(tailnetOnlyPeers({ source: status("nDev", peers, false), readings, environments })).toBe(
      null,
    );
    expect(tailnetOnlyPeers({ source: null, readings, environments })).toBe(null);
  });
});

describe("pickTailnetSource", () => {
  const reading = (environmentId: EnvironmentId, available: boolean | null) => ({
    environmentId,
    status: available === null ? null : status(`self-${environmentId}`, [], available),
  });

  it("prefers the local server, then the others in order", () => {
    expect(pickTailnetSource([nexo, dev], dev, [])).toBe(dev);
    expect(pickTailnetSource([nexo, dev], pc, [])).toBe(nexo);
    expect(pickTailnetSource([], pc, [])).toBe(null);
  });

  it("hands over to the next machine when Tailscale is not available on the chosen one", () => {
    expect(pickTailnetSource([nexo, dev], dev, [reading(dev, false), reading(nexo, true)])).toBe(
      nexo,
    );
    // One still loading keeps its turn rather than flipping between machines.
    expect(pickTailnetSource([nexo, dev], dev, [reading(dev, null), reading(nexo, true)])).toBe(
      dev,
    );
    expect(pickTailnetSource([nexo, dev], dev, [reading(dev, false), reading(nexo, false)])).toBe(
      null,
    );
  });
});

describe("currentUsageWindow", () => {
  it("keeps the same window through the day and moves it once the day changes", () => {
    const morning = new Date(2026, 10, 15, 9, 0);
    const window = makeWindow(7, morning);
    expect(currentUsageWindow(window, new Date(2026, 10, 15, 23, 59))).toBe(window);
    const next = currentUsageWindow(window, new Date(2026, 10, 16, 0, 1));
    expect(next).not.toBe(window);
    expect(next.untilDay).toBe(makeWindow(7, new Date(2026, 10, 16, 12, 0)).untilDay);
    expect(next.sinceDay > window.sinceDay).toBe(true);
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
