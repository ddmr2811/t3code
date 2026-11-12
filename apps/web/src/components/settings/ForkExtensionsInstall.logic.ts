import type {
  EnvironmentId,
  ForkExtensionAgent,
  ForkExtensionItem,
  ForkExtensionProblem,
  ForkInstallRequest,
  ForkInstallResult,
  ForkPastedSource,
} from "@t3tools/contracts";

import { FORK_AGENT_LABELS, type MachineState } from "./ForkExtensions.logic";

/** What the form installs; the remote MCP's transport is part of its type ("Change type"). */
export type ForkInstallType =
  | "mcpHttp"
  | "mcpSse"
  | "mcpCommand"
  | "plugin"
  | "marketplace"
  | "skill"
  | "claudeAiConnector";

export const FORK_INSTALL_TYPES: ReadonlyArray<ForkInstallType> = [
  "mcpHttp",
  "mcpSse",
  "mcpCommand",
  "plugin",
  "marketplace",
  "skill",
  "claudeAiConnector",
];

export const FORK_INSTALL_TYPE_LABELS: Readonly<Record<ForkInstallType, string>> = {
  mcpHttp: "Remote MCP (HTTP)",
  mcpSse: "Remote MCP (SSE)",
  mcpCommand: "Local MCP (command)",
  plugin: "Plugin",
  marketplace: "Plugin from a marketplace",
  skill: "Skill",
  claudeAiConnector: "claude.ai connector",
};

export type ForkMcpScope = "user" | "project" | "local";

/** Every type's fields live side by side, so changing the type keeps what was typed. */
export interface ForkInstallDraft {
  readonly type: ForkInstallType;
  /** MCP server or skill name. */
  readonly name: string;
  readonly url: string;
  readonly commandLine: string;
  /** The plugin to install; for a marketplace, the one picked from its list. */
  readonly pluginRef: string;
  readonly marketplaceSource: string;
  /** The manifest's `name`; empty when typed by hand (the repo name stands in). */
  readonly marketplaceName: string;
  readonly marketplacePlugins: ReadonlyArray<string>;
  readonly skillSource: string;
  /** Claude MCP only; Codex takes the User scope alone. */
  readonly scope: ForkMcpScope;
}

const EMPTY_DRAFT: Omit<ForkInstallDraft, "type"> = {
  name: "",
  url: "",
  commandLine: "",
  pluginRef: "",
  marketplaceSource: "",
  marketplaceName: "",
  marketplacePlugins: [],
  skillSource: "",
  scope: "user",
};

export function isMcpInstallType(type: ForkInstallType): boolean {
  return type === "mcpHttp" || type === "mcpSse" || type === "mcpCommand";
}

const COMMAND_TOKEN = /"([^"]*)"|'([^']*)'|(\S+)/g;

/** A command line as typed: spaces split arguments, quotes keep a part with spaces together. */
export function splitCommandLine(
  line: string,
): { readonly command: string; readonly args: ReadonlyArray<string> } | null {
  const tokens = [...line.matchAll(COMMAND_TOKEN)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? "",
  );
  const [command, ...args] = tokens;
  if (command === undefined || command === "") return null;
  return { command, args };
}

export function joinCommandLine(command: string, args: ReadonlyArray<string>): string {
  return [command, ...args]
    .map((part) => (/\s/.test(part) || part === "" ? `"${part}"` : part))
    .join(" ");
}

