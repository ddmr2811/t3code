// Fork-only: the heavy jobs running now under `pesado`, the machine-wide queue for test batteries
// and builds. Each turn leaves `slot<N>.who` behind; only a live process counts.
import type { ForkActivityEntry } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
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

/** Programs whose name may show; anything else is a heavy job with no name. */
const PROGRAMS = new Set([
  "vp",
  "pnpm",
  "npm",
  "npx",
  "bun",
  "node",
  "cargo",
  "rustc",
  "pytest",
  "python",
  "python3",
  "uv",
  "vitest",
  "playwright",
  "knip",
  "tsc",
  "make",
  "docker",
  "git",
]);
/** The one subcommand that may follow a shown program. */
const SUBCOMMANDS = new Set([
  "run",
  "test",
  "build",
  "check",
  "lint",
  "typecheck",
  "i",
  "install",
  "exec",
  "x",
  "clippy",
  "fmt",
  "bench",
  "ci",
]);

/** The program word and the words after it, past `env` and `VAR=…` assignments. */
function programWords(command: string): ReadonlyArray<string> {
  const words = command.trim().split(/\s+/);
  let at = 0;
  while (
    at < words.length &&
    (words[at] === "env" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at]!))
  ) {
    at += 1;
  }
  return words.slice(at);
}

const STANDARD_DIRS = (home: string) => [
  "/usr/bin",
  "/usr/local/bin",
  "/bin",
  `${home}/.local/bin`,
  "~/.local/bin",
];

/**
 * What a turn's command may show, from closed lists only: a known program, named bare or from a
 * standard bin folder, and one known subcommand. Script names, paths and every other argument
 * stay on the machine: `vp run check:changed` reads `vp run`, `tool login alice` reads nothing.
 */
export function commandSummary(command: string, home: string): string | null {
  const [token = "", next] = programWords(command);
  const slash = token.lastIndexOf("/");
  const program = token.slice(slash + 1);
  if (slash !== -1 && !STANDARD_DIRS(home).includes(token.slice(0, slash))) return null;
  if (!PROGRAMS.has(program)) return null;
  return next !== undefined && SUBCOMMANDS.has(next) ? `${program} ${next}` : program;
}

/**
 * A pid that a later process reused is not the turn: `pesado` execs the command, so the live
 * process's command line holds the program's name. This check stays on the server.
 */
export const commandMatches = (cmdline: string, command: string): boolean => {
  const program = programWords(command)[0]?.split("/").at(-1) ?? "";
  return program.length > 0 && cmdline.replaceAll("\0", " ").includes(program);
};

export function pesadoEntry(slot: string, turn: PesadoTurn, home: string): ForkActivityEntry {
  const command = commandSummary(turn.command, home);
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
  const home = yield* HostProcess.HomeDirectory;
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
      entries.push(pesadoEntry(name.replace(/\.who$/, ""), turn, home));
    }
    return entries;
  });
  return yield* read.pipe(
    Effect.timeoutOption(SOURCE_TIMEOUT),
    Effect.map(Option.getOrElse((): ReadonlyArray<ForkActivityEntry> => [])),
  );
});
