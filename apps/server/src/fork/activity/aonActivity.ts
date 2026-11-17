// @effect-diagnostics nodeBuiltinImport:off -- node:sqlite opens aon's own database read-only.
// Fork-only: the events of `aon`, the always-on agent runner on Dani's machines, read from its
// SQLite file without ever writing to it. Only structured fields leave it: the payload is free
// text, so the read never selects it; one-line summaries belong in the `actividad-*.jsonl` logs.
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

import type { ForkActivityEntry } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { isoAt, wordActor, wordStatus } from "./classify.ts";
import { summaryLine } from "./redact.ts";

export interface AonEventRow {
  readonly id: number;
  readonly fuente: string;
  readonly tipo: string;
  readonly proyecto: string | null;
  readonly estado: string;
  readonly creado: string;
  readonly terminado: string | null;
  /** 1 when the payload starts with `DECISIÓN`, worked out inside SQLite. */
  readonly decision: number;
}

/** Event types aon hands to a project's orchestrator thread. */
const AGENT_TYPES = new Set(["tarea", "github", "t3"]);

const isDecisionType = (tipo: string) =>
  /^decision\b/i.test(
    tipo
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .trim(),
  );

export function aonEntry(row: AonEventRow, sinceMs: number): ForkActivityEntry | null {
  const at = Date.parse(row.terminado ?? row.creado);
  if (!Number.isFinite(at) || at < sinceMs) return null;
  const decision = Number(row.decision) === 1 || isDecisionType(row.tipo);
  const named = wordActor(row.fuente);
  const actor =
    named !== "unknown" ? named : AGENT_TYPES.has(row.tipo) ? "orchestrator" : "unknown";
  const project = row.proyecto === null ? "" : summaryLine(row.proyecto, 80);
  const label = `${summaryLine(row.fuente, 40)} · ${summaryLine(row.tipo, 40)}`;
  return {
    id: `aon:${row.id}`,
    at: isoAt(at),
    source: "aon",
    ...(project.length > 0 ? { project } : {}),
    actor,
    summary: summaryLine(decision ? `${label} · decisión pendiente` : label),
    status: decision ? "waiting" : (wordStatus(row.estado) ?? "running"),
  };
}

/** Rows kept per read; the newest by id, so the read stops early on a long table. */
const AON_ROWS = 500;
/** How long a read waits on a writer's lock before it gives up for this round. */
const BUSY_TIMEOUT_MS = 200;

/**
 * The newest events since `sinceIso`. Rows are walked back from the newest id with a limit, so
 * the read is bounded however long the table gets, and a lock held by a writer makes it give up
 * after 200 ms. A missing file, another schema or a lock answers nothing.
 */
export const readAonEvents = (databasePath: string, sinceIso: string) =>
  Effect.sync((): ReadonlyArray<AonEventRow> => {
    if (!NodeFS.existsSync(databasePath)) return [];
    try {
      // A plain read-only open: SQLite may add `-wal` and `-shm` beside the file, as any reader
      // does, and never writes aon's data. `immutable=1` would be unsafe beside aon's writer.
      const database = new NodeSqlite.DatabaseSync(databasePath, {
        readOnly: true,
        timeout: BUSY_TIMEOUT_MS,
      });
      try {
        return database
          .prepare(
            `SELECT * FROM (
               SELECT id, fuente, tipo, proyecto, estado, creado, terminado,
                      ltrim(coalesce(payload, '')) LIKE 'decisi_n%' AS decision
               FROM eventos ORDER BY id DESC LIMIT ?
             ) WHERE coalesce(terminado, creado) >= ?`,
          )
          .all(AON_ROWS, sinceIso) as unknown as ReadonlyArray<AonEventRow>;
      } finally {
        database.close();
      }
    } catch {
      return [];
    }
  });