/** null: not recognised, the type is picked by hand. */
export function draftFromPasted(source: ForkPastedSource): ForkInstallDraft | null {
  switch (source._tag) {
    case "mcpRemote":
      return {
        ...EMPTY_DRAFT,
        type: source.transport === "sse" ? "mcpSse" : "mcpHttp",
        name: source.suggestedName,
        url: source.url,
      };
    case "mcpCommand":
      return {
        ...EMPTY_DRAFT,
        type: "mcpCommand",
        name: source.suggestedName,
        commandLine: joinCommandLine(source.command, source.args),
      };
    case "plugin":
      return { ...EMPTY_DRAFT, type: "plugin", pluginRef: source.pluginRef };
    case "marketplace":
      return {
        ...EMPTY_DRAFT,
        type: "marketplace",
        marketplaceSource: source.source,
        marketplaceName: source.name,
        marketplacePlugins: source.plugins,
        pluginRef: source.plugins[0] ?? "",
      };
    case "skill":
      return {
        ...EMPTY_DRAFT,
        type: "skill",
        name: source.suggestedName,
        skillSource: source.source,
      };
    case "claudeAiConnector":
      return { ...EMPTY_DRAFT, type: "claudeAiConnector" };
    case "unknown":
      return null;
  }
}

/** "Change type": the fields the new type needs come from the pasted text when still empty. */
export function retypeDraft(
  draft: ForkInstallDraft | null,
  type: ForkInstallType,
  text: string,
): ForkInstallDraft {
  const base = draft ?? { ...EMPTY_DRAFT, type };
  const pasted = text.trim();
  const fill = (value: string) => (value === "" ? pasted : value);
  switch (type) {
    case "mcpHttp":
    case "mcpSse":
      return { ...base, type, url: fill(base.url) };
    case "mcpCommand":
      return { ...base, type, commandLine: fill(base.commandLine) };
    case "plugin":
      return { ...base, type, pluginRef: fill(base.pluginRef) };
    case "marketplace":
      return { ...base, type, marketplaceSource: fill(base.marketplaceSource) };
    case "skill":
      return { ...base, type, skillSource: fill(base.skillSource) };
    case "claudeAiConnector":
      return { ...base, type };
  }
}

/** "Install here" on an item another machine already has. */
export function draftFromItem(item: ForkExtensionItem): ForkInstallDraft {
  if (item.kind === "plugin") return { ...EMPTY_DRAFT, type: "plugin", pluginRef: item.name };
  if (item.kind === "skill") {
    // A plugin's skill comes with its plugin.
    return item.pluginId === null
      ? { ...EMPTY_DRAFT, type: "skill", name: item.name, skillSource: item.source }
      : { ...EMPTY_DRAFT, type: "plugin", pluginRef: item.pluginId };
  }
  switch (item.transport) {
    case "claudeAi":
      return { ...EMPTY_DRAFT, type: "claudeAiConnector" };
    case "plugin":
      return { ...EMPTY_DRAFT, type: "plugin", pluginRef: item.pluginId ?? "" };
    case "http":
    case "sse":
      return {
        ...EMPTY_DRAFT,
        type: item.transport === "sse" ? "mcpSse" : "mcpHttp",
        name: item.name,
        url: item.source,
      };
    default:
      return { ...EMPTY_DRAFT, type: "mcpCommand", name: item.name, commandLine: item.source };
  }
}

/**
 * The item as `preferred` reports it (its own path or source), else as the first machine that
 * has it reports it.
 */
export function findForkItem(
  machines: ReadonlyArray<MachineState>,
  itemId: string,
  preferred: EnvironmentId | null = null,
): ForkExtensionItem | null {
  const ordered = [
    ...machines.filter((machine) => machine.environmentId === preferred),
    ...machines.filter((machine) => machine.environmentId !== preferred),
  ];
  for (const machine of ordered) {
    const found = machine.snapshot?.items.find((candidate) => candidate.id === itemId);
    if (found !== undefined) return found;
  }
  return null;
}

/** Spec: the paste is read on the client's own machine, else on the first one that can answer. */
export function forkInstallInspectMachine(
  machines: ReadonlyArray<MachineState>,
  primaryEnvironmentId: EnvironmentId | null,
): EnvironmentId | null {
  const supported = machines.filter((machine) => machine.support === "supported");
  return (
    supported.find((machine) => machine.environmentId === primaryEnvironmentId)?.environmentId ??
    supported[0]?.environmentId ??
    null
  );
}

