// Fork-only: the plain activity log Dani and the orchestrators append to, one JSON object per
// line: `{ts, proyecto, quien, que, estado}`. Only each file's tail is read.
import type { ForkActivityEntry } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { isoAt, wordActor, wordStatus } from "./classify.ts";
import { summaryLine } from "./redact.ts";
import { readRegularFile } from "./safeRead.ts";

/** Each file is read from this far before its end at most. */
const ACTIVITY_LOG_TAIL_BYTES = 2 * 1024 * 1024;
const ACTIVITY_LOG_PATTERN = /^actividad-[A-Za-z0-9._-]+\.jsonl$/;
const MAX_LOG_FILES = 20;
const FILE_TIMEOUT = Duration.seconds(1);
const SOURCE_TIMEOUT = Duration.seconds(3);

const NEWLINE = 0x0a;

/**
 * The entries in a file's tail that are valid and not older than `sinceMs`. `offset` is where
 * the tail starts in the file; a tail that starts mid-file drops its first, partial line. Each
 * id is the line's byte offset, so it stays the same while the file grows.
 */
export function parseActivityLog(
  file: string,
  tail: Uint8Array,
  offset: number,
  sinceMs: number,
): ReadonlyArray<ForkActivityEntry> {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const entries: ForkActivityEntry[] = [];
  let start = 0;
  if (offset > 0) {
    const first = tail.indexOf(NEWLINE);
    if (first === -1) return [];
    start = first + 1;
  }
  while (start < tail.length) {
    const found = tail.indexOf(NEWLINE, start);
    const end = found === -1 ? tail.length : found;
    // A last line without its newline may still be being written; it counts if it parses.
    const entry = parseLine(decoder.decode(tail.subarray(start, end)), sinceMs);
    if (entry !== null) entries.push({ ...entry, id: `log:${file}:${offset + start}` });
    start = end + 1;
  }
  return entries;
}

type ParsedLine = Omit<ForkActivityEntry, "id">;

function parseLine(line: string, sinceMs: number): ParsedLine | null {
  if (line.trim().length === 0) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const { ts, proyecto, quien, que, estado } = record;
  if (typeof ts !== "string" || typeof que !== "string") return null;
  const atMs = Date.parse(ts);
  if (!Number.isFinite(atMs) || atMs < sinceMs) return null;
  const status = wordStatus(typeof estado === "string" ? estado : null);
  if (status === null) return null;
  const summary = summaryLine(que);
  if (summary.length === 0) return null;
  const project = typeof proyecto === "string" ? summaryLine(proyecto, 80) : "";
  return {
    at: isoAt(atMs),
    source: "log",
    ...(project.length > 0 ? { project } : {}),
    actor: wordActor(typeof quien === "string" ? quien : null),
    summary,
    status,
  };
}

/**
 * The tails of at most 20 logs, the last names in order. Each is a regular file opened through no
 * symlink (a FIFO or device is skipped, never waited on), with a time limit per file and overall.
 */
export const readActivityLogs = Effect.fn("ForkActivity.readActivityLogs")(function* (
  dir: string,
  sinceMs: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const read = Effect.gen(function* () {
    const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
    const logs = names
      .filter((name) => ACTIVITY_LOG_PATTERN.test(name))
      .toSorted()
      .slice(-MAX_LOG_FILES);
    const entries: ForkActivityEntry[] = [];
    for (const name of logs) {
      const tail = yield* readRegularFile(path.join(dir, name), {
        maxBytes: ACTIVITY_LOG_TAIL_BYTES,
        from: "end",
        timeout: FILE_TIMEOUT,
      });
      if (tail === null) continue;
      entries.push(...parseActivityLog(name, tail.bytes, tail.offset, sinceMs));
    }
    return entries;
  });
  return yield* read.pipe(
    Effect.timeoutOption(SOURCE_TIMEOUT),
    Effect.map(Option.getOrElse((): ReadonlyArray<ForkActivityEntry> => [])),
  );
});
