import type {
  EnvironmentId,
  ForkCellState,
  ForkExtensionAgent,
  ForkExtensionCell,
  ForkExtensionItem,
  ForkExtensionKind,
  ForkExtensionProblem,
  ForkExtensionsSnapshot,
  ForkHealthEvent,
} from "@t3tools/contracts";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { AsyncResult } from "effect/reactivity";

/** Spec §7.2: opening the page re-checks health only when the cached check is older than this. */
export const HEALTH_STALE_MS = 600_000;

export type MachineSupport = "supported" | "needsForkUpdate" | "offline";

export interface MachineState {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** While `isPending`, "offline" is provisional: the machine is still connecting. */
  readonly support: MachineSupport;
  /**
   * Installing, toggling and authorizing need the operate grant; without it (or while it loads)
   * the machine is read-only (spec §7.1, as in SecretsSettings).
   */
  readonly canOperate: boolean;
  /** The latest health check run from this page is already laid over it. */
  readonly snapshot: ForkExtensionsSnapshot | null;
  readonly error: string | null;
  /** True only until the first snapshot arrives; a background refetch keeps it false. */
  readonly isPending: boolean;
  readonly isCheckingHealth: boolean;
  readonly healthError: string | null;
}

/** The snapshot needs only read access, so operate access never holds it back. */
export function classifyMachineSupport(input: {
  readonly connectionPhase: EnvironmentConnectionPhase;
  readonly hasServerConfig: boolean;
  readonly forkExtensionsVersion: number | undefined;
  readonly operateAccess: "granted" | "denied" | "pending";
}): {
  readonly support: MachineSupport;
  readonly isPending: boolean;
  readonly canOperate: boolean;
} {
  const canOperate = input.operateAccess === "granted";
  // An incompatible host is what an old build looks like from here.
  if (input.connectionPhase === "unsupported") {
    return { support: "needsForkUpdate", isPending: false, canOperate: false };
  }
  if (input.connectionPhase !== "connected") {
    const connecting =
      input.connectionPhase === "connecting" || input.connectionPhase === "reconnecting";
    return { support: "offline", isPending: connecting, canOperate: false };
  }
  if (!input.hasServerConfig) return { support: "offline", isPending: true, canOperate: false };
  // Spec §6.5: absent on upstream T3 Code and on fork builds from before Extensions.
  if (input.forkExtensionsVersion === undefined || input.forkExtensionsVersion < 1) {
    return { support: "needsForkUpdate", isPending: false, canOperate: false };
  }
  return { support: "supported", isPending: false, canOperate };
}

export function isHealthStale(healthCheckedAt: string | null, nowMs: number): boolean {
  if (healthCheckedAt === null) return true;
  const checkedAt = Date.parse(healthCheckedAt);
  return Number.isNaN(checkedAt) || nowMs - checkedAt > HEALTH_STALE_MS;
}

export interface HealthDecision {
  /** The on-open check was decided: started, or skipped because the cached one is fresh. */
  readonly decided: boolean;
  /** A check runs, or ran, while the page stays open. */
  readonly active: boolean;
}

/**
 * Spec §7.2: opening the page checks health only on machines whose cached check is missing or
 * stale, judged once from the first snapshot; "Check status" (`wanted`) starts one regardless.
 */
export function nextHealthDecision(
  previous: HealthDecision | null,
  input: {
    readonly wanted: boolean;
    readonly snapshot: ForkExtensionsSnapshot | null;
    readonly nowMs: number;
  },
): HealthDecision {
  if (previous?.active === true) return previous;
  if (input.wanted) return { decided: true, active: true };
  if (previous?.decided === true) return previous;
  if (input.snapshot === null) return previous ?? { decided: false, active: false };
  return { decided: true, active: isHealthStale(input.snapshot.healthCheckedAt, input.nowMs) };
}

export interface ForkHealthCellUpdate {
  readonly itemId: string;
  readonly agent: ForkExtensionAgent;
  readonly state: ForkCellState;
  readonly problem: ForkExtensionProblem | null;
}