export interface ForkInstallTarget {
  /** `<environmentId>\n<agent>` */
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
  readonly agent: ForkExtensionAgent;
  /** Why it cannot be checked; null when it can. */
  readonly blocked: string | null;
  /** Shown as "—": the agent has no such thing there, rather than a disabled checkbox. */
  readonly notApplicable: boolean;
}

export interface ForkInstallTargetRow {
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
  readonly projects: ReadonlyArray<{ readonly path: string; readonly title: string }>;
  /** Claude, then Codex. */
  readonly targets: ReadonlyArray<ForkInstallTarget>;
}

export function forkInstallTargetKey(
  environmentId: EnvironmentId,
  agent: ForkExtensionAgent,
): string {
  return `${environmentId}\n${agent}`;
}

const AGENTS: ReadonlyArray<ForkExtensionAgent> = ["claude", "codex"];

/** A repo is not something `claude plugin install` can find; the server says the same. */
const isPluginRepo = (ref: string) => !ref.includes("@") && ref.includes("/");
const PLUGIN_REPO_NEXT_STEP = "Add its marketplace instead (paste the marketplace repo).";

/** The repo part of `owner/repo[/path]` or a GitHub URL. */
function repoName(source: string): string {
  const parts = source
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/\.git$/, "")
    .split("/")
    .filter((part) => part.length > 0);
  return parts[1] ?? parts[0] ?? "";
}

/**
 * The `plugin@marketplace` that is installed. A marketplace typed by hand has no manifest name,
 * so its repo name stands in, as on the server.
 */
function forkPluginRef(draft: ForkInstallDraft): string {
  const plugin = draft.pluginRef.trim();
  if (draft.type !== "marketplace" || plugin === "" || plugin.includes("@")) return plugin;
  const marketplace = draft.marketplaceName.trim() || repoName(draft.marketplaceSource);
  return marketplace === "" ? plugin : `${plugin}@${marketplace}`;
}

/** The item id this draft would create, to spot a place that already has it. */
function installedItemId(draft: ForkInstallDraft): string {
  if (draft.type === "plugin" || draft.type === "marketplace") {
    return `plugin:${forkPluginRef(draft)}`;
  }
  return `${draft.type === "skill" ? "skill" : "mcp"}:${draft.name.trim()}`;
}

/** What the server would refuse, shown up front as a disabled checkbox (spec §6.2, §6.5). */
function typeLimit(
  draft: ForkInstallDraft,
  agent: ForkExtensionAgent,
): { readonly reason: string; readonly notApplicable: boolean } | null {
  const isPlugin = draft.type === "plugin" || draft.type === "marketplace";
  if (isPlugin && agent === "codex")
    return { reason: "Codex has no plugins.", notApplicable: true };
  if (draft.type === "plugin" && isPluginRepo(draft.pluginRef.trim())) {
    return { reason: PLUGIN_REPO_NEXT_STEP, notApplicable: false };
  }
  if (isMcpInstallType(draft.type) && agent === "codex") {
    if (draft.scope !== "user") {
      return { reason: "Codex has no per-project MCP servers.", notApplicable: false };
    }
    if (draft.type === "mcpSse") {
      return { reason: "Codex can't connect to SSE servers.", notApplicable: false };
    }
  }
  return null;
}

function machineBlock(machine: MachineState): string | null {
  switch (machine.support) {
    case "needsForkUpdate":
      return `${machine.label} needs a fork update to install extensions.`;
    case "offline":
      return `${machine.label} is offline.`;
    case "supported":
      if (machine.snapshot === null) {
        return machine.error === null
          ? `Still loading ${machine.label}.`
          : `${machine.label}: ${machine.error}`;
      }
      return machine.canOperate
        ? null
        : `You can view extensions on ${machine.label} but not change them.`;
  }
}

