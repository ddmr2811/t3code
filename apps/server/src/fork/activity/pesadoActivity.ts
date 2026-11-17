// Fork-only: the heavy jobs running now under `pesado`, the machine-wide queue for test batteries
// and builds. Each turn leaves `slot<N>.who` behind; only a live process counts.
import type { ForkActivityEntry } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { isoAt } from "./classify.ts";
import { summaryLine } from "./redact.ts";
import { readRegularFile } from "./safeRead.ts";

export interface PesadoTurn {
  readonly at: string;
  readonly pid: number;
  readonly command: string;
}

/** `<ISO date> pid <pid> <command>`, as `pesado` writes it. */
export function parsePesadoWho(text: string): PesadoTurn | null {
  const match = /^(\S+) pid (\d+) (.+)$/.exec(text.split("\n")[0]?.trim() ?? "");
  if (match === null) return null;
  const atMs = Date.parse(match[1]!);
  const pid = Number(match[2]);
  if (!Number.isFinite(atMs) || !Number.isSafeInteger(pid) || pid <= 1) return null;
  return { at: isoAt(atMs), pid, command: match[3]!.trim() };
}

const SAFE_WORD = /^[A-Za-z][A-Za-z0-9._-]*$/;
const MAX_SUBCOMMANDS = 3;

/** A word that can only be a subcommand: no flag, value, address, path or long blob. */
const isSafeWord = (word: string) =>
  !word.startsWith("-") && !/[=@:/]/.test(word) && word.length <= 32 && SAFE_WORD.test(word);

/**
 * What a turn's command may show: the program's base name, past `env` and `VAR=…` assignments,
 * and up to three subcommands, stopping at the first word that could carry a value. Free
 * arguments never leave the machine: `vp run check:changed` reads `vp run`.
 */
export function commandSummary(command: string): string | null {
  const words = command.trim().split(/\s+/);
  let at = 0;
  while (
    at < words.length &&
    (words[at] === "env" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at]!))
  ) {
    at += 1;
  }
  const program = words[at]?.split("/").at(-1) ?? "";
  if (!isSafeWord(program)) return null;
  const subcommands: string[] = [];
  for (const word of words.slice(at + 1)) {
    if (subcommands.length === MAX_SUBCOMMANDS || !isSafeWord(word)) break;
    subcommands.push(word);
  }
  return [program, ...subcommands].join(" ");
}

/**
 * A pid that a later process reused is not the turn: `pesado` execs the command, so the live
 * process's command line holds the program's name.
 */
export const commandMatches = (cmdline: string, command: string): boolean => {
  const program = commandSummary(command)?.split(" ")[0] ?? "";
  return program.length > 0 && cmdline.replaceAll("\0", " ").includes(program);
};

export function pesadoEntry(slot: string, turn: PesadoTurn): ForkActivityEntry {
  const command = commandSummary(turn.command);
  return {
    id: `pesado:${slot}:${turn.pid}:${turn.at}`,
    at: turn.at,
    source: "pesado",
    // The turn file names no one; most are workers, but Dani and timers queue here too.
    actor: "unknown",
    summary: summaryLine(command === null ? "Heavy job" : `Heavy job: ${command}`),
    status: "running",
  };
}

const MAX_SLOTS = 16;
const WHO_MAX_BYTES = 4 * 1024;
const READ_TIMEOUT = Duration.millis(500);
const SOURCE_TIMEOUT = Duration.seconds(2);

const slotNumber = (name: string) => Number(/^slot(\d+)\.who$/.exec(name)?.[1] ?? Number.NaN);

/**
 * Only on Linux, where `/proc` tells whether the pid is still that turn. At most 16 slots, each a
 * regular file read through no symlink and only its first 4 KB, the whole read time-limited.
 */
export const readPesadoTurns = Effect.fn("ForkActivity.readPesadoTurns")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const read = Effect.gen(function* () {
    const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
    const slots = names
      .filter((name) => Number.isSafeInteger(slotNumber(name)))
      .toSorted((a, b) => slotNumber(a) - slotNumber(b))
      .slice(0, MAX_SLOTS);
    const entries: ForkActivityEntry[] = [];
    for (const name of slots) {
      const slice = yield* readRegularFile(path.join(dir, name), {
        maxBytes: WHO_MAX_BYTES,
        from: "start",
        timeout: READ_TIMEOUT,
      });
      if (slice === null) continue;
      const turn = parsePesadoWho(new TextDecoder().decode(slice.bytes));
      if (turn === null) continue;
      // `/proc` files report no size, so they are read whole; the pid is a checked integer.
      const cmdline = yield* fs.readFileString(`/proc/${turn.pid}/cmdline`).pipe(
        Effect.timeoutOption(READ_TIMEOUT),
        Effect.map(Option.getOrNull),
        Effect.orElseSucceed(() => null),
      );
      if (cmdline === null || !commandMatches(cmdline, turn.command)) continue;
      entries.push(pesadoEntry(name.replace(/\.who$/, ""), turn));
    }
    return entries;
  });
  return yield* read.pipe(
    Effect.timeoutOption(SOURCE_TIMEOUT),
    Effect.map(Option.getOrElse((): ReadonlyArray<ForkActivityEntry> => [])),
  );
});
