import { describe, expect, it } from "@effect/vitest";
import { ForkExtensionItem, type ForkExtensionAgent } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { readClaudeJson } from "./claudeJson.ts";
import {
  buildSnapshotItems,
  emptyHealthCache,
  healthCellKey,
  type SnapshotModelInput,
} from "./snapshotModel.ts";
import type { UsageTally } from "./usage.ts";

const decodeItems = Schema.decodeUnknownSync(Schema.Array(ForkExtensionItem));

const claudeJson = readClaudeJson(
  JSON.stringify({
    mcpServers: {
      context7: { type: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp"] },
    },
    projects: {
      "C:/work/app": {
        mcpServers: { "local-db": { type: "http", url: "http://localhost:9000/mcp" } },
        disabledMcpServers: ["context7"],
      },
    },
    claudeAiMcpEverConnected: ["claude.ai Supabase"],
  }),
);

const tally = (mcp: Record<string, number>, skills: Record<string, number> = {}): UsageTally => ({
  mcp: new Map(
    Object.entries(mcp).map(([key, count]) => [
      key,
      { count, lastUsedAt: "2026-11-01T00:00:00.000Z" },
    ]),
  ),
  skills: new Map(
    Object.entries(skills).map(([key, count]) => [
      key,
      { count, lastUsedAt: "2026-11-02T00:00:00.000Z" },
    ]),
  ),
});

const baseInput = (overrides: Partial<SnapshotModelInput> = {}): SnapshotModelInput => ({
  agents: ["claude", "codex"],
  claudeJson,
  claudeProjectMcp: [],
  claudePlugins: [
    {
      id: "superpowers@claude-plugins-official",
      enabled: true,
      scope: "user",
      installPath: "C:/Users/me/.claude/plugins/cache/claude-plugins-official/superpowers/7.0.0",
    },
    {
      id: "playwright@claude-plugins-official",
      enabled: false,
      scope: "user",
      installPath: "C:/Users/me/.claude/plugins/cache/claude-plugins-official/playwright/1",
      mcpServers: { playwright: { command: "npx", args: ["@playwright/mcp@latest"] } },
    },
  ],
  claudeSkills: [
    {
      name: "superpowers:brainstorming",
      path: "C:/Users/me/.claude/plugins/cache/claude-plugins-official/superpowers/7.0.0/skills/brainstorming/SKILL.md",
      enabled: true,
      scope: "user",
    },
    {
      name: "my-skill",
      path: "C:/Users/me/.claude/skills/my-skill/SKILL.md",
      enabled: true,
      scope: "user",
    },
  ],
  codexMcp: [
    {
      name: "context7",
      enabled: false,
      transport: { type: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp"] },
    },
  ],
  codexSkills: [{ name: "my-skill", path: "C:/Users/me/.codex/skills/my-skill" }],
  stashed: {},
  disabledSkills: {},
  health: emptyHealthCache,
  usage: {},
  projects: [{ path: "C:\\work\\app", title: "App" }],
  ...overrides,
});

const find = (items: ReadonlyArray<ForkExtensionItem>, id: string) => {
  const item = items.find((candidate) => candidate.id === id);
  if (item === undefined) throw new Error(`missing item ${id}`);
  return item;
};

const cell = (item: ForkExtensionItem, agent: ForkExtensionAgent) => {
  const found = item.cells.find((candidate) => candidate.agent === agent);
  if (found === undefined) throw new Error(`missing ${agent} cell of ${item.id}`);
  return found;
};

describe("buildSnapshotItems", () => {
  it("builds rows that decode against the contract, one per kind:name", () => {
    const items = buildSnapshotItems(baseInput());
    expect(decodeItems(items)).toEqual(items);
    expect(items.map((item) => item.id)).toEqual([
      "mcp:claude.ai Supabase",
      "mcp:context7",
      "mcp:local-db",
      "mcp:plugin:playwright:playwright",
      "plugin:playwright@claude-plugins-official",
      "plugin:superpowers@claude-plugins-official",
      "skill:my-skill",
      "skill:superpowers:brainstorming",
    ]);
    for (const item of items) expect(item.cells.map((c) => c.agent)).toEqual(["claude", "codex"]);
  });

  it("shows claude.ai connectors with a not-applicable Codex cell", () => {
    const item = find(buildSnapshotItems(baseInput()), "mcp:claude.ai Supabase");
    expect(item.transport).toBe("claudeAi");
    expect(cell(item, "claude")).toMatchObject({ state: "unknown", scopes: ["claudeAi"] });
    expect(cell(item, "codex").state).toBe("notApplicable");
  });

  it("merges agents into one row and reflects per-agent state", () => {
    const item = find(buildSnapshotItems(baseInput()), "mcp:context7");
    expect(item).toMatchObject({
      transport: "stdio",
      source: "npx -y @upstash/context7-mcp",
      readOnly: false,
    });
    expect(cell(item, "claude")).toMatchObject({
      state: "unknown",
      scopes: ["user"],
      projects: [{ path: "C:/work/app", title: "App", disabled: true }],
    });
    expect(cell(item, "codex")).toMatchObject({ state: "disabled", scopes: ["user"] });
  });

  it("marks a stashed Claude MCP as disabled, and flags a stash shadowed by live config", () => {
    const items = buildSnapshotItems(
      baseInput({
        stashed: {
          linear: { type: "http", url: "https://mcp.linear.app/mcp" },
          context7: { type: "stdio", command: "old" },
        },
      }),
    );
    const linear = find(items, "mcp:linear");
    expect(linear).toMatchObject({ transport: "http", source: "https://mcp.linear.app/mcp" });
    expect(cell(linear, "claude")).toMatchObject({
      state: "disabled",
      scopes: ["user"],
      stashDiscarded: false,
    });
    expect(cell(linear, "codex").state).toBe("notInstalled");
    const context7 = find(items, "mcp:context7");
    expect(cell(context7, "claude")).toMatchObject({ state: "unknown", stashDiscarded: true });
    expect(context7.source).toBe("npx -y @upstash/context7-mcp");
  });

  it("labels local-scope servers with their projects", () => {
    const item = find(buildSnapshotItems(baseInput()), "mcp:local-db");
    expect(cell(item, "claude")).toMatchObject({
      state: "unknown",
      scopes: ["local"],
      projects: [{ path: "C:/work/app", title: "App", disabled: false }],
    });
  });

  it("labels project-scope (.mcp.json) servers using the ~/.claude.json project key", () => {
    const items = buildSnapshotItems(
      baseInput({
        claudeProjectMcp: [
          { path: "C:\\work\\app", servers: { github: { type: "http", url: "https://gh/mcp" } } },
        ],
      }),
    );
    expect(cell(find(items, "mcp:github"), "claude")).toMatchObject({
      scopes: ["project"],
      projects: [{ path: "C:/work/app", title: "App", disabled: false }],
    });
  });

  it("shows a plugin with a not-applicable Codex cell", () => {
    const item = find(
      buildSnapshotItems(baseInput()),
      "plugin:superpowers@claude-plugins-official",
    );
    expect(item).toMatchObject({
      kind: "plugin",
      name: "superpowers@claude-plugins-official",
      pluginId: "superpowers@claude-plugins-official",
      readOnly: false,
    });
    expect(cell(item, "claude")).toMatchObject({ state: "working", scopes: ["user"] });
    expect(cell(item, "codex").state).toBe("notApplicable");
    const disabled = find(
      buildSnapshotItems(baseInput()),
      "plugin:playwright@claude-plugins-official",
    );
    expect(cell(disabled, "claude").state).toBe("disabled");
  });

  it("shows plugin MCP servers read-only, disabled with their plugin", () => {
    const item = find(buildSnapshotItems(baseInput()), "mcp:plugin:playwright:playwright");
    expect(item).toMatchObject({
      transport: "plugin",
      pluginId: "playwright@claude-plugins-official",
      readOnly: true,
      source: "npx @playwright/mcp@latest",
    });
    expect(cell(item, "claude")).toMatchObject({ state: "disabled", scopes: ["plugin"] });
    expect(cell(item, "codex").state).toBe("notApplicable");
  });

  it("marks plugin skills read-only with their plugin and loose skills per agent", () => {
    const items = buildSnapshotItems(baseInput({ disabledSkills: { claude: ["old-skill"] } }));
    const pluginSkill = find(items, "skill:superpowers:brainstorming");
    expect(pluginSkill).toMatchObject({
      readOnly: true,
      pluginId: "superpowers@claude-plugins-official",
    });
    expect(cell(pluginSkill, "claude")).toMatchObject({ state: "working", scopes: ["plugin"] });
    expect(cell(pluginSkill, "codex").state).toBe("notApplicable");
    const loose = find(items, "skill:my-skill");
    expect(loose.readOnly).toBe(false);
    expect(cell(loose, "claude").state).toBe("working");
    expect(cell(loose, "codex").state).toBe("working");
    const old = find(items, "skill:old-skill");
    expect(cell(old, "claude").state).toBe("disabled");
    expect(cell(old, "codex").state).toBe("notInstalled");
  });

  it("uses the health cache when present and adds connectors only it knows", () => {
    const items = buildSnapshotItems(
      baseInput({
        health: {
          checkedAt: "2026-11-12T10:00:00.000Z",
          cells: new Map([
            [healthCellKey("mcp:context7", "claude"), { state: "working", problem: null }],
            [
              healthCellKey("mcp:claude.ai Google Drive", "claude"),
              {
                state: "needsAttention",
                problem: {
                  reason: "needsAuthorization",
                  summary: "Needs authentication",
                  nextStep: "Authorize it.",
                  rawOutput: null,
                },
              },
            ],
          ]),
        },
      }),
    );
    expect(cell(find(items, "mcp:context7"), "claude").state).toBe("working");
    // Health never overrides a switched-off cell.
    expect(cell(find(items, "mcp:context7"), "codex").state).toBe("disabled");
    const drive = find(items, "mcp:claude.ai Google Drive");
    expect(drive.transport).toBe("claudeAi");
    expect(cell(drive, "claude")).toMatchObject({
      state: "needsAttention",
      scopes: ["claudeAi"],
      problem: { reason: "needsAuthorization" },
    });
    expect(cell(drive, "codex").state).toBe("notApplicable");
  });

  it("counts usage by each agent's MCP key and by skill name; plugins sum their parts", () => {
    const items = buildSnapshotItems(
      baseInput({
        usage: {
          claude: tally(
            {
              mcp__context7__: 4,
              mcp__plugin_playwright_playwright__: 2,
              mcp__claude_ai_Supabase__: 3,
            },
            { "superpowers:brainstorming": 5, "my-skill": 1 },
          ),
          codex: tally({ mcp__context7__: 7 }),
        },
      }),
    );
    expect(cell(find(items, "mcp:context7"), "claude")).toMatchObject({
      usageCount: 4,
      lastUsedAt: "2026-11-01T00:00:00.000Z",
    });
    expect(cell(find(items, "mcp:context7"), "codex").usageCount).toBe(7);
    expect(cell(find(items, "mcp:claude.ai Supabase"), "claude").usageCount).toBe(3);
    expect(cell(find(items, "mcp:claude.ai Supabase"), "codex").usageCount).toBe(0);
    expect(cell(find(items, "skill:my-skill"), "claude").usageCount).toBe(1);
    expect(cell(find(items, "plugin:superpowers@claude-plugins-official"), "claude")).toMatchObject(
      { usageCount: 5, lastUsedAt: "2026-11-02T00:00:00.000Z" },
    );
    expect(
      cell(find(items, "plugin:playwright@claude-plugins-official"), "claude").usageCount,
    ).toBe(2);
  });

  it("only builds cells for the agents given", () => {
    const items = buildSnapshotItems(
      baseInput({ agents: ["claude"], codexMcp: [], codexSkills: [] }),
    );
    for (const item of items) expect(item.cells.map((c) => c.agent)).toEqual(["claude"]);
  });
});
