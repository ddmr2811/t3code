import {
  AuthProvidersManageScope,
  EnvironmentId,
  type ForkExtensionsSnapshot,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useForkExtensions } from "./useForkExtensions";

interface ListAtom {
  readonly label: string;
  readonly key: string;
}

const state = vi.hoisted(() => ({
  identities: [] as Array<{ environmentId: string; label: string }>,
  presentations: new Map<string, unknown>(),
  sessions: new Map<string, unknown>(),
  snapshots: new Map<string, unknown>(),
  health: new Map<string, unknown>(),
  reads: [] as Array<{ label: string; key: string }>,
  registry: { refresh: vi.fn() },
  requestHealth: vi.fn(),
}));

vi.mock("react", () => ({ useContext: () => state.registry }));
vi.mock("@effect/atom-react", () => ({
  RegistryContext: {},
  useAtomValue: (atom: ListAtom) => {
    state.reads.push(atom);
    const source =
      atom.label === "sessions"
        ? state.sessions
        : atom.label === "web-fork-extensions-snapshots"
          ? state.snapshots
          : state.health;
    return atom.key === "" ? [] : atom.key.split("\n").map((id) => source.get(id));
  },
}));
vi.mock("../../state/environmentAtomList", () => ({
  environmentIdsKey: (ids: ReadonlyArray<string>) => ids.join("\n"),
  environmentAtomList: (label: string) => (key: string) => ({ label, key }),
}));
vi.mock("../../state/session", () => ({
  environmentSessionStatesAtom: (key: string) => ({ label: "sessions", key }),
}));
vi.mock("../../state/environments", () => ({
  useEnvironmentIdentities: () => state.identities,
  useEnvironments: () => ({ presentationById: state.presentations }),
}));
vi.mock("../../state/forkExtensions", () => ({
  forkExtensionsSnapshotAtom: (environmentId: string) => ({ snapshotOf: environmentId }),
  forkExtensionsMachineHealth: (environmentId: string) => ({ healthOf: environmentId }),
  requestForkHealthCheck: state.requestHealth,
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    scope: { environmentIds: state.identities.map((identity) => identity.environmentId) },
  }),
}));

const PC = EnvironmentId.make("env-pc");
const OLD = EnvironmentId.make("env-old");
const VPS = EnvironmentId.make("env-vps");
const SHARED = EnvironmentId.make("env-shared");

const operator = { authenticated: true, scopes: [AuthProvidersManageScope] };

const snapshot: ForkExtensionsSnapshot = {
  protocolVersion: 1,
  agents: [{ agent: "claude", available: true }],
  projects: [],
  items: [
    {
      id: "mcp:playwright",
      kind: "mcp",
      name: "playwright",
      source: "npx @playwright/mcp",
      transport: "stdio",
      pluginId: null,
      readOnly: false,
      cells: [
        {
          agent: "claude",
          state: "unknown",
          scopes: ["user"],
          projects: [],
          problem: null,
          usageCount: 0,
          lastUsedAt: null,
          stashDiscarded: false,
        },
      ],
    },
  ],
  healthCheckedAt: null,
};

function addMachine(
  environmentId: EnvironmentId,
  label: string,
  options: {
    readonly phase?: string;
    readonly forkExtensions?: number;
    readonly session?: unknown;
  },
) {
  state.identities.push({ environmentId, label });
  const capabilities =
    options.forkExtensions === undefined ? {} : { forkExtensions: options.forkExtensions };
  state.presentations.set(environmentId, {
    connection: { phase: options.phase ?? "connected" },
    serverConfig: { environment: { capabilities } },
  });
  state.sessions.set(environmentId, AsyncResult.success(options.session ?? operator));
}

beforeEach(() => {
  state.identities.length = 0;
  state.presentations.clear();
  state.sessions.clear();
  state.snapshots.clear();
  state.health.clear();
  state.reads.length = 0;
  state.registry.refresh.mockClear();
  state.requestHealth.mockClear();
  addMachine(PC, "This PC", { forkExtensions: 1 });
  addMachine(OLD, "Old laptop", {});
  addMachine(VPS, "VPS", { phase: "offline", forkExtensions: 1 });
  addMachine(SHARED, "Shared", {
    forkExtensions: 1,
    session: { authenticated: true, scopes: [] },
  });
  state.snapshots.set(PC, AsyncResult.success(snapshot));
  state.snapshots.set(SHARED, AsyncResult.initial(true));
  for (const id of [PC, SHARED]) {
    state.health.set(id, { decision: { decided: true, active: false }, result: null });
  }
});

describe("useForkExtensions", () => {
  it("asks only machines that speak the protocol, including read-only ones (Review Focus 4)", () => {
    const { machines } = useForkExtensions();

    expect(
      state.reads.filter((read) => read.label !== "sessions").map((read) => [read.label, read.key]),
    ).toEqual([
      [
        "web-fork-extensions-snapshots",
        `${PC}
${SHARED}`,
      ],
      [
        "web-fork-extensions-health",
        `${PC}
${SHARED}`,
      ],
    ]);
    expect(machines.map((machine) => [machine.label, machine.support, machine.canOperate])).toEqual(
      [
        ["This PC", "supported", true],
        ["Old laptop", "needsForkUpdate", false],
        ["VPS", "offline", false],
        ["Shared", "supported", false],
      ],
    );
    expect(machines[0]!.snapshot).toBe(snapshot);
    expect(machines.slice(1).every((machine) => machine.snapshot === null)).toBe(true);
    expect(machines.map((machine) => machine.isPending)).toEqual([false, false, false, true]);
  });

  it("asks a machine whose operate access is still loading for its snapshot right away", () => {
    state.sessions.set(SHARED, AsyncResult.initial(true));
    const shared = useForkExtensions().machines[3]!;
    expect(shared.support).toBe("supported");
    expect(shared.canOperate).toBe(false);
    expect(state.reads.at(-2)).toEqual({
      label: "web-fork-extensions-snapshots",
      key: `${PC}
${SHARED}`,
    });
  });

  it("stays settled while a snapshot it already shows refetches", () => {
    state.snapshots.set(PC, AsyncResult.success(snapshot, { waiting: true }));
    const pc = useForkExtensions().machines[0]!;
    expect(pc.isPending).toBe(false);
    expect(pc.snapshot).toBe(snapshot);
  });

  it("lays a running health check over the snapshot", () => {
    state.health.set(PC, {
      decision: { decided: true, active: true },
      result: AsyncResult.success(
        {
          cells: [{ itemId: "mcp:playwright", agent: "claude", state: "working", problem: null }],
          checkedAt: null,
        },
        { waiting: true },
      ),
    });
    const pc = useForkExtensions().machines[0]!;
    expect(pc.isCheckingHealth).toBe(true);
    expect(pc.snapshot?.items[0]?.cells[0]?.state).toBe("working");
  });

  it("refreshes and checks only machines that speak the protocol", () => {
    const view = useForkExtensions();
    view.refresh();
    view.checkHealth();
    view.checkHealth(OLD);
    expect(state.registry.refresh.mock.calls).toEqual([
      [{ snapshotOf: PC }],
      [{ snapshotOf: SHARED }],
    ]);
    expect(state.requestHealth.mock.calls).toEqual([
      [state.registry, PC],
      [state.registry, SHARED],
    ]);
  });
});
