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

export type MachineSupport = "supported" | "needsForkUpdate" | "offline" | "noPermission";

export interface MachineState {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** While `isPending`, a value other than "supported" is provisional (still connecting or loading permissions). */
  readonly support: MachineSupport;
  /** The latest health check run from this page is already laid over it. */
  readonly snapshot: ForkExtensionsSnapshot | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly isCheckingHealth: boolean;
  readonly healthError: string | null;
}

export function classifyMachineSupport(input: {
  readonly connectionPhase: EnvironmentConnectionPhase;
  readonly hasServerConfig: boolean;
  readonly forkExtensionsVersion: number | undefined;
  readonly operateAccess: "granted" | "denied" | "pending";
}): { readonly support: MachineSupport; readonly isPending: boolean } {
  // An incompatible host is what an old build looks like from here.
  if (input.connectionPhase === "unsupported")
    return { support: "needsForkUpdate", isPending: false };
  if (input.connectionPhase !== "connected") {
    const connecting =
      input.connectionPhase === "connecting" || input.connectionPhase === "reconnecting";
    return { support: "offline", isPending: connecting };
  }
  if (!input.hasServerConfig) return { support: "offline", isPending: true };
  // Spec §6.5: absent on upstream T3 Code and on fork builds from before Extensions.
  if (input.forkExtensionsVersion === undefined || input.forkExtensionsVersion < 1) {
    return { support: "needsForkUpdate", isPending: false };
  }
  if (input.operateAccess !== "granted") {
    return { support: "noPermission", isPending: input.operateAccess === "pending" };
  }
  return { support: "supported", isPending: false };
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
  const base = { environmentId: machine.environmentId, machineLabel: machine.label };
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
    return {
      item,
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