export interface ForkHealthProgress {
  readonly cells: ReadonlyArray<ForkHealthCellUpdate>;
  /** null while the check runs. */
  readonly checkedAt: string | null;
}

export const EMPTY_HEALTH_PROGRESS: ForkHealthProgress = { cells: [], checkedAt: null };

export function reduceHealthEvent(
  progress: ForkHealthProgress,
  event: ForkHealthEvent,
): ForkHealthProgress {
  if (event._tag === "done") return { ...progress, checkedAt: event.checkedAt };
  const { itemId, agent, state, problem } = event;
  return { ...progress, cells: [...progress.cells, { itemId, agent, state, problem }] };
}

/** Running from the first value until `done`; a failed check is not running. */
export function isForkHealthRunning(
  result: AsyncResult.AsyncResult<ForkHealthProgress, unknown> | null,
): boolean {
  if (result === null || result._tag === "Failure") return false;
  const progress = AsyncResult.getOrElse(result, () => null);
  return progress === null || progress.checkedAt === null;
}

/**
 * The server caches every check, so a snapshot read after it already carries the result.
 * Until then the check's cells replace the snapshot's.
 */
export function applyHealthProgress(
  snapshot: ForkExtensionsSnapshot,
  progress: ForkHealthProgress | null,
): ForkExtensionsSnapshot {
  if (progress === null || (progress.cells.length === 0 && progress.checkedAt === null)) {
    return snapshot;
  }
  if (
    progress.checkedAt !== null &&
    snapshot.healthCheckedAt !== null &&
    Date.parse(snapshot.healthCheckedAt) >= Date.parse(progress.checkedAt)
  ) {
    return snapshot;
  }
  const updates = new Map(
    progress.cells.map((update) => [`${update.itemId}\n${update.agent}`, update]),
  );
  return {
    ...snapshot,
    healthCheckedAt: progress.checkedAt ?? snapshot.healthCheckedAt,
    items: snapshot.items.map((item) =>
      item.cells.some((cell) => updates.has(`${item.id}\n${cell.agent}`))
        ? {
            ...item,
            cells: item.cells.map((cell) => {
              const update = updates.get(`${item.id}\n${cell.agent}`);
              return update === undefined
                ? cell
                : { ...cell, state: update.state, problem: update.problem };
            }),
          }
        : item,
    ),
  };
}

export interface MatrixColumn {
  /** `<environmentId>:<agent>`, or `<environmentId>:machine` for a machine that cannot be read. */
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
  /** null: the single column of a machine whose support is not "supported". */
  readonly agent: ForkExtensionAgent | null;
  readonly support: MachineSupport;
  /** false: show it, but do not offer installs or toggles there (Tasks 13 and 14). */
  readonly canOperate: boolean;
  /** Why this agent could not be read on that machine (header: "Codex: <summary>"). */
  readonly problem: ForkExtensionProblem | null;
}

/** Placeholder cells carry no `agent`; `isSnapshotCell` tells them apart. */
export type MatrixCell =
  | ForkExtensionCell
  | { readonly state: "notInstalled" }
  | { readonly state: "notApplicable" }
  | { readonly state: "agentUnavailable" }
  | { readonly state: Exclude<MachineSupport, "supported"> };

export interface MatrixRow {
  /** The item as the first machine that has it reports it. */
  readonly item: ForkExtensionItem;
  /** Each machine's own copy (its source or transport may differ from `item`'s). */
  readonly itemsByMachine: ReadonlyMap<EnvironmentId, ForkExtensionItem>;
  /** Aligned with `columns`. */
  readonly cells: ReadonlyArray<MatrixCell>;
  readonly usageTotal: number;
  readonly hasProblem: boolean;
}

export interface ForkExtensionsMatrix {
  readonly columns: ReadonlyArray<MatrixColumn>;
  readonly rows: ReadonlyArray<MatrixRow>;
}

export function isSnapshotCell(cell: MatrixCell): cell is ForkExtensionCell {
  return "agent" in cell;
}

