import {
  EnvironmentId,
  type ForkExtensionCell,
  type ForkExtensionItem,
  type ForkExtensionsSnapshot,
  type ForkInstallResult,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import type { MachineState } from "./ForkExtensions.logic";

// Two linked machines stand in for the environments: the hook that reads them is unit-tested
// (useForkExtensions.test.ts), so this covers what the page does with what it returns.
const state = vi.hoisted(() => ({
  machines: [] as Array<unknown>,
  calls: [] as Array<{ readonly label: string; readonly value: unknown }>,
  results: new Map<string, unknown>(),
  checkHealth: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock(import("./useForkExtensions"), async (original) => ({
  ...(await original()),
  useForkExtensions: (() => ({
    machines: state.machines,
    refresh: state.refresh,
    checkHealth: state.checkHealth,
  })) as never,
}));
vi.mock(import("../../hooks/useNowMinute"), () => ({ useNowMinute: () => "2026-11-12T10:00" }));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: { readonly label: string }) => async (value: unknown) => {
    state.calls.push({ label: command.label, value });
    return AsyncResult.success(state.results.get(command.label));
  }) as never,
}));

import "~/index.css";
import { render } from "../../../test/render";
import { forkExtensionsSetEnabled, forkExtensionsUninstall } from "../../state/forkExtensions";
import { ForkExtensionsSettings } from "./ForkExtensionsSettings";

const PC = EnvironmentId.make("env-pc");
const VPS = EnvironmentId.make("env-vps");
const OLD = EnvironmentId.make("env-old");
// The page reads the clock by the minute (useNowMinute, mocked to 10:00): 12.5 minutes before.
const CHECKED_AT = "2026-11-12T09:47:30.000Z";

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

function mcp(
  name: string,
  cells: ReadonlyArray<ForkExtensionCell>,
  overrides: Partial<ForkExtensionItem> = {},
): ForkExtensionItem {
  return {
    id: `mcp:${name}`,
    kind: "mcp",
    name,
    source: "npx @playwright/mcp@latest",
    transport: "stdio",
    pluginId: null,
    readOnly: false,
    cells,
    ...overrides,
  };
}

