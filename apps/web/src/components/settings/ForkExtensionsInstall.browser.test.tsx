import {
  EnvironmentId,
  ForkExtensionsError,
  type ForkExtensionCell,
  type ForkExtensionItem,
  type ForkExtensionsSnapshot,
  type ForkInstallResult,
  type ForkPastedSource,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import type { MachineState } from "./ForkExtensions.logic";

// As in ForkExtensionsSettings.browser.test.tsx: the page reads machines through
// useForkExtensions (unit-tested on its own) and runs commands through useAtomCommand, so the
// test stands in at those two seams. A command's answer can be held back to model a slow machine.
type Answer = (value: unknown) => unknown;
const state = vi.hoisted(() => ({
  machines: [] as Array<unknown>,
  calls: [] as Array<{ readonly label: string; readonly value: unknown }>,
  answers: new Map<string, (value: unknown) => unknown>(),
}));

vi.mock(import("./useForkExtensions"), async (original) => ({
  ...(await original()),
  useForkExtensions: (() => ({
    machines: state.machines,
    refresh: () => {},
    checkHealth: () => {},
  })) as never,
}));
vi.mock(import("../../hooks/useNowMinute"), () => ({ useNowMinute: () => "2026-11-12T10:00" }));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: { readonly label: string }) => async (value: unknown) => {
    state.calls.push({ label: command.label, value });
    return state.answers.get(command.label)?.(value);
  }) as never,
}));

import "~/index.css";
import { render } from "../../../test/render";
import { forkExtensionsInspectSource, forkExtensionsInstall } from "../../state/forkExtensions";
import { ForkExtensionsSettings } from "./ForkExtensionsSettings";

const PC = EnvironmentId.make("env-pc");
const VPS = EnvironmentId.make("env-vps");
const OLD = EnvironmentId.make("env-old");

function cell(agent: ForkExtensionCell["agent"]): ForkExtensionCell {
  return {
    agent,
    state: "working",
    scopes: ["user"],
    projects: [],
    problem: null,
    usageCount: 0,
    lastUsedAt: null,
    stashDiscarded: false,
  };
}

function playwright(cells: ReadonlyArray<ForkExtensionCell>): ForkExtensionItem {
  return {
    id: "mcp:playwright",
    kind: "mcp",
    name: "playwright",
    source: "npx @playwright/mcp@latest",
    transport: "stdio",
    pluginId: null,
    readOnly: false,
    cells,
  };
}