const AGENT_ORDER: ReadonlyArray<ForkExtensionAgent> = ["claude", "codex"];

function machineColumns(machine: MachineState): ReadonlyArray<MatrixColumn> {
  const base = {
    environmentId: machine.environmentId,
    machineLabel: machine.label,
    canOperate: machine.support === "supported" && machine.canOperate,
  };
  if (machine.support !== "supported") {
    return [
      {
        ...base,
        key: `${machine.environmentId}:machine`,
        agent: null,
        support: machine.support,
        problem: null,
      },
    ];
  }
  // A machine appears once it answers (spec §7.2); until then its status lives on `machines`.
  if (machine.snapshot === null) return [];
  const agents = machine.snapshot.agents;
  return AGENT_ORDER.flatMap((agent): ReadonlyArray<MatrixColumn> => {
    const entry = agents.find((candidate) => candidate.agent === agent);
    // No enabled instance of the agent on that machine: no column.
    if (entry === undefined) return [];
    if (!entry.available && entry.problem === undefined) return [];
    return [
      {
        ...base,
        key: `${machine.environmentId}:${agent}`,
        agent,
        support: "supported",
        problem: entry.available ? null : (entry.problem ?? null),
      },
    ];
  });
}

export function buildMatrix(
  machines: ReadonlyArray<MachineState>,
  kind: ForkExtensionKind,
): ForkExtensionsMatrix {
  const columns = machines.flatMap(machineColumns);
  const itemsByMachine = new Map<EnvironmentId, ReadonlyMap<string, ForkExtensionItem>>();
  const firstSeen = new Map<string, ForkExtensionItem>();
  const notApplicable = new Set<string>();
  for (const machine of machines) {
    if (machine.support !== "supported" || machine.snapshot === null) continue;
    const items = new Map<string, ForkExtensionItem>();
    for (const item of machine.snapshot.items) {
      if (item.kind !== kind) continue;
      items.set(item.id, item);
      if (!firstSeen.has(item.id)) firstSeen.set(item.id, item);
      for (const cell of item.cells) {
        if (cell.state === "notApplicable") notApplicable.add(`${item.id}\n${cell.agent}`);
      }
    }
    itemsByMachine.set(machine.environmentId, items);
  }

  const rows = [...firstSeen.values()].map((item): MatrixRow => {
    const cells = columns.map((column): MatrixCell => {
      if (column.agent === null) {
        return { state: column.support as Exclude<MachineSupport, "supported"> };
      }
      if (column.problem !== null) return { state: "agentUnavailable" };
      const agent = column.agent;
      const own = itemsByMachine
        .get(column.environmentId)
        ?.get(item.id)
        ?.cells.find((candidate) => candidate.agent === agent);
      if (own !== undefined) return own;
      return notApplicable.has(`${item.id}\n${agent}`)
        ? { state: "notApplicable" }
        : { state: "notInstalled" };
    });
    const real = cells.filter(isSnapshotCell);
    const own = new Map<EnvironmentId, ForkExtensionItem>();
    for (const [environmentId, items] of itemsByMachine) {
      const copy = items.get(item.id);
      if (copy !== undefined) own.set(environmentId, copy);
    }
    return {
      item,
      itemsByMachine: own,
      cells,
      usageTotal: real.reduce((total, cell) => total + cell.usageCount, 0),
      hasProblem: real.some((cell) => cell.state === "needsAttention" || cell.problem !== null),
    };
  });

  rows.sort(
    (left, right) =>
      Number(right.hasProblem) - Number(left.hasProblem) ||
      right.usageTotal - left.usageTotal ||
      left.item.name.localeCompare(right.item.name, undefined, { sensitivity: "base" }) ||
      left.item.id.localeCompare(right.item.id),
  );
  return { columns, rows };
}

export const FORK_AGENT_LABELS: Readonly<Record<ForkExtensionAgent, string>> = {
  claude: "Claude",
  codex: "Codex",
};

export const FORK_KIND_LABELS: Readonly<Record<ForkExtensionKind, string>> = {
  mcp: "MCP",
  plugin: "Plugins",
  skill: "Skills",
};