function snapshot(items: ReadonlyArray<ForkExtensionItem>): ForkExtensionsSnapshot {
  return {
    protocolVersion: 1,
    agents: [
      { agent: "claude", available: true },
      { agent: "codex", available: true },
    ],
    projects: [],
    items,
    healthCheckedAt: CHECKED_AT,
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

const npxMissing = {
  reason: "binaryNotFound",
  summary: "npx not found",
  nextStep: "Install Node.js on VPS so npx is on its PATH.",
  rawOutput: "spawn npx ENOENT",
} as const;

function twoMachines(): Array<MachineState> {
  return [
    machine(PC, "This PC", {
      snapshot: snapshot([
        mcp("playwright", [
          cell("claude", { usageCount: 30, lastUsedAt: "2026-11-12T10:00:00.000Z" }),
          cell("codex", { usageCount: 7 }),
        ]),
        mcp("plugin:github:github", [cell("claude", { scopes: ["plugin"] })], {
          readOnly: true,
          transport: "plugin",
          pluginId: "github@claude-plugins-official",
        }),
      ]),
    }),
    machine(VPS, "VPS", {
      snapshot: snapshot([
        mcp("playwright", [cell("claude", { state: "needsAttention", problem: npxMissing })]),
      ]),
    }),
  ];
}

function setup(machines: Array<MachineState> = twoMachines()) {
  state.machines = machines;
  state.calls.length = 0;
  state.results.clear();
  state.checkHealth.mockClear();
  state.refresh.mockClear();
}

const playwrightCells = () =>
  page.getByRole("row", { name: /playwright/ }).getByRole("button", { name: /^playwright on / });

describe("ForkExtensionsSettings", () => {
  it("shows a row with one cell per machine and agent", async () => {
    setup();
    await using _screen = await render(<ForkExtensionsSettings />);
    await expect.element(page.getByRole("button", { name: "MCP · 2" })).toBeVisible();
    await expect.element(page.getByRole("columnheader", { name: /VPS/ }).first()).toBeVisible();
    await expect.element(playwrightCells().first()).toBeVisible();
    expect(playwrightCells().elements()).toHaveLength(4);
    await expect.element(page.getByText("checked 12m ago", { exact: true })).toBeVisible();
  });

  it("turns a working cell off globally on that machine", async () => {
    setup();
    const result: ForkInstallResult = { agent: "claude", ok: true, problem: null };
    state.results.set(forkExtensionsSetEnabled.label, result);
    await using _screen = await render(<ForkExtensionsSettings />);
    await page.getByRole("button", { name: "playwright on This PC · Claude: Working" }).click();
    await expect
      .poll(() => state.calls)
      .toEqual([
        {
          label: forkExtensionsSetEnabled.label,
          value: {
            environmentId: PC,
            input: { itemId: "mcp:playwright", agent: "claude", enabled: false, projectPath: null },
          },
        },
      ]);
  });

  it("shows a failed toggle's cause and next step", async () => {
    setup();
    const result: ForkInstallResult = {
      agent: "claude",
      ok: false,
      problem: {
        reason: "configChanged",
        summary: "The config changed while you were editing",
        nextStep: "Refresh and try again.",
        rawOutput: null,
      },
    };
    state.results.set(forkExtensionsSetEnabled.label, result);
    await using _screen = await render(<ForkExtensionsSettings />);
    await page.getByRole("button", { name: "playwright on This PC · Claude: Working" }).click();
    await expect.element(page.getByText("The config changed while you were editing")).toBeVisible();
    await expect.element(page.getByText("Refresh and try again.")).toBeVisible();
  });

  it("asks to install in an empty cell and never toggles a plugin's server", async () => {
    setup();
    await using _screen = await render(<ForkExtensionsSettings />);
    await page.getByRole("button", { name: "playwright on VPS · Codex: Not installed" }).click();
    await expect.element(page.getByRole("checkbox", { name: "VPS · Codex" })).toBeChecked();
    await page
      .getByRole("button", { name: "plugin:github:github on This PC · Claude: Working" })
      .click({ force: true });
    expect(state.calls).toEqual([]);
  });

  it("opens the detail with a cell's problem and next step", async () => {
    setup();
    await using _screen = await render(<ForkExtensionsSettings />);
    await page.getByRole("button", { name: "playwright", exact: true }).click();
    const detail = page.getByRole("region", { name: "playwright details" });
    await expect.element(detail.getByText("npx not found")).toBeVisible();
    await expect
      .element(detail.getByText("Install Node.js on VPS so npx is on its PATH."))
      .toBeVisible();
    await expect.element(detail).toMatchTextContent(/Working · 30 uses · last used just now/);
    await detail.getByRole("button", { name: "Show details" }).click();
    await expect.element(detail.getByText("spawn npx ENOENT")).toBeVisible();
  });

  it("uninstalls with one call per machine after confirming", async () => {
    setup();
    state.results.set(forkExtensionsUninstall.label, [
      { agent: "claude", ok: true, problem: null },
    ]);
    await using _screen = await render(<ForkExtensionsSettings />);
    await page.getByRole("button", { name: "playwright", exact: true }).click();
    await page.getByRole("button", { name: "Uninstall…" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Uninstall" }).click();
    await expect.poll(() => state.calls.length).toBe(2);
    expect(state.calls).toEqual(
      expect.arrayContaining([
        {
          label: forkExtensionsUninstall.label,
          value: {
            environmentId: PC,
            input: { itemId: "mcp:playwright", agents: ["claude", "codex"] },
          },
        },
        {
          label: forkExtensionsUninstall.label,
          value: { environmentId: VPS, input: { itemId: "mcp:playwright", agents: ["claude"] } },
        },
      ]),
    );
  });

  it("marks old builds and read-only machines without offering changes", async () => {
    setup([
      ...twoMachines().map((entry) =>
        entry.environmentId === VPS ? { ...entry, canOperate: false } : entry,
      ),
      machine(OLD, "Old laptop", { support: "needsForkUpdate", canOperate: false }),
    ]);
    await using _screen = await render(<ForkExtensionsSettings />);
    await expect
      .element(page.getByRole("columnheader", { name: /Old laptop/ }))
      .toMatchTextContent(/Needs a fork update/);
    await page
      .getByRole("button", { name: "playwright on VPS · Codex: Not installed" })
      .click({ force: true });
    await expect.element(page.getByText("Where should it go?")).not.toBeInTheDocument();
  });

  it("checks status on every machine", async () => {
    setup();
    await using _screen = await render(<ForkExtensionsSettings />);
    await page.getByRole("button", { name: "Check status" }).click();
    expect(state.checkHealth).toHaveBeenCalledWith();
  });

  it("shows a machine whose snapshot is still loading or failed", async () => {
    setup([
      ...twoMachines(),
      machine(OLD, "Laptop", { isPending: true }),
      machine(EnvironmentId.make("env-broken"), "Broken", { error: "Snapshot timed out" }),
    ]);
    await using _screen = await render(<ForkExtensionsSettings />);
    await expect.element(page.getByText("Loading extensions on Laptop…")).toBeVisible();
    await expect.element(page.getByText("Broken: Snapshot timed out")).toBeVisible();
  });
});
