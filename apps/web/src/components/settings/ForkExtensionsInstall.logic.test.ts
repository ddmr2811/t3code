import {
  EnvironmentId,
  type ForkExtensionCell,
  type ForkExtensionItem,
  type ForkExtensionsSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { MachineState } from "./ForkExtensions.logic";
import {
  DEFAULT_INSTALL_SELECTION,
  draftFromItem,
  draftFromPasted,
  findForkItem,
  forkInstallInspectMachine,
  forkInstallPlan,
  forkInstallStatus,
  forkInstallTargetKey,
  forkInstallTargets,
  isInstallTargetChecked,
  joinCommandLine,
  retypeDraft,
  splitCommandLine,
  type ForkInstallDraft,
  type ForkInstallTarget,
} from "./ForkExtensionsInstall.logic";

const PC = EnvironmentId.make("env-pc");
const VPS = EnvironmentId.make("env-vps");
const OLD = EnvironmentId.make("env-old");

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

function item(overrides: Partial<ForkExtensionItem>): ForkExtensionItem {
  return {
    id: "mcp:notion",
    kind: "mcp",
    name: "notion",
    source: "https://mcp.notion.com/mcp",
    transport: "http",
    pluginId: null,
    readOnly: false,
    cells: [cell("claude")],
    ...overrides,
  };
}

function snapshot(overrides: Partial<ForkExtensionsSnapshot> = {}): ForkExtensionsSnapshot {
  return {
    protocolVersion: 1,
    agents: [
      { agent: "claude", available: true },
      { agent: "codex", available: true },
    ],
    projects: [{ path: "/repo/app", title: "app" }],
    items: [],
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
    snapshot: snapshot(),
    error: null,
    isPending: false,
    isCheckingHealth: false,
    healthError: null,
    ...overrides,
  };
}

const notionDraft = (): ForkInstallDraft =>
  draftFromPasted({
    _tag: "mcpRemote",
    url: "https://mcp.notion.com/mcp",
    transport: "http",
    suggestedName: "notion",
  })!;

const blocked = (targets: ReadonlyArray<ForkInstallTarget>) =>
  targets.map((target) => [target.key, target.blocked, target.notApplicable]);

describe("command lines", () => {
  it("splits on spaces and keeps quoted parts together", () => {
    expect(splitCommandLine("npx -y @playwright/mcp@latest")).toEqual({
      command: "npx",
      args: ["-y", "@playwright/mcp@latest"],
    });
    expect(splitCommandLine('"C:\\Program Files\\srv.exe" --port 3')).toEqual({
      command: "C:\\Program Files\\srv.exe",
      args: ["--port", "3"],
    });
    expect(splitCommandLine("   ")).toBeNull();
  });

  it("joins back what it splits", () => {
    const line = joinCommandLine("C:\\Program Files\\srv.exe", ["--name", "a b"]);
    expect(line).toBe('"C:\\Program Files\\srv.exe" --name "a b"');
    expect(splitCommandLine(line)).toEqual({
      command: "C:\\Program Files\\srv.exe",
      args: ["--name", "a b"],
    });
  });
});

describe("drafts", () => {
  it("pre-fills each detected type and asks by hand for an unknown one", () => {
    expect(notionDraft()).toMatchObject({
      type: "mcpHttp",
      name: "notion",
      url: "https://mcp.notion.com/mcp",
      scope: "user",
    });
    expect(
      draftFromPasted({
        _tag: "mcpCommand",
        command: "npx",
        args: ["@playwright/mcp@latest"],
        suggestedName: "playwright",
      }),
    ).toMatchObject({ type: "mcpCommand", commandLine: "npx @playwright/mcp@latest" });
    expect(
      draftFromPasted({
        _tag: "marketplace",
        source: "anthropics/skills",
        name: "team-tools",
        plugins: ["docs", "pdf"],
      }),
    ).toMatchObject({
      type: "marketplace",
      marketplaceSource: "anthropics/skills",
      marketplaceName: "team-tools",
      marketplacePlugins: ["docs", "pdf"],
      pluginRef: "docs",
    });
    expect(draftFromPasted({ _tag: "claudeAiConnector" })?.type).toBe("claudeAiConnector");
    expect(draftFromPasted({ _tag: "unknown" })).toBeNull();
  });

  it("changing the type keeps the name and reads the pasted text for the new fields", () => {
    const retyped = retypeDraft(notionDraft(), "mcpSse", "https://mcp.notion.com/mcp");
    expect(retyped).toMatchObject({ type: "mcpSse", name: "notion" });
    expect(retypeDraft(null, "mcpCommand", "my-server --stdio")).toMatchObject({
      type: "mcpCommand",
      commandLine: "my-server --stdio",
    });
    expect(retypeDraft(null, "skill", "owner/repo/skills/pdf")).toMatchObject({
      type: "skill",
      skillSource: "owner/repo/skills/pdf",
    });
  });

  it("an installed item fills the form for installing it somewhere else", () => {
    expect(
      draftFromItem(
        item({ name: "playwright", source: "npx @playwright/mcp@latest", transport: "stdio" }),
      ),
    ).toMatchObject({
      type: "mcpCommand",
      name: "playwright",
      commandLine: "npx @playwright/mcp@latest",
    });
    expect(draftFromItem(item({ transport: "claudeAi" })).type).toBe("claudeAiConnector");
    expect(
      draftFromItem(
        item({ name: "plugin:github:github", transport: "plugin", pluginId: "github@official" }),
      ),
    ).toMatchObject({ type: "plugin", pluginRef: "github@official" });
    expect(
      draftFromItem(item({ id: "plugin:docs@x", kind: "plugin", name: "docs@x", source: "x" })),
    ).toMatchObject({ type: "plugin", pluginRef: "docs@x" });
  });

  it("splits a server's source back into the parts the server read (paths with spaces)", () => {
    // The exact `source` snapshotModel.test.ts expects describeMcp to build for this server.
    const source = '"C:\\Users\\Jane Doe\\bin\\srv.exe" --name "a b" ""';
    const draft = draftFromItem(item({ name: "srv", source, transport: "stdio" }));
    expect(splitCommandLine(draft.commandLine)).toEqual({
      command: "C:\\Users\\Jane Doe\\bin\\srv.exe",
      args: ["--name", "a b", ""],
    });
  });
});

describe("findForkItem", () => {
  it("takes the target machine's own copy, else the first machine's", () => {
    const skillOn = (source: string) =>
      snapshot({ items: [item({ id: "skill:pdf", kind: "skill", name: "pdf", source })] });
    const machines = [
      machine(PC, "This PC", { snapshot: skillOn("C:/Users/dani/.claude/skills/pdf") }),
      machine(VPS, "VPS", { snapshot: skillOn("/home/dani/.codex/skills/pdf") }),
      machine(OLD, "Old", { snapshot: snapshot() }),
    ];
    expect(findForkItem(machines, "skill:pdf", VPS)?.source).toBe("/home/dani/.codex/skills/pdf");
    expect(findForkItem(machines, "skill:pdf", OLD)?.source).toBe(
      "C:/Users/dani/.claude/skills/pdf",
    );
    expect(findForkItem(machines, "skill:none", VPS)).toBeNull();
  });
});

describe("forkInstallInspectMachine", () => {
  it("reads the paste on this machine, else on the first one that can answer", () => {
    const machines = [
      machine(OLD, "Old", { support: "needsForkUpdate", snapshot: null }),
      machine(VPS, "VPS"),
      machine(PC, "This PC"),
    ];
    expect(forkInstallInspectMachine(machines, PC)).toBe(PC);
    expect(forkInstallInspectMachine(machines, OLD)).toBe(VPS);
    expect(forkInstallInspectMachine(machines, null)).toBe(VPS);
    expect(forkInstallInspectMachine([machines[0]!], null)).toBeNull();
  });
});

describe("forkInstallTargets", () => {
  it("blocks machines and agents that cannot take it, with the reason", () => {
    const rows = forkInstallTargets(
      [
        machine(PC, "This PC"),
        machine(VPS, "VPS", {
          canOperate: false,
        }),
        machine(OLD, "Old", { support: "needsForkUpdate", snapshot: null }),
        machine(EnvironmentId.make("env-off"), "Laptop", { support: "offline", snapshot: null }),
        machine(EnvironmentId.make("env-one"), "Mini", {
          snapshot: snapshot({
            agents: [
              { agent: "claude", available: true },
              {
                agent: "codex",
                available: false,
                problem: {
                  reason: "binaryNotFound",
                  summary: "codex not found",
                  nextStep: "",
                  rawOutput: null,
                },
              },
            ],
          }),
        }),
        machine(EnvironmentId.make("env-claude"), "Box", {
          snapshot: snapshot({ agents: [{ agent: "claude", available: true }] }),
        }),
        machine(EnvironmentId.make("env-loading"), "Slow", { snapshot: null, isPending: true }),
      ],
      notionDraft(),
    );
    expect(rows.map((row) => blocked(row.targets))).toEqual([
      [
        [`${PC}\nclaude`, null, false],
        [`${PC}\ncodex`, null, false],
      ],
      [
        [`${VPS}\nclaude`, "You can view extensions on VPS but not change them.", false],
        [`${VPS}\ncodex`, "You can view extensions on VPS but not change them.", false],
      ],
      [
        [`${OLD}\nclaude`, "Old needs a fork update to install extensions.", false],
        [`${OLD}\ncodex`, "Old needs a fork update to install extensions.", false],
      ],
      [
        ["env-off\nclaude", "Laptop is offline.", false],
        ["env-off\ncodex", "Laptop is offline.", false],
      ],
      [
        ["env-one\nclaude", null, false],
        ["env-one\ncodex", "codex not found", false],
      ],
      [
        ["env-claude\nclaude", null, false],
        ["env-claude\ncodex", "Codex isn't set up on Box.", true],
      ],
      [
        ["env-loading\nclaude", "Still loading Slow.", false],
        ["env-loading\ncodex", "Still loading Slow.", false],
      ],
    ]);
  });

  it("applies each agent's own limits", () => {
    const pc = [machine(PC, "This PC")];
    const codexOf = (draft: ForkInstallDraft) => forkInstallTargets(pc, draft)[0]!.targets[1]!;
    expect(codexOf({ ...notionDraft(), type: "mcpSse" }).blocked).toBe(
      "Codex can't connect to SSE servers.",
    );
    expect(codexOf({ ...notionDraft(), scope: "project" }).blocked).toBe(
      "Codex has no per-project MCP servers.",
    );
    const plugin = retypeDraft(null, "plugin", "docs@official");
    expect(codexOf(plugin)).toMatchObject({
      blocked: "Codex has no plugins.",
      notApplicable: true,
    });
    const repo = retypeDraft(null, "plugin", "owner/repo");
    expect(forkInstallTargets(pc, repo)[0]!.targets[0]!.blocked).toBe(
      "Add its marketplace instead (paste the marketplace repo).",
    );
    const skill = { ...retypeDraft(null, "skill", "owner/repo"), name: "pdf" };
    expect(blocked(forkInstallTargets(pc, skill)[0]!.targets)).toEqual([
      [`${PC}\nclaude`, null, false],
      [`${PC}\ncodex`, null, false],
    ]);
  });

  it("needs a project on the machine for the project and local scopes", () => {
    const rows = forkInstallTargets(
      [machine(PC, "This PC", { snapshot: snapshot({ projects: [] }) })],
      { ...notionDraft(), scope: "local" },
    );
    expect(rows[0]!.targets[0]!.blocked).toBe("This PC has no T3 projects.");
  });

  it("does not offer a place that already has it", () => {
    const rows = forkInstallTargets(
      [
        machine(PC, "This PC", {
          snapshot: snapshot({
            items: [item({ cells: [cell("claude"), cell("codex", { state: "notApplicable" })] })],
          }),
        }),
      ],
      notionDraft(),
    );
    expect(blocked(rows[0]!.targets)).toEqual([
      [`${PC}\nclaude`, "Already installed on This PC.", false],
      [`${PC}\ncodex`, null, false],
    ]);
    // Plugins match on the full `plugin@marketplace`: the same name elsewhere is another plugin.
    const withDocs = [
      machine(PC, "This PC", {
        snapshot: snapshot({
          items: [item({ id: "plugin:docs@official", kind: "plugin", name: "docs@official" })],
        }),
      }),
    ];
    const marketplace = {
      ...retypeDraft(null, "marketplace", "anthropics/skills"),
      pluginRef: "docs",
    };
    const claudeOf = (draft: ForkInstallDraft) =>
      forkInstallTargets(withDocs, draft)[0]!.targets[0]!.blocked;
    expect(claudeOf({ ...marketplace, marketplaceName: "official" })).toBe(
      "Already installed on This PC.",
    );
    expect(claudeOf(marketplace)).toBeNull();
    expect(claudeOf(retypeDraft(null, "plugin", "docs"))).toBeNull();
  });
});

describe("selection", () => {
  const target = (key: string, isBlocked = false): ForkInstallTarget => ({
    key,
    environmentId: PC,
    machineLabel: "This PC",
    agent: "claude",
    blocked: isBlocked ? "no" : null,
    notApplicable: false,
  });

  it("checks every open place by default, or only the one asked for", () => {
    expect(isInstallTargetChecked(target("a"), DEFAULT_INSTALL_SELECTION)).toBe(true);
    expect(isInstallTargetChecked(target("a", true), DEFAULT_INSTALL_SELECTION)).toBe(false);
    const only = { only: "b", overrides: new Map<string, boolean>() };
    expect(isInstallTargetChecked(target("a"), only)).toBe(false);
    expect(isInstallTargetChecked(target("b"), only)).toBe(true);
    const changed = { only: "b", overrides: new Map([["a", true]]) };
    expect(isInstallTargetChecked(target("a"), changed)).toBe(true);
  });
});

describe("forkInstallPlan", () => {
  const machines = [machine(PC, "This PC"), machine(VPS, "VPS")];

  it("makes one call per machine with the checked agents", () => {
    const draft = notionDraft();
    const rows = forkInstallTargets(machines, draft);
    const selection = {
      only: null,
      overrides: new Map([[forkInstallTargetKey(VPS, "codex"), false]]),
    };
    const plan = forkInstallPlan(draft, rows, selection, new Map());
    expect(plan.count).toBe(3);
    expect(plan.blocker).toBeNull();
    expect(plan.calls).toEqual([
      {
        environmentId: PC,
        agents: ["claude", "codex"],
        request: {
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
        agents: ["claude"],
        request: expect.objectContaining({ agents: ["claude"] }),
      },
    ]);
  });

  it("builds command, plugin, marketplace and skill requests", () => {
    const one = [machine(PC, "This PC")];
    const requestOf = (draft: ForkInstallDraft) =>
      forkInstallPlan(draft, forkInstallTargets(one, draft), DEFAULT_INSTALL_SELECTION, new Map())
        .calls[0]?.request;
    expect(
      requestOf({ ...retypeDraft(null, "mcpCommand", "npx -y @x/mcp"), name: "x" }),
    ).toMatchObject({ transport: "stdio", command: "npx", args: ["-y", "@x/mcp"], url: null });
    expect(requestOf(retypeDraft(null, "plugin", "docs@official"))).toEqual({
      _tag: "plugin",
      pluginRef: "docs@official",
      marketplaceSource: null,
    });
    expect(
      requestOf({
        ...retypeDraft(null, "marketplace", "anthropics/skills"),
        marketplaceName: "team-tools",
        pluginRef: "pdf",
      }),
    ).toEqual({
      _tag: "plugin",
      pluginRef: "pdf@team-tools",
      marketplaceSource: "anthropics/skills",
    });
    // Typed by hand, with no manifest name: the repo name stands in, as on the server.
    expect(
      requestOf({
        ...retypeDraft(null, "marketplace", "https://github.com/anthropics/skills"),
        pluginRef: "pdf",
      }),
    ).toMatchObject({ pluginRef: "pdf@skills" });
    expect(requestOf({ ...retypeDraft(null, "skill", "owner/repo"), name: "pdf" })).toEqual({
      _tag: "skill",
      name: "pdf",
      agents: ["claude", "codex"],
      source: "owner/repo",
    });
  });

  it("asks for what is missing before installing", () => {
    const draft = { ...notionDraft(), scope: "project" as const };
    const rows = forkInstallTargets(machines, draft);
    const plan = forkInstallPlan(
      draft,
      rows,
      DEFAULT_INSTALL_SELECTION,
      new Map([[PC, "/repo/app"]]),
    );
    expect(plan.blocker).toBe("Pick a project on VPS.");
    const ready = forkInstallPlan(
      draft,
      rows,
      DEFAULT_INSTALL_SELECTION,
      new Map([
        [PC, "/repo/app"],
        [VPS, "/repo/app"],
      ]),
    );
    expect(ready.blocker).toBeNull();
    expect(ready.calls[0]!.request).toMatchObject({
      scope: "project",
      projectPath: "/repo/app",
      agents: ["claude"],
    });
    const unnamed = { ...notionDraft(), name: " " };
    expect(
      forkInstallPlan(
        unnamed,
        forkInstallTargets(machines, unnamed),
        DEFAULT_INSTALL_SELECTION,
        new Map(),
      ).blocker,
    ).toBe("Enter a name.");
    const repo = retypeDraft(null, "plugin", "owner/repo");
    expect(
      forkInstallPlan(
        repo,
        forkInstallTargets(machines, repo),
        DEFAULT_INSTALL_SELECTION,
        new Map(),
      ).blocker,
    ).toBe("Add its marketplace instead (paste the marketplace repo).");
    const none = { only: "nothing", overrides: new Map<string, boolean>() };
    expect(forkInstallPlan(notionDraft(), rows, none, new Map()).blocker).toBe(
      "Pick at least one place.",
    );
  });
});

describe("forkInstallStatus", () => {
  it("reads one agent's outcome from a machine's results", () => {
    const problem = {
      reason: "binaryNotFound",
      summary: "claude not found",
      nextStep: "Install Claude Code.",
      rawOutput: null,
    } as const;
    const results = [
      { agent: "claude", ok: false, problem },
      { agent: "codex", ok: true, problem: null },
    ] as const;
    expect(forkInstallStatus(results, "claude")).toEqual({ phase: "failed", problem });
    expect(forkInstallStatus(results, "codex")).toEqual({ phase: "done", problem: null });
    expect(forkInstallStatus([], "codex")).toMatchObject({ phase: "failed" });
  });
});