/** The short kind shown next to a name, as in the mockup: `claude.ai`, `npx`, `http`, a marketplace. */
export function forkSourceTag(item: ForkExtensionItem): string {
  if (item.kind === "plugin") return item.source;
  if (item.kind === "skill") return item.pluginId === null ? "" : "plugin";
  switch (item.transport) {
    case "claudeAi":
      return "claude.ai";
    case "plugin":
      return "plugin";
    case "http":
    case "sse":
      return item.transport;
    case "stdio": {
      const command = item.source.trim().split(/\s+/)[0] ?? "";
      return (
        command
          .split(/[\\/]/)
          .at(-1)
          ?.replace(/\.(exe|cmd|bat)$/i, "") ?? ""
      );
    }
    default:
      return "";
  }
}

const CELL_STATE_LABELS: Readonly<Record<MatrixCell["state"], string>> = {
  working: "Working",
  needsAttention: "Needs attention",
  disabled: "Disabled",
  notInstalled: "Not installed",
  notApplicable: "Not available",
  unknown: "Installed, not checked yet",
  agentUnavailable: "Agent unavailable",
  needsForkUpdate: "Needs a fork update",
  offline: "Offline",
};

export function forkCellStateLabel(cell: MatrixCell): string {
  return CELL_STATE_LABELS[cell.state];
}

export function forkColumnLabel(column: MatrixColumn): string {
  return column.agent === null
    ? column.machineLabel
    : `${column.machineLabel} · ${FORK_AGENT_LABELS[column.agent]}`;
}

/** Where claude.ai connectors are connected; they belong to the account, not to a machine. */
export const CLAUDE_AI_CONNECTORS_URL = "https://claude.ai/settings/connectors";

const readOnlyMachineReason = (column: MatrixColumn) =>
  `You can view extensions on ${column.machineLabel} but not change them.`;

export type ForkCellAction =
  | { readonly kind: "toggle"; readonly agent: ForkExtensionAgent; readonly enabled: boolean }
  | { readonly kind: "install"; readonly agent: ForkExtensionAgent }
  | { readonly kind: "none"; readonly reason: string };

/** What a click on a matrix cell does (spec §6.1); `none` carries the tooltip's reason. */
export function forkCellAction(
  column: MatrixColumn,
  cell: MatrixCell,
  item: ForkExtensionItem,
): ForkCellAction {
  if (column.support === "needsForkUpdate") {
    return {
      kind: "none",
      reason: `${column.machineLabel} needs a fork update to manage extensions.`,
    };
  }
  if (column.support === "offline") {
    return { kind: "none", reason: `${column.machineLabel} is offline.` };
  }
  if (column.agent === null) return { kind: "none", reason: forkCellStateLabel(cell) };
  const agent = FORK_AGENT_LABELS[column.agent];
  if (cell.state === "agentUnavailable") {
    return { kind: "none", reason: column.problem?.summary ?? `${agent} is unavailable.` };
  }
  if (cell.state === "notApplicable") {
    return { kind: "none", reason: `Not available for ${agent}.` };
  }
  if (!column.canOperate) return { kind: "none", reason: readOnlyMachineReason(column) };
  if (cell.state === "notInstalled") return { kind: "install", agent: column.agent };
  if (item.readOnly) {
    return {
      kind: "none",
      reason:
        item.pluginId === null
          ? "This one can't be changed from here."
          : `Comes with the ${item.pluginId} plugin. Turn the plugin on or off instead.`,
    };
  }
  return { kind: "toggle", agent: column.agent, enabled: cell.state === "disabled" };
}

/** "checked 12m ago" reads the oldest check, so it never claims a freshness one machine lacks. */
export function oldestHealthCheck(machines: ReadonlyArray<MachineState>): string | null {
  let oldest: { readonly iso: string; readonly ms: number } | null = null;
  for (const machine of machines) {
    const iso = machine.snapshot?.healthCheckedAt ?? null;
    if (iso === null) continue;
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) continue;
    if (oldest === null || ms < oldest.ms) oldest = { iso, ms };
  }
  return oldest?.iso ?? null;
}

