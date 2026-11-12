import {
  EnvironmentId,
  type ForkAuthorizeEvent,
  type ForkExtensionCell,
  type ForkExtensionItem,
  type ForkExtensionsSnapshot,
  type ForkInstallResult,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import type { MachineState } from "./ForkExtensions.logic";

// As in ForkExtensionsSettings.browser.test.tsx: machines come from useForkExtensions (unit-tested
// on its own) and commands run through useAtomCommand, so the test stands in at those two seams.
// The authorize stream is driven by hand through the `onEvent` the page passes in.
interface AuthorizeInput {
  readonly payload: { readonly itemId: string; readonly agent: string };
  readonly onEvent: (event: ForkAuthorizeEvent) => void;
  readonly signal?: AbortSignal;
}
const state = vi.hoisted(() => ({
  machines: [] as Array<unknown>,
  calls: [] as Array<{ readonly label: string; readonly value: unknown }>,
  answers: new Map<string, (value: unknown) => unknown>(),
  checkHealth: vi.fn(),
  openExternal: vi.fn(async (_url: string) => {}),
}));

vi.mock(import("./useForkExtensions"), async (original) => ({
  ...(await original()),
  useForkExtensions: (() => ({
    machines: state.machines,
    refresh: () => {},
    checkHealth: state.checkHealth,
  })) as never,
}));
vi.mock(import("../../hooks/useNowMinute"), () => ({ useNowMinute: () => "2026-11-12T10:00" }));
vi.mock(import("../../localApi"), async (original) => ({
  ...(await original()),
  ensureLocalApi: (() => ({ shell: { openExternal: state.openExternal } })) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: { readonly label: string }) => async (value: unknown) => {
    state.calls.push({ label: command.label, value });
    return state.answers.get(command.label)?.(value);
  }) as never,
}));

import "~/index.css";
import { render } from "../../../test/render";
import {
  forkExtensionsAuthorize,
  forkExtensionsAuthorizeComplete,
  forkExtensionsSetEnabled,
} from "../../state/forkExtensions";
import { ForkExtensionsSettings } from "./ForkExtensionsSettings";

const PC = EnvironmentId.make("env-pc");
const VPS = EnvironmentId.make("env-vps");

const needsAuth = {
  reason: "needsAuthorization",
  summary: "context7 needs you to sign in",
  nextStep: "Click Authorize.",
  rawOutput: null,
} as const;

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
    source: `https://mcp.${name}.com/mcp`,
    transport: "http",
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
    healthCheckedAt: "2026-11-12T09:58:00.000Z",
  };
}

function machine(
  environmentId: EnvironmentId,
  label: string,
  items: ReadonlyArray<ForkExtensionItem>,
  overrides: Partial<MachineState> = {},
): MachineState {
  return {
    environmentId,
    label,
    support: "supported",
    canOperate: true,
    snapshot: snapshot(items),
    error: null,
    isPending: false,
    isCheckingHealth: false,
    healthError: null,
    ...overrides,
  };
}

function reset(machines: ReadonlyArray<MachineState>) {
  state.machines = [...machines];
  state.calls.length = 0;
  state.answers.clear();
  state.checkHealth.mockClear();
  state.openExternal.mockClear();
}

const callsOf = (label: string) =>
  state.calls.filter((call) => call.label === label).map((call) => call.value);

/** Holds the authorize stream open until the test ends it, as the server's login would. */
function holdAuthorize() {
  const runs: Array<{
    readonly input: AuthorizeInput;
    readonly end: (last: ForkAuthorizeEvent | null) => void;
  }> = [];
  state.answers.set(
    forkExtensionsAuthorize.label,
    (value) =>
      new Promise((resolve) => {
        const input = (value as { readonly input: AuthorizeInput }).input;
        runs.push({
          input,
          end: (last) => resolve(AsyncResult.success(Option.fromNullishOr(last))),
        });
      }),
  );
  return runs;
}