/** The "Where should it go?" grid: one row per machine, one place per agent. */
export function forkInstallTargets(
  machines: ReadonlyArray<MachineState>,
  draft: ForkInstallDraft,
): ReadonlyArray<ForkInstallTargetRow> {
  const installedId = installedItemId(draft);
  return machines.map((machine): ForkInstallTargetRow => {
    const snapshot = machine.support === "supported" ? machine.snapshot : null;
    const machineReason = machineBlock(machine);
    const targets = AGENTS.map((agent): ForkInstallTarget => {
      const base = {
        key: forkInstallTargetKey(machine.environmentId, agent),
        environmentId: machine.environmentId,
        machineLabel: machine.label,
        agent,
      };
      const open = { ...base, blocked: null, notApplicable: false };
      const stop = (reason: string, notApplicable = false) => ({
        ...base,
        blocked: reason,
        notApplicable,
      });
      if (machineReason !== null || snapshot === null) {
        return stop(machineReason ?? `Still loading ${machine.label}.`);
      }
      const entry = snapshot.agents.find((candidate) => candidate.agent === agent);
      if (entry === undefined || (!entry.available && entry.problem === undefined)) {
        return stop(`${FORK_AGENT_LABELS[agent]} isn't set up on ${machine.label}.`, true);
      }
      if (!entry.available) return stop(entry.problem?.summary ?? "Unavailable.");
      const limit = typeLimit(draft, agent);
      if (limit !== null) return stop(limit.reason, limit.notApplicable);
      if (
        isMcpInstallType(draft.type) &&
        draft.scope !== "user" &&
        snapshot.projects.length === 0
      ) {
        return stop(`${machine.label} has no T3 projects.`);
      }
      const installed = snapshot.items.some(
        (candidate) =>
          candidate.id === installedId &&
          candidate.cells.some(
            (own) =>
              own.agent === agent && own.state !== "notInstalled" && own.state !== "notApplicable",
          ),
      );
      if (installed) return stop(`Already installed on ${machine.label}.`);
      return open;
    });
    return {
      environmentId: machine.environmentId,
      machineLabel: machine.label,
      projects: snapshot?.projects ?? [],
      targets,
    };
  });
}

/**
 * The checked places: by default every open one (spec §6.2), or only the one "Install here"
 * asked for; the user's own clicks override either. Blocked places are never checked, so a
 * change of scope or type unchecks what no longer applies and restores it when it does again.
 */
export interface ForkInstallSelection {
  readonly only: string | null;
  readonly overrides: ReadonlyMap<string, boolean>;
}

export const DEFAULT_INSTALL_SELECTION: ForkInstallSelection = { only: null, overrides: new Map() };

export function isInstallTargetChecked(
  target: ForkInstallTarget,
  selection: ForkInstallSelection,
): boolean {
  if (target.blocked !== null) return false;
  return (
    selection.overrides.get(target.key) ??
    (selection.only === null || selection.only === target.key)
  );
}

export interface ForkInstallCall {
  readonly environmentId: EnvironmentId;
  readonly agents: readonly [ForkExtensionAgent, ...ForkExtensionAgent[]];
  readonly request: ForkInstallRequest;
}

function draftProblem(draft: ForkInstallDraft): string | null {
  switch (draft.type) {
    case "mcpHttp":
    case "mcpSse":
      if (draft.name.trim() === "") return "Enter a name.";
      return /^https?:\/\/\S+$/i.test(draft.url.trim()) ? null : "Enter the server's http(s) URL.";
    case "mcpCommand":
      if (draft.name.trim() === "") return "Enter a name.";
      return splitCommandLine(draft.commandLine) === null
        ? "Enter the command that starts the server."
        : null;
    case "plugin":
      return draft.pluginRef.trim() === "" ? "Enter the plugin, as name@marketplace." : null;
    case "marketplace":
      if (draft.marketplaceSource.trim() === "") return "Enter the marketplace repo.";
      return draft.pluginRef.trim() === "" ? "Pick a plugin." : null;
    case "skill":
      if (draft.name.trim() === "") return "Enter a name.";
      return draft.skillSource.trim() === "" ? "Enter where the skill comes from." : null;
    case "claudeAiConnector":
      return "claude.ai connectors are connected on claude.ai.";
  }
}