export interface ForkUninstallTarget {
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
  readonly agent: ForkExtensionAgent;
}

/** Every installed copy on a machine that can be changed, in column order. */
export function forkUninstallTargets(
  row: MatrixRow,
  columns: ReadonlyArray<MatrixColumn>,
): ReadonlyArray<ForkUninstallTarget> {
  return columns.flatMap((column, index): ReadonlyArray<ForkUninstallTarget> => {
    const cell = row.cells[index];
    if (column.agent === null || !column.canOperate || cell === undefined) return [];
    if (!isSnapshotCell(cell) || cell.state === "notInstalled" || cell.state === "notApplicable") {
      return [];
    }
    if (row.itemsByMachine.get(column.environmentId)?.readOnly !== false) return [];
    return [
      {
        environmentId: column.environmentId,
        machineLabel: column.machineLabel,
        agent: column.agent,
      },
    ];
  });
}

/** CLI that logs a server in on each agent: Task 10 runs `<cli> mcp login <name>`. */
const AGENT_CLIS: Readonly<Record<ForkExtensionAgent, string>> = {
  claude: "claude",
  codex: "codex",
};

export type ForkAuthorizeAction =
  | { readonly kind: "none" }
  /** claude.ai connectors belong to the account: they are connected on claude.ai (Ruling 19). */
  | { readonly kind: "connector" }
  | { readonly kind: "disabled"; readonly reason: string }
  | { readonly kind: "login"; readonly agent: ForkExtensionAgent };

/** Whether a detail cell offers "Authorize", and what it does (spec §6.7). */
export function forkAuthorizeAction(
  column: MatrixColumn,
  cell: MatrixCell,
  item: ForkExtensionItem | undefined,
): ForkAuthorizeAction {
  if (column.agent === null || item === undefined || item.kind !== "mcp") return { kind: "none" };
  if (!isSnapshotCell(cell) || cell.problem?.reason !== "needsAuthorization") {
    return { kind: "none" };
  }
  if (item.transport === "claudeAi") return { kind: "connector" };
  if (!column.canOperate) return { kind: "disabled", reason: readOnlyMachineReason(column) };
  // The login runs in the user's home, where project and local servers are not visible (Ruling 20).
  if (!cell.scopes.some((scope) => scope === "user" || scope === "plugin")) {
    return {
      kind: "disabled",
      reason: `Authorize it from a terminal in that project (${AGENT_CLIS[column.agent]} mcp login ${item.name}).`,
    };
  }
  return { kind: "login", agent: column.agent };
}

export interface ForkProjectToggleGroup {
  readonly column: MatrixColumn;
  readonly cell: ForkExtensionCell;
  /** Why this machine's switches are off limits; null when they can be used. */
  readonly blockedReason: string | null;
}

/** The detail's "Per project" section: Claude MCP cells that list projects (spec §6.4). */
export function forkProjectToggleGroups(
  row: MatrixRow,
  columns: ReadonlyArray<MatrixColumn>,
): ReadonlyArray<ForkProjectToggleGroup> {
  if (row.item.kind !== "mcp") return [];
  return columns.flatMap((column, index): ReadonlyArray<ForkProjectToggleGroup> => {
    const cell = row.cells[index];
    if (column.agent !== "claude" || cell === undefined || !isSnapshotCell(cell)) return [];
    if (cell.projects.length === 0) return [];
    const item = row.itemsByMachine.get(column.environmentId) ?? row.item;
    const blockedReason = !column.canOperate
      ? readOnlyMachineReason(column)
      : item.readOnly
        ? item.pluginId === null
          ? "This one can't be changed from here."
          : `Comes with the ${item.pluginId} plugin. Turn the plugin on or off instead.`
        : cell.state === "disabled"
          ? "Turned off in every project on this machine. Turn it on first."
          : null;
    return [{ column, cell, blockedReason }];
  });
}