async function openDetail(name: string) {
  await page.getByRole("button", { name, exact: true }).click();
  await expect.element(page.getByRole("region", { name: `${name} details` })).toBeVisible();
}

const URL_FROM_SERVER = "https://mcp.context7.com/authorize?client_id=t3&state=xyz";
const REDIRECT = "http://localhost:41234/callback?code=secret-code&state=xyz";

describe("ForkExtensions authorize and per-project toggles", () => {
  it("opens the sign-in page, sends the pasted address and refreshes that machine when done", async () => {
    reset([
      machine(PC, "This PC", [mcp("context7", [cell("claude"), cell("codex")])]),
      machine(VPS, "VPS", [
        mcp("context7", [
          cell("claude", { state: "needsAttention", problem: needsAuth }),
          cell("codex"),
        ]),
      ]),
    ]);
    const runs = holdAuthorize();
    state.answers.set(forkExtensionsAuthorizeComplete.label, () => AsyncResult.success({}));
    await using _screen = await render(<ForkExtensionsSettings />);

    await openDetail("context7");
    // Only the cell that needs it offers Authorize.
    await expect
      .element(page.getByRole("button", { name: "Authorize", exact: true }))
      .toBeVisible();
    expect(page.getByRole("button", { name: "Authorize", exact: true }).all()).toHaveLength(1);
    await page.getByRole("button", { name: "Authorize", exact: true }).click();

    await vi.waitFor(() => expect(runs).toHaveLength(1));
    expect(callsOf(forkExtensionsAuthorize.label)[0]).toMatchObject({
      environmentId: VPS,
      input: { payload: { itemId: "mcp:context7", agent: "claude" } },
    });
    const dialog = page.getByRole("dialog");
    await expect.element(dialog.getByText("Starting the login on VPS…")).toBeVisible();

    runs[0]!.input.onEvent({ _tag: "authUrl", sessionId: "session-1", url: URL_FROM_SERVER });
    await expect
      .element(
        dialog.getByText(
          "After you approve, your browser lands on a page that may not load. Copy its full address and paste it here.",
        ),
      )
      .toBeVisible();
    expect(state.openExternal).toHaveBeenCalledWith(URL_FROM_SERVER);

    const address = dialog.getByRole("textbox", {
      name: "Address of the page your browser landed on",
    });
    await address.fill(`  ${REDIRECT}  `);
    await dialog.getByRole("button", { name: "Finish" }).click();

    await vi.waitFor(() =>
      expect(callsOf(forkExtensionsAuthorizeComplete.label)).toEqual([
        { environmentId: VPS, input: { sessionId: "session-1", redirectUrl: REDIRECT } },
      ]),
    );
    await expect.element(address).toHaveValue("");

    runs[0]!.input.onEvent({ _tag: "done" });
    runs[0]!.end({ _tag: "done" });
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await expect.element(page.getByText("Authorized context7 on VPS · Claude")).toBeVisible();
    expect(state.checkHealth).toHaveBeenCalledWith(VPS);
    expect(state.checkHealth).toHaveBeenCalledTimes(1);
  });

  it("stops the login when the dialog is cancelled", async () => {
    reset([
      machine(PC, "This PC", [
        mcp("context7", [cell("claude", { state: "needsAttention", problem: needsAuth })]),
      ]),
    ]);
    const runs = holdAuthorize();
    await using _screen = await render(<ForkExtensionsSettings />);

    await openDetail("context7");
    await page.getByRole("button", { name: "Authorize", exact: true }).click();
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    runs[0]!.input.onEvent({ _tag: "authUrl", sessionId: "session-1", url: URL_FROM_SERVER });
    const signal = runs[0]!.input.signal;
    expect(signal?.aborted).toBe(false);

    await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
    expect(signal?.aborted).toBe(true);
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    runs[0]!.end({ _tag: "authUrl", sessionId: "session-1", url: URL_FROM_SERVER });
    expect(callsOf(forkExtensionsAuthorizeComplete.label)).toEqual([]);
    expect(state.checkHealth).not.toHaveBeenCalled();
  });

  it("keeps the login while pasting: a click outside or Escape does not close it", async () => {
    reset([
      machine(PC, "This PC", [
        mcp("context7", [cell("claude", { state: "needsAttention", problem: needsAuth })]),
      ]),
    ]);
    const runs = holdAuthorize();
    await using _screen = await render(<ForkExtensionsSettings />);

    await openDetail("context7");
    await page.getByRole("button", { name: "Authorize", exact: true }).click();
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    runs[0]!.input.onEvent({ _tag: "authUrl", sessionId: "session-1", url: URL_FROM_SERVER });
    const dialog = page.getByRole("dialog");
    const address = dialog.getByRole("textbox", {
      name: "Address of the page your browser landed on",
    });
    await expect.element(address).toBeVisible();
    await address.fill(REDIRECT);

    const backdrop = document.querySelector<HTMLElement>('[data-slot="dialog-backdrop"]');
    expect(backdrop).not.toBeNull();
    await userEvent.click(backdrop!, { position: { x: 4, y: 4 }, force: true });
    await expect.element(address).toHaveValue(REDIRECT);
    expect(runs[0]!.input.signal?.aborted).toBe(false);

    await userEvent.keyboard("{Escape}");
    await expect.element(address).toHaveValue(REDIRECT);
    expect(runs[0]!.input.signal?.aborted).toBe(false);
    // Cancel is the way out.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect(runs[0]!.input.signal?.aborted).toBe(true);
    runs[0]!.end(null);
  });

  it("shows why the login failed", async () => {
    reset([
      machine(PC, "This PC", [
        mcp("context7", [cell("claude", { state: "needsAttention", problem: needsAuth })]),
      ]),
    ]);
    const runs = holdAuthorize();
    await using _screen = await render(<ForkExtensionsSettings />);

    await openDetail("context7");
    await page.getByRole("button", { name: "Authorize", exact: true }).click();
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    const problem = {
      reason: "timeout",
      summary: "The sign-in took too long.",
      nextStep: "Click Authorize to start again.",
      rawOutput: null,
    } as const;
    runs[0]!.input.onEvent({ _tag: "failed", problem });
    runs[0]!.end({ _tag: "failed", problem });

    const dialog = page.getByRole("dialog");
    await expect.element(dialog.getByText("The sign-in took too long.")).toBeVisible();
    await expect.element(dialog.getByText("Click Authorize to start again.")).toBeVisible();
    expect(state.checkHealth).not.toHaveBeenCalled();
  });

  it("sends claude.ai connectors to claude.ai instead of starting a login", async () => {
    reset([
      machine(PC, "This PC", [
        mcp(
          "claude.ai Gmail",
          [cell("claude", { state: "needsAttention", scopes: ["claudeAi"], problem: needsAuth })],
          { transport: "claudeAi", source: "claude.ai" },
        ),
      ]),
    ]);
    await using _screen = await render(<ForkExtensionsSettings />);

    await openDetail("claude.ai Gmail");
    await page.getByRole("button", { name: "Authorize on claude.ai" }).click();
    expect(state.openExternal).toHaveBeenCalledWith("https://claude.ai/settings/connectors");
    expect(callsOf(forkExtensionsAuthorize.label)).toEqual([]);
  });

  it("does not start a login for a project-only server or on a read-only machine", async () => {
    reset([
      machine(PC, "This PC", [
        mcp("context7", [
          cell("claude", { state: "needsAttention", scopes: ["project"], problem: needsAuth }),
        ]),
      ]),
      machine(
        VPS,
        "VPS",
        [mcp("context7", [cell("claude", { state: "needsAttention", problem: needsAuth })])],
        { canOperate: false },
      ),
    ]);
    await using _screen = await render(<ForkExtensionsSettings />);

    await openDetail("context7");
    const buttons = page.getByRole("button", { name: "Authorize", exact: true });
    await expect.element(buttons.first()).toBeVisible();
    expect(buttons.all()).toHaveLength(2);
    for (const button of buttons.all()) {
      await expect.element(button).toHaveAttribute("aria-disabled", "true");
      await button.click({ force: true });
    }
    expect(callsOf(forkExtensionsAuthorize.label)).toEqual([]);
    await buttons.first().hover();
    await expect
      .element(
        page.getByText("Authorize it from a terminal in that project (claude mcp login context7)."),
      )
      .toBeVisible();
  });

  it("turns a Claude MCP off and on in single projects", async () => {
    const projects = [
      { path: "E:/work/repo-a", title: "repo-a", disabled: false },
      { path: "E:/work/repo-b", title: "repo-b", disabled: true },
    ];
    reset([
      machine(PC, "This PC", [
        mcp("playwright", [cell("claude", { projects }), cell("codex")], {
          transport: "stdio",
          source: "npx @playwright/mcp@latest",
        }),
      ]),
      machine(
        VPS,
        "VPS",
        [
          mcp("playwright", [cell("claude", { projects: [projects[0]!] })], {
            transport: "stdio",
            source: "npx @playwright/mcp@latest",
          }),
        ],
        { canOperate: false },
      ),
    ]);
    const ok: ReadonlyArray<ForkInstallResult> = [{ agent: "claude", ok: true, problem: null }];
    state.answers.set(forkExtensionsSetEnabled.label, (value) => {
      const input = (value as { readonly input: { readonly projectPath: string } }).input;
      return AsyncResult.success(
        input.projectPath === "E:/work/repo-b"
          ? {
              agent: "claude",
              ok: false,
              problem: {
                reason: "configChanged",
                summary: "~/.claude.json changed while saving.",
                nextStep: "Try again.",
                rawOutput: null,
              },
            }
          : ok[0],
      );
    });
    await using _screen = await render(<ForkExtensionsSettings />);

    await openDetail("playwright");
    const detail = page.getByRole("region", { name: "playwright details" });
    await expect.element(detail.getByText("Per project")).toBeVisible();

    const repoA = detail.getByRole("switch", { name: "repo-a on This PC · Claude" });
    const repoB = detail.getByRole("switch", { name: "repo-b on This PC · Claude" });
    await expect.element(repoA).toBeChecked();
    await expect.element(repoB).not.toBeChecked();

    await repoA.click();
    await vi.waitFor(() =>
      expect(callsOf(forkExtensionsSetEnabled.label)).toEqual([
        {
          environmentId: PC,
          input: {
            itemId: "mcp:playwright",
            agent: "claude",
            enabled: false,
            projectPath: "E:/work/repo-a",
          },
        },
      ]),
    );

    await repoB.click();
    await vi.waitFor(() => expect(callsOf(forkExtensionsSetEnabled.label)).toHaveLength(2));
    expect(callsOf(forkExtensionsSetEnabled.label)[1]).toEqual({
      environmentId: PC,
      input: {
        itemId: "mcp:playwright",
        agent: "claude",
        enabled: true,
        projectPath: "E:/work/repo-b",
      },
    });
    await expect.element(page.getByText("~/.claude.json changed while saving.")).toBeVisible();
    await expect.element(repoB).not.toBeChecked();

    // Read-only machine: listed, not changeable.
    const vpsRepoA = detail.getByRole("switch", { name: "repo-a on VPS · Claude" });
    await expect.element(vpsRepoA).toBeDisabled();
    // Codex has no per-project switch.
    expect(detail.getByRole("switch").all()).toHaveLength(3);
  });

  it("has no per-project section when no project lists the server", async () => {
    reset([machine(PC, "This PC", [mcp("context7", [cell("claude"), cell("codex")])])]);
    await using _screen = await render(<ForkExtensionsSettings />);

    await openDetail("context7");
    const detail = page.getByRole("region", { name: "context7 details" });
    await expect.element(detail.getByText("This PC · Claude")).toBeVisible();
    expect(detail.getByText("Per project").all()).toHaveLength(0);
  });
});