function requestFor(
  draft: ForkInstallDraft,
  agents: readonly [ForkExtensionAgent, ...ForkExtensionAgent[]],
  projectPath: string | null,
): ForkInstallRequest {
  switch (draft.type) {
    case "plugin":
    case "marketplace":
      return {
        _tag: "plugin",
        pluginRef: forkPluginRef(draft),
        marketplaceSource: draft.type === "marketplace" ? draft.marketplaceSource.trim() : null,
      };
    case "skill":
      return { _tag: "skill", name: draft.name.trim(), agents, source: draft.skillSource.trim() };
    default: {
      const command = draft.type === "mcpCommand" ? splitCommandLine(draft.commandLine) : null;
      return {
        _tag: "mcp",
        name: draft.name.trim(),
        agents,
        transport: draft.type === "mcpCommand" ? "stdio" : draft.type === "mcpSse" ? "sse" : "http",
        command: command?.command ?? null,
        args: [...(command?.args ?? [])],
        url: draft.type === "mcpCommand" ? null : draft.url.trim(),
        scope: draft.scope,
        projectPath: draft.scope === "user" ? null : projectPath,
      };
    }
  }
}

/** "Install in N places": one call per machine with its checked agents, or why not yet. */
export function forkInstallPlan(
  draft: ForkInstallDraft,
  rows: ReadonlyArray<ForkInstallTargetRow>,
  selection: ForkInstallSelection,
  projectByMachine: ReadonlyMap<EnvironmentId, string>,
): {
  readonly calls: ReadonlyArray<ForkInstallCall>;
  readonly count: number;
  readonly blocker: string | null;
} {
  const needsProject = isMcpInstallType(draft.type) && draft.scope !== "user";
  const calls: Array<ForkInstallCall> = [];
  let count = 0;
  let missingProject: string | null = null;
  for (const row of rows) {
    const agents = row.targets
      .filter((target) => isInstallTargetChecked(target, selection))
      .map((target) => target.agent);
    const [first, ...rest] = agents;
    if (first === undefined) continue;
    count += agents.length;
    const projectPath = projectByMachine.get(row.environmentId) ?? null;
    const known = row.projects.some((project) => project.path === projectPath);
    if (needsProject && !known) missingProject ??= `Pick a project on ${row.machineLabel}.`;
    calls.push({
      environmentId: row.environmentId,
      agents: [first, ...rest],
      request: requestFor(draft, [first, ...rest], known ? projectPath : null),
    });
  }
  const blocker =
    draftProblem(draft) ??
    (count === 0
      ? draft.type === "plugin" && isPluginRepo(draft.pluginRef.trim())
        ? PLUGIN_REPO_NEXT_STEP
        : "Pick at least one place."
      : missingProject);
  return { calls, count, blocker };
}

export type ForkInstallStatus =
  | { readonly phase: "running" }
  /** `problem`: installed with a warning. */
  | { readonly phase: "done"; readonly problem: ForkExtensionProblem | null }
  | { readonly phase: "failed"; readonly problem: ForkExtensionProblem };

/** `ok` decides success; `ok` with a problem is a success with a warning. */
export function forkInstallStatus(
  results: ReadonlyArray<ForkInstallResult>,
  agent: ForkExtensionAgent,
): ForkInstallStatus {
  const own = results.find((result) => result.agent === agent);
  if (own === undefined) {
    return {
      phase: "failed",
      problem: {
        reason: "commandFailed",
        summary: `The machine did not report on ${FORK_AGENT_LABELS[agent]}.`,
        nextStep: "Check status, then try again.",
        rawOutput: null,
      },
    };
  }
  if (own.ok) return { phase: "done", problem: own.problem };
  return {
    phase: "failed",
    problem: own.problem ?? {
      reason: "commandFailed",
      summary: "The install failed.",
      nextStep: "Try again.",
      rawOutput: null,
    },
  };
}
