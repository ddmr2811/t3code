// @effect-diagnostics nodeBuiltinImport:off -- node:sqlite opens aon's own database read-only.
// Fork-only: the events of `aon`, the always-on agent runner on Dani's machines, read from its
// SQLite file without ever writing to it.
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
  /** The payload's first characters only; the feed keeps its first line. */
  readonly payload: string | null;
}

/** Event types aon hands to a project's orchestrator thread. */
const AGENT_TYPES = new Set(["tarea", "github", "t3"]);

/** `DECISIÓN: …`, the prefix aon's orchestrators give what needs Dani. */
const isDecision = (text: string) =>
  /^decision\b/i.test(
    text
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .replace(/^[^\p{L}]+/u, ""),
  );

export function aonEntry(row: AonEventRow, sinceMs: number): ForkActivityEntry | null {
  const at = Date.parse(row.terminado ?? row.creado);
  if (!Number.isFinite(at) || at < sinceMs) return null;
  const line = summaryLine(row.payload ?? "");
  const decision = isDecision(row.tipo) || isDecision(line);
  const status = decision ? "waiting" : (wordStatus(row.estado) ?? "running");
  const named = wordActor(row.fuente);
  const actor =
    named !== "unknown" ? named : AGENT_TYPES.has(row.tipo) ? "orchestrator" : "unknown";
  const project = row.proyecto === null ? "" : summaryLine(row.proyecto, 80);
  const tipo = summaryLine(row.tipo, 40);
  return {
    id: `aon:${row.id}`,
    at: isoAt(at),
    source: "aon",
    ...(project.length > 0 ? { project } : {}),
    actor,
    summary: summaryLine(line.length > 0 ? `${tipo}: ${line}` : `${tipo} (${row.fuente})`),
    status,
  };
}

/** Rows kept per read; the newest by id, so the read stops early on a long table. */
const AON_ROWS = 500;

/**
 * The newest events since `sinceIso`. Rows are walked back from the newest id with a limit, so
 * the read is bounded however long the table gets; a missing file answers nothing.
 */
export const readAonEvents = (databasePath: string, sinceIso: string) =>
  Effect.sync((): ReadonlyArray<AonEventRow> => {
    try {
      const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
      try {
        database.exec("PRAGMA busy_timeout = 200");
        return database
          .prepare(
            `SELECT * FROM (
               SELECT id, fuente, tipo, proyecto, estado, creado, terminado,
                      substr(payload, 1, 1000) AS payload
               FROM eventos ORDER BY id DESC LIMIT ?
             ) WHERE coalesce(terminado, creado) >= ?`,
          )
          .all(AON_ROWS, sinceIso) as unknown as ReadonlyArray<AonEventRow>;
      } finally {
        database.close();
      }
    } catch {
      // No file, another schema or a lock held too long: aon adds nothing this time.
      return [];
    }
  });
