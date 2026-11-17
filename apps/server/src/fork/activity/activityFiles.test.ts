// @effect-diagnostics nodeBuiltinImport:off -- the fixtures need symlinks, FIFOs and a live SQLite writer.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { readActivityLogs } from "./activityLog.ts";
import { aonEntry, readAonEvents } from "./aonActivity.ts";
import { readPesadoTurns } from "./pesadoActivity.ts";

const SINCE_MS = Date.parse("2026-11-16T00:00:00Z");
const line = (que: string) =>
  `${JSON.stringify({ ts: "2026-11-17T04:00:00Z", proyecto: "Atlas", quien: "worker", que, estado: "ok" })}\n`;

/** False when the platform has no `mkfifo`. */
const makeFifo = (path: string) => {
  try {
    NodeChildProcess.execFileSync("mkfifo", [path], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

const tempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "t3-fork-activity-" });
});

describe("readActivityLogs", () => {
  it.effect("reads regular logs and ignores a symlink and a FIFO without waiting on it", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const dir = yield* tempDir;
      const outside = path.join(dir, "outside.jsonl");
      NodeFS.writeFileSync(outside, line("read through a link"));
      NodeFS.writeFileSync(path.join(dir, "actividad-a.jsonl"), line("regular"));
      NodeFS.symlinkSync(outside, path.join(dir, "actividad-b.jsonl"));
      const fifo = makeFifo(path.join(dir, "actividad-c.jsonl"));

      const entries = yield* readActivityLogs(dir, SINCE_MS);
      expect(entries.map((entry) => entry.summary)).toEqual(["regular"]);
      expect(fifo).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("readPesadoTurns", () => {
  it.effect("reads only regular slot files, never through a link or a FIFO", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const dir = yield* tempDir;
      // The test runner itself is a live pid whose command line holds `node`.
      const who = `2026-11-17T05:00:00+00:00 pid ${process.pid} node --secret=hunter2 x\n`;
      NodeFS.writeFileSync(path.join(dir, "elsewhere.who"), who);
      NodeFS.symlinkSync(path.join(dir, "elsewhere.who"), path.join(dir, "slot1.who"));
      makeFifo(path.join(dir, "slot2.who"));
      expect(yield* readPesadoTurns(dir)).toEqual([]);

      NodeFS.writeFileSync(path.join(dir, "slot3.who"), who);
      const entries = yield* readPesadoTurns(dir);
      expect(entries.map((entry) => [entry.id.split(":")[1], entry.summary])).toEqual([
        ["slot3", "Heavy job: node"],
      ]);
      expect(JSON.stringify(entries)).not.toContain("hunter2");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

const PAYLOAD_MARKS = ["§", "¶", "Ж", "Я", "zqxj", "¿"];

const createAon = (file: string) => {
  const database = new NodeSqlite.DatabaseSync(file);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec(`CREATE TABLE eventos(
    id INTEGER PRIMARY KEY, fuente TEXT NOT NULL, ext_id TEXT NOT NULL, inbox TEXT NOT NULL,
    tipo TEXT NOT NULL, proyecto TEXT, payload TEXT, estado TEXT NOT NULL DEFAULT 'pendiente',
    intentos INTEGER NOT NULL DEFAULT 0, creado TEXT NOT NULL, empezado TEXT, terminado TEXT,
    error TEXT, UNIQUE(fuente, ext_id))`);
  const insert = database.prepare(
    "INSERT INTO eventos(fuente, ext_id, inbox, tipo, proyecto, payload, estado, creado, terminado) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  insert.run(
    "dev-box",
    "1",
    "general",
    "eco",
    "Lumen",
    "  DECISIÓN: ¿§¶ЖЯ publico zqxj?",
    "hecho",
    "2026-11-17T04:00:00+00:00",
    "2026-11-17T04:00:05+00:00",
  );
  insert.run(
    "github",
    "2",
    "atlas",
    "github",
    "Atlas",
    "PR §¶ zqxj ghp_abcdefghijklmnopqrst\nЖЯ",
    "fallido",
    "2026-11-17T04:10:00+00:00",
    null,
  );
  return database;
};

describe("readAonEvents", () => {
  it.effect("builds entries from structured fields only, never the payload", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const file = path.join(yield* tempDir, "aon.db");
      createAon(file).close();

      const rows = yield* readAonEvents(file, "2026-11-16T00:00:00.000Z");
      expect(Object.keys(rows[0]!)).not.toContain("payload");
      const entries = rows.flatMap((row) => aonEntry(row, SINCE_MS) ?? []);
      expect(entries.map((entry) => [entry.summary, entry.status])).toEqual([
        ["github · github", "error"],
        ["dev-box · eco · decisión pendiente", "waiting"],
      ]);
      const wire = JSON.stringify(entries);
      for (const mark of [...PAYLOAD_MARKS, "ghp_", "PR", "publico"]) {
        expect(wire).not.toContain(mark);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("creates no -wal or -shm, and reads a live writer's newest rows", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const dir = yield* tempDir;
      const file = path.join(dir, "aon.db");
      createAon(file).close();
      const files = () => NodeFS.readdirSync(dir).toSorted();
      expect(files()).toEqual(["aon.db"]);

      expect(yield* readAonEvents(file, "2026-11-16T00:00:00.000Z")).toHaveLength(2);
      expect(files()).toEqual(["aon.db"]);

      const writer = new NodeSqlite.DatabaseSync(file);
      writer.exec(
        "INSERT INTO eventos(fuente, ext_id, inbox, tipo, estado, creado) VALUES ('timer', '3', 'x', 'tests', 'pendiente', '2026-11-17T05:00:00+00:00')",
      );
      const withWriter = files();
      expect(withWriter).toEqual(["aon.db", "aon.db-shm", "aon.db-wal"]);
      expect(yield* readAonEvents(file, "2026-11-16T00:00:00.000Z")).toHaveLength(3);
      expect(files()).toEqual(withWriter);
      writer.close();

      expect(
        yield* readAonEvents(path.join(dir, "missing.db"), "2026-11-16T00:00:00.000Z"),
      ).toEqual([]);
      expect(files()).toEqual(["aon.db"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // A held lock either makes the read give up after its busy timeout or, with no side files,
  // the immutable read skips locks; neither waits on the writer nor sees its open transaction.
  it.effect("never waits on or reads through a writer's exclusive transaction", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const file = path.join(yield* tempDir, "aon.db");
      createAon(file).close();
      const writer = new NodeSqlite.DatabaseSync(file);
      writer.exec("PRAGMA locking_mode = EXCLUSIVE");
      writer.exec("BEGIN EXCLUSIVE");
      writer.exec(
        "INSERT INTO eventos(fuente, ext_id, inbox, tipo, estado, creado) VALUES ('timer', '4', 'x', 'tests', 'pendiente', '2026-11-17T05:00:00+00:00')",
      );
      const rows = yield* readAonEvents(file, "2026-11-16T00:00:00.000Z");
      expect(rows.some((row) => row.id === 3)).toBe(false);
      writer.exec("ROLLBACK");
      writer.close();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