function snapshot(items: ReadonlyArray<ForkExtensionItem>): ForkExtensionsSnapshot {
  return {
    protocolVersion: 1,
    agents: [
      { agent: "claude", available: true },
      { agent: "codex", available: true },
    ],
    projects: [{ path: "/srv/app", title: "app" }],
    items,
    healthCheckedAt: null,
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

const twoMachines = (): Array<MachineState> => [
  machine(PC, "This PC", { snapshot: snapshot([playwright([cell("claude"), cell("codex")])]) }),
  machine(VPS, "VPS", { snapshot: snapshot([playwright([cell("claude")])]) }),
];

const claudeMissing = {
  reason: "binaryNotFound",
  summary: "claude not found on VPS",
  nextStep: "Install Claude Code on VPS, then try again.",
  rawOutput: "spawn claude ENOENT",
} as const;

const notion: ForkPastedSource = {
  _tag: "mcpRemote",
  url: "https://mcp.notion.com/mcp",
  transport: "http",
  suggestedName: "notion",
};

function setup(machines: Array<MachineState> = twoMachines()) {
  state.machines = machines;
  state.calls.length = 0;
  state.answers.clear();
}

const answer = (label: string, reply: Answer) => state.answers.set(label, reply);
const environmentOf = (value: unknown) => (value as { environmentId: EnvironmentId }).environmentId;
const installCalls = () => state.calls.filter((call) => call.label === forkExtensionsInstall.label);

async function paste(text: string) {
  await page.getByRole("textbox", { name: "Paste something to install" }).fill(text);
  await page.getByRole("button", { name: "Install", exact: true }).click();
}

describe("ForkExtensionsInstall", () => {
  it("detects a pasted remote MCP on this machine and pre-fills its name", async () => {
    setup();
    answer(forkExtensionsInspectSource.label, () => AsyncResult.success(notion));
    await using _screen = await render(<ForkExtensionsSettings />);
    await paste("https://mcp.notion.com/mcp");
    await expect.element(page.getByText("Detected: Remote MCP (HTTP)")).toBeVisible();
    await expect.element(page.getByRole("textbox", { name: "Name" })).toHaveValue("notion");
    expect(state.calls).toEqual([
      {
        label: forkExtensionsInspectSource.label,
        value: { environmentId: PC, input: { text: "https://mcp.notion.com/mcp" } },
      },
    ]);
    await expect.element(page.getByRole("checkbox", { name: "VPS · Codex" })).toBeChecked();
    await expect.element(page.getByRole("button", { name: "Install in 4 places" })).toBeVisible();
  });

  it("finishes on one machine while another fails, with that one's next step", async () => {
    setup();
    answer(forkExtensionsInspectSource.label, () => AsyncResult.success(notion));
    let answerVps: (results: ReadonlyArray<ForkInstallResult>) => void = () => {};
    answer(forkExtensionsInstall.label, (value) =>
      environmentOf(value) === PC
        ? AsyncResult.success([
            { agent: "claude", ok: true, problem: null },
            { agent: "codex", ok: true, problem: null },
          ])
        : new Promise((resolve) => {
            answerVps = (results) => resolve(AsyncResult.success(results));
          }),
    );
    await using _screen = await render(<ForkExtensionsSettings />);
    await paste("https://mcp.notion.com/mcp");
    await page.getByRole("button", { name: "Install in 4 places" }).click();

    // VPS has not answered yet: This PC already shows its own result.
    await expect.element(page.getByLabelText("Installed on This PC · Claude")).toBeVisible();
    await expect.element(page.getByLabelText("Installed on This PC · Codex")).toBeVisible();
    await expect.element(page.getByLabelText("Installing on VPS · Claude")).toBeVisible();
    expect(installCalls().map((call) => call.value)).toEqual([
      {
        environmentId: PC,
        input: {
          _tag: "mcp",
          name: "notion",
          agents: ["claude", "codex"],
          transport: "http",
          command: null,
          args: [],
          url: "https://mcp.notion.com/mcp",
          scope: "user",
          projectPath: null,
        },
      },
      {
        environmentId: VPS,
        input: expect.objectContaining({ _tag: "mcp", agents: ["claude", "codex"] }),
      },
    ]);

    answerVps([
      { agent: "claude", ok: false, problem: claudeMissing },
      { agent: "codex", ok: true, problem: null },
    ]);
    await expect.element(page.getByLabelText("Failed on VPS · Claude")).toBeVisible();
    await expect.element(page.getByLabelText("Installed on VPS · Codex")).toBeVisible();
    await expect.element(page.getByText("claude not found on VPS")).toBeVisible();
    await expect
      .element(page.getByText("Install Claude Code on VPS, then try again."))
      .toBeVisible();
    await expect.element(page.getByLabelText("Installed on This PC · Claude")).toBeVisible();
  });

  it("marks every place on a machine that did not answer as failed", async () => {
    setup();
    answer(forkExtensionsInspectSource.label, () => AsyncResult.success(notion));
    answer(forkExtensionsInstall.label, (value) =>
      environmentOf(value) === PC
        ? AsyncResult.success([
            { agent: "claude", ok: true, problem: null },
            { agent: "codex", ok: true, problem: null },
          ])
        : AsyncResult.failure(
            Cause.fail(
              new ForkExtensionsError({
                problem: {
                  reason: "machineOffline",
                  summary: "VPS disconnected",
                  nextStep: "Reconnect VPS and try again.",
                  rawOutput: null,
                },
              }),
            ),
          ),
    );
    await using _screen = await render(<ForkExtensionsSettings />);
    await paste("https://mcp.notion.com/mcp");
    await page.getByRole("button", { name: "Install in 4 places" }).click();
    await expect.element(page.getByLabelText("Failed on VPS · Claude")).toBeVisible();
    await expect.element(page.getByLabelText("Failed on VPS · Codex")).toBeVisible();
    await expect.element(page.getByText("Reconnect VPS and try again.").first()).toBeVisible();
    await expect.element(page.getByLabelText("Installed on This PC · Codex")).toBeVisible();
  });

  it("does not offer a machine that needs a fork update", async () => {
    setup([...twoMachines(), machine(OLD, "Old laptop", { support: "needsForkUpdate" })]);
    answer(forkExtensionsInspectSource.label, () => AsyncResult.success(notion));
    await using _screen = await render(<ForkExtensionsSettings />);
    await paste("https://mcp.notion.com/mcp");
    const old = page.getByRole("checkbox", { name: "Old laptop · Claude" });
    await expect.element(old).toHaveAttribute("aria-disabled", "true");
    await expect.element(old).not.toBeChecked();
    await expect.element(page.getByRole("button", { name: "Install in 4 places" })).toBeVisible();
  });

  it("limits Codex to what it supports and asks for a project per machine", async () => {
    setup();
    answer(forkExtensionsInspectSource.label, () => AsyncResult.success(notion));
    answer(forkExtensionsInstall.label, () =>
      AsyncResult.success([{ agent: "claude", ok: true, problem: null }]),
    );
    await using _screen = await render(<ForkExtensionsSettings />);
    await paste("https://mcp.notion.com/mcp");
    await page.getByRole("combobox", { name: "Scope" }).click();
    await page.getByRole("option", { name: "Project" }).click();
    await expect
      .element(page.getByRole("checkbox", { name: "VPS · Codex" }))
      .toHaveAttribute("aria-disabled", "true");
    const install = page.getByRole("button", { name: "Install in 2 places" });
    await expect.element(install).toBeDisabled();
    await expect.element(page.getByText("Pick a project on This PC.")).toBeVisible();
    await page.getByRole("combobox", { name: "Project on This PC" }).click();
    await page.getByRole("option", { name: "app" }).click();
    await page.getByRole("combobox", { name: "Project on VPS" }).click();
    await page.getByRole("option", { name: "app" }).click();
    await install.click();
    await expect.poll(() => installCalls().length).toBe(2);
    expect(installCalls()[1]!.value).toEqual({
      environmentId: VPS,
      input: expect.objectContaining({
        agents: ["claude"],
        scope: "project",
        projectPath: "/srv/app",
      }),
    });
  });

  it("sends a claude.ai connector to claude.ai instead of a form", async () => {
    setup();
    answer(forkExtensionsInspectSource.label, () =>
      AsyncResult.success({ _tag: "claudeAiConnector" }),
    );
    await using _screen = await render(<ForkExtensionsSettings />);
    await paste("claude.ai");
    await expect
      .element(page.getByRole("button", { name: "Open claude.ai connectors" }))
      .toBeVisible();
    await expect.element(page.getByText(/shows up on all your machines/)).toBeVisible();
    await expect.element(page.getByRole("checkbox")).not.toBeInTheDocument();
  });

  it("lets you pick the type when the paste is not recognised", async () => {
    setup();
    answer(forkExtensionsInspectSource.label, () => AsyncResult.success({ _tag: "unknown" }));
    await using _screen = await render(<ForkExtensionsSettings />);
    await paste("my-server --stdio");
    await expect.element(page.getByText("Couldn't tell what this is.")).toBeVisible();
    await page.getByRole("combobox", { name: "Type" }).click();
    await page.getByRole("option", { name: "Local MCP (command)" }).click();
    await expect
      .element(page.getByRole("textbox", { name: "Command" }))
      .toHaveValue("my-server --stdio");
  });

  it("opens the form from an empty cell with only that place checked", async () => {
    setup();
    answer(forkExtensionsInstall.label, () =>
      AsyncResult.success([{ agent: "codex", ok: true, problem: null }]),
    );
    await using _screen = await render(<ForkExtensionsSettings />);
    await page.getByRole("button", { name: "playwright on VPS · Codex: Not installed" }).click();
    await expect.element(page.getByRole("checkbox", { name: "VPS · Codex" })).toBeChecked();
    await expect.element(page.getByRole("checkbox", { name: "VPS · Claude" })).not.toBeChecked();
    await expect
      .element(page.getByRole("textbox", { name: "Command" }))
      .toHaveValue("npx @playwright/mcp@latest");
    await page.getByRole("button", { name: "Install in 1 place" }).click();
    await expect.poll(() => installCalls().length).toBe(1);
    expect(installCalls()[0]!.value).toEqual({
      environmentId: VPS,
      input: {
        _tag: "mcp",
        name: "playwright",
        agents: ["codex"],
        transport: "stdio",
        command: "npx",
        args: ["@playwright/mcp@latest"],
        url: null,
        scope: "user",
        projectPath: null,
      },
    });
  });
});
