import type {
  ForkCellState,
  ForkExtensionAgent,
  ForkExtensionCell,
  ForkExtensionItem,
  ForkExtensionKind,
  ForkExtensionProblem,
  ForkExtensionScope,
  ForkMcpTransport,
  ForkProjectToggle,
  ServerProviderSkill,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";

import type { ClaudeJsonView } from "./claudeJson.ts";
import type { ClaudePluginListEntry, CodexMcpListEntry } from "./cliJson.ts";
import { usageKeyForMcp, type UsageEntry, type UsageTally } from "./usage.ts";

export interface HealthCell {
  readonly state: ForkCellState;
  readonly problem: ForkExtensionProblem | null;
}

/** Last known health per cell, keyed by `healthCellKey(itemId, agent)`. */
export interface HealthCache {
  readonly checkedAt: string | null;
  readonly cells: ReadonlyMap<string, HealthCell>;
}

export const emptyHealthCache: HealthCache = { checkedAt: null, cells: new Map() };

export const healthCellKey = (itemId: string, agent: ForkExtensionAgent): string =>
  `${itemId}|${agent}`;

export interface SkillFolder {
  readonly name: string;
  readonly path: string;
}

/** Servers of a repo's `.mcp.json` (Claude "project" scope). */
export interface ClaudeProjectMcp {
  readonly path: string;
  readonly servers: Record<string, unknown>;
}

export interface SnapshotModelInput {
  /** Agents with a column on this machine; every row gets one cell per agent, in this order. */
  readonly agents: ReadonlyArray<ForkExtensionAgent>;
  readonly claudeJson: ClaudeJsonView | null;
  readonly claudeProjectMcp: ReadonlyArray<ClaudeProjectMcp>;
  readonly claudePlugins: ReadonlyArray<ClaudePluginListEntry>;
  readonly claudeSkills: ReadonlyArray<ServerProviderSkill>;
  readonly codexMcp: ReadonlyArray<CodexMcpListEntry>;
  readonly codexSkills: ReadonlyArray<SkillFolder>;
  /** Claude user-scope MCP definitions switched off globally (disabledStore). */
  readonly stashed: Record<string, unknown>;
  readonly disabledSkills: Partial<Record<ForkExtensionAgent, ReadonlyArray<string>>>;
  readonly health: HealthCache;
  readonly usage: Partial<Record<ForkExtensionAgent, UsageTally>>;
  /** T3 projects, used for project titles. */
  readonly projects: ReadonlyArray<{ readonly path: string; readonly title: string }>;
}

interface CellDraft {
  installed: boolean;
  readonly scopes: Set<ForkExtensionScope>;
  readonly projects: Map<string, ForkProjectToggle>;
  stashDiscarded: boolean;
}

interface ItemDraft {
  readonly kind: ForkExtensionKind;
  readonly name: string;
  source: string;
  transport: ForkMcpTransport | null;
  pluginId: string | null;
  readOnly: boolean;
  readonly cells: Map<ForkExtensionAgent, CellDraft>;
  /** Plugins: usage keys of their MCP servers and skills. */
  readonly members: Array<{ readonly mcp: string } | { readonly skill: string }>;
}

const KIND_ORDER: Record<ForkExtensionKind, number> = { mcp: 0, plugin: 1, skill: 2 };
const SCOPE_ORDER: ReadonlyArray<ForkExtensionScope> = [
  "user",
  "project",
  "local",
  "plugin",
  "claudeAi",
];
const CLAUDE_AI_PREFIX = "claude.ai ";
const PLUGIN_MCP_PREFIX = "plugin:";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const pluginName = (pluginId: string): string => pluginId.split("@")[0] ?? pluginId;

const comparablePath = (value: string): string =>
  normalizeProjectPathForComparison(value).replaceAll("\\", "/").toLowerCase();

const describeMcp = (
  definition: unknown,
): { readonly source: string; readonly transport: ForkMcpTransport } => {
  const record = isRecord(definition) ? definition : {};
  const url = typeof record.url === "string" ? record.url : null;
  const command = typeof record.command === "string" ? record.command : null;
  const args = Array.isArray(record.args)
    ? record.args.filter((arg): arg is string => typeof arg === "string")
    : [];
  const type = typeof record.type === "string" ? record.type : null;
  const transport: ForkMcpTransport =
    type === "sse"
      ? "sse"
      : type === "http" || type === "streamable_http" || (type === null && url !== null)
        ? "http"
        : "stdio";
  return { source: url ?? [command ?? "", ...args].join(" ").trim(), transport };
};

const fileDirectory = (filePath: string): string => filePath.replace(/[\\/]SKILL\.md$/i, "");

/**
 * Pure: turns everything read from one machine into matrix rows. One row per `<kind>:<name>`,
 * one cell per available agent. Health only colors installed, switched-on cells; rows it knows
 * that the config doesn't (connectors needing auth, plugin servers) still appear.
 */
export const buildSnapshotItems = (input: SnapshotModelInput): ReadonlyArray<ForkExtensionItem> => {
  const drafts = new Map<string, ItemDraft>();
  const claudeProjects = input.claudeJson?.projects ?? [];

  const titleByPath = new Map(
    input.projects.map((project) => [comparablePath(project.path), project.title]),
  );
  const claudeKeyByPath = new Map(
    claudeProjects.map((project) => [comparablePath(project.path), project.path]),
  );
  const disabledByProject = new Map(
    claudeProjects.map((project) => [comparablePath(project.path), new Set(project.disabled)]),
  );
  const projectToggle = (projectPath: string, serverName: string): ForkProjectToggle => {
    const key = comparablePath(projectPath);
    const path = claudeKeyByPath.get(key) ?? projectPath;
    return {
      path,
      title: titleByPath.get(key) ?? path.split(/[\\/]/).findLast((part) => part !== "") ?? path,
      disabled: disabledByProject.get(key)?.has(serverName) ?? false,
    };
  };

  const item = (
    kind: ForkExtensionKind,
    name: string,
    defaults: { readonly source?: string; readonly transport?: ForkMcpTransport | null } = {},
  ): ItemDraft => {
    const id = `${kind}:${name}`;
    let draft = drafts.get(id);
    if (draft === undefined) {
      draft = {
        kind,
        name,
        source: "",
        transport: null,
        pluginId: null,
        readOnly: false,
        cells: new Map(),
        members: [],
      };
      drafts.set(id, draft);
    }
    // First reader that knows a source/transport wins; live config is read before stash.
    if (draft.source === "" && defaults.source) draft.source = defaults.source;
    if (draft.transport === null && defaults.transport) draft.transport = defaults.transport;
    return draft;
  };

  const cellOf = (draft: ItemDraft, agent: ForkExtensionAgent): CellDraft => {
    let cell = draft.cells.get(agent);
    if (cell === undefined) {
      cell = { installed: false, scopes: new Set(), projects: new Map(), stashDiscarded: false };
      draft.cells.set(agent, cell);
    }
    return cell;
  };

  const install = (
    draft: ItemDraft,
    agent: ForkExtensionAgent,
    scope: ForkExtensionScope,
    on: boolean,
  ) => {
    const cell = cellOf(draft, agent);
    cell.scopes.add(scope);
    cell.installed ||= on;
    return cell;
  };

  // Claude MCP: user scope, local scope (~/.claude.json projects) and project scope (.mcp.json).
  for (const [name, definition] of Object.entries(input.claudeJson?.userServers ?? {})) {
    install(item("mcp", name, describeMcp(definition)), "claude", "user", true);
  }
  for (const project of claudeProjects) {
    for (const [name, definition] of Object.entries(project.servers)) {
      const cell = install(item("mcp", name, describeMcp(definition)), "claude", "local", false);
      const toggle = projectToggle(project.path, name);
      cell.projects.set(comparablePath(toggle.path), toggle);
      cell.installed ||= !toggle.disabled;
    }
  }
  for (const project of input.claudeProjectMcp) {
    for (const [name, definition] of Object.entries(project.servers)) {
      const cell = install(item("mcp", name, describeMcp(definition)), "claude", "project", false);
      const toggle = projectToggle(project.path, name);
      cell.projects.set(comparablePath(toggle.path), toggle);
      cell.installed ||= !toggle.disabled;
    }
  }
  for (const name of input.claudeJson?.claudeAiConnectors ?? []) {
    install(
      item("mcp", name, { source: "claude.ai", transport: "claudeAi" }),
      "claude",
      "claudeAi",
      true,
    );
  }

  // Claude plugins, with the MCP servers they bundle.
  for (const plugin of input.claudePlugins) {
    const pluginDraft = item("plugin", plugin.id, { source: plugin.id.split("@")[1] ?? "" });
    pluginDraft.pluginId = plugin.id;
    install(
      pluginDraft,
      "claude",
      plugin.scope === "project" || plugin.scope === "local" ? plugin.scope : "user",
      plugin.enabled,
    );
    for (const [server, definition] of Object.entries(plugin.mcpServers ?? {})) {
      const name = `${PLUGIN_MCP_PREFIX}${pluginName(plugin.id)}:${server}`;
      const draft = item("mcp", name, {
        source: describeMcp(definition).source,
        transport: "plugin",
      });
      draft.pluginId = plugin.id;
      draft.readOnly = true;
      install(draft, "claude", "plugin", plugin.enabled);
      pluginDraft.members.push({ mcp: name });
    }
  }

  // Stashed (globally switched-off) Claude MCP servers. Live config with the same name wins.
  for (const [name, definition] of Object.entries(input.stashed)) {
    const draft = item("mcp", name, describeMcp(definition));
    const live = draft.cells.get("claude");
    if (live?.scopes.has("user")) {
      live.stashDiscarded = true;
    } else {
      install(draft, "claude", "user", false);
    }
  }

  // Skills.
  const pluginByPath = input.claudePlugins.map((plugin) => ({
    id: plugin.id,
    root: `${comparablePath(plugin.installPath)}/`,
  }));
  for (const skill of input.claudeSkills) {
    const separator = skill.name.indexOf(":");
    if (separator === -1) {
      install(
        item("skill", skill.name, { source: fileDirectory(skill.path) }),
        "claude",
        "user",
        skill.enabled,
      );
      continue;
    }
    const prefix = skill.name.slice(0, separator);
    const skillPath = comparablePath(skill.path);
    const pluginId =
      pluginByPath.find((plugin) => skillPath.startsWith(plugin.root))?.id ??
      input.claudePlugins.find((plugin) => pluginName(plugin.id) === prefix)?.id ??
      null;
    const draft = item("skill", skill.name, { source: fileDirectory(skill.path) });
    draft.pluginId = pluginId;
    draft.readOnly = true;
    install(draft, "claude", "plugin", skill.enabled);
    if (pluginId !== null) item("plugin", pluginId).members.push({ skill: skill.name });
  }
  for (const skill of input.codexSkills) {
    install(item("skill", skill.name, { source: skill.path }), "codex", "user", true);
  }
  for (const [agent, names] of Object.entries(input.disabledSkills) as Array<
    [ForkExtensionAgent, ReadonlyArray<string>]
  >) {
    for (const name of names) install(item("skill", name), agent, "user", false);
  }

  // Codex MCP.
  for (const server of input.codexMcp) {
    const described = describeMcp({ ...server.transport });
    install(item("mcp", server.name, described), "codex", "user", server.enabled);
  }

  // Rows only the health cache knows (connectors that need auth, plugin servers).
  for (const [key, health] of input.health.cells) {
    const separator = key.lastIndexOf("|");
    const itemId = key.slice(0, separator);
    const agent = key.slice(separator + 1);
    if (!itemId.startsWith("mcp:") || (agent !== "claude" && agent !== "codex")) continue;
    if (health.state === "notInstalled" || health.state === "notApplicable") continue;
    const name = itemId.slice("mcp:".length);
    if (drafts.has(itemId) && drafts.get(itemId)!.cells.has(agent)) continue;
    const isClaudeAi = name.startsWith(CLAUDE_AI_PREFIX);
    const isPlugin = name.startsWith(PLUGIN_MCP_PREFIX);
    const draft = item(
      "mcp",
      name,
      isClaudeAi
        ? { source: "claude.ai", transport: "claudeAi" }
        : isPlugin
          ? { transport: "plugin" }
          : {},
    );
    if (isPlugin) {
      draft.readOnly = true;
      const plugin = name.split(":")[1];
      draft.pluginId ??=
        input.claudePlugins.find((candidate) => pluginName(candidate.id) === plugin)?.id ?? null;
    }
    install(draft, agent, isClaudeAi ? "claudeAi" : isPlugin ? "plugin" : "user", true);
  }

  // Per-project "off" switches for servers that are not defined per project.
  for (const draft of drafts.values()) {
    if (draft.kind !== "mcp") continue;
    const cell = draft.cells.get("claude");
    if (cell === undefined) continue;
    for (const project of claudeProjects) {
      if (!project.disabled.includes(draft.name)) continue;
      const key = comparablePath(project.path);
      if (!cell.projects.has(key)) cell.projects.set(key, projectToggle(project.path, draft.name));
    }
  }

  const usageOf = (draft: ItemDraft, agent: ForkExtensionAgent): UsageEntry | undefined => {
    const tally = input.usage[agent];
    if (tally === undefined) return undefined;
    if (draft.kind === "mcp") return tally.mcp.get(usageKeyForMcp(agent, draft.name));
    if (draft.kind === "skill") return tally.skills.get(draft.name);
    let count = 0;
    let lastUsedAt: string | null = null;
    for (const member of draft.members) {
      const entry =
        "mcp" in member
          ? tally.mcp.get(usageKeyForMcp(agent, member.mcp))
          : tally.skills.get(member.skill);
      if (entry === undefined) continue;
      count += entry.count;
      if (entry.lastUsedAt !== null && (lastUsedAt === null || entry.lastUsedAt > lastUsedAt)) {
        lastUsedAt = entry.lastUsedAt;
      }
    }
    return { count, lastUsedAt };
  };

  // Claude namespaces plugin skills as `<plugin>:<skill>`; even when the plugin can't be
  // identified, such a skill can never be installed in Codex.
  const notApplicable = (draft: ItemDraft, agent: ForkExtensionAgent): boolean =>
    agent === "codex" &&
    (draft.kind === "plugin" ||
      draft.pluginId !== null ||
      draft.transport === "claudeAi" ||
      (draft.kind === "skill" && draft.name.includes(":")));

  const finishCell = (
    id: string,
    draft: ItemDraft,
    agent: ForkExtensionAgent,
  ): ForkExtensionCell => {
    if (notApplicable(draft, agent)) {
      return {
        agent,
        state: "notApplicable",
        scopes: [],
        projects: [],
        problem: null,
        usageCount: 0,
        lastUsedAt: null,
        stashDiscarded: false,
      };
    }
    const cell = draft.cells.get(agent);
    const usage = usageOf(draft, agent);
    const health = input.health.cells.get(healthCellKey(id, agent));
    const state: ForkCellState =
      cell === undefined
        ? "notInstalled"
        : !cell.installed
          ? "disabled"
          : (health?.state ?? (draft.kind === "mcp" ? "unknown" : "working"));
    return {
      agent,
      state,
      scopes: SCOPE_ORDER.filter((scope) => cell?.scopes.has(scope)),
      projects: [...(cell?.projects.values() ?? [])],
      problem: cell?.installed ? (health?.problem ?? null) : null,
      usageCount: usage?.count ?? 0,
      lastUsedAt: usage?.lastUsedAt ?? null,
      stashDiscarded: cell?.stashDiscarded ?? false,
    };
  };

  return [...drafts.entries()]
    .toSorted(
      ([, left], [, right]) =>
        KIND_ORDER[left.kind] - KIND_ORDER[right.kind] ||
        left.name.localeCompare(right.name, "en", { sensitivity: "base" }) ||
        (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
    )
    .map(([id, draft]) => ({
      id,
      kind: draft.kind,
      name: draft.name,
      source: draft.source,
      transport: draft.kind === "mcp" ? draft.transport : null,
      pluginId: draft.pluginId,
      readOnly: draft.readOnly,
      cells: input.agents.map((agent) => finishCell(id, draft, agent)),
    }));
};
