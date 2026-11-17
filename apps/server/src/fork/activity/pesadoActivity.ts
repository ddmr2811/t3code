// Fork-only: the heavy jobs running now under `pesado`, the machine-wide queue for test batteries
// and builds. Each turn leaves `slot<N>.who` behind; only a live process counts.
import type { ForkActivityEntry } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { isoAt } from "./classify.ts";
import { summaryLine } from "./redact.ts";

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

/**
 * A pid that a later process reused is not the turn: `pesado` execs the command, so the live
 * process's command line holds the command's first word.
 */
export const commandMatches = (cmdline: string, command: string): boolean => {
  const first = command.split(/\s+/)[0] ?? "";
  return first.length > 0 && cmdline.replaceAll("\0", " ").includes(first);
};

function pesadoEntry(slot: string, turn: PesadoTurn): ForkActivityEntry {
  return {
    id: `pesado:${slot}:${turn.pid}:${turn.at}`,
    at: turn.at,
    source: "pesado",
    // The turn file names no one; most are workers, but Dani and timers queue here too.
    actor: "unknown",
    summary: summaryLine(`Heavy job: ${turn.command}`),
    status: "running",
  };
}

/** Only on Linux, where `/proc` tells whether the pid is still that turn. */
export const readPesadoTurns = Effect.fn("ForkActivity.readPesadoTurns")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
  const slots = names.filter((name) => /^slot\d+\.who$/.test(name)).toSorted();
  const entries: ForkActivityEntry[] = [];
  for (const name of slots) {
    const text = yield* fs
      .readFileString(path.join(dir, name))
      .pipe(Effect.orElseSucceed(() => ""));
    const turn = parsePesadoWho(text);
    if (turn === null) continue;
    const cmdline = yield* fs
      .readFileString(`/proc/${turn.pid}/cmdline`)
      .pipe(Effect.orElseSucceed(() => null));
    if (cmdline === null || !commandMatches(cmdline, turn.command)) continue;
    entries.push(pesadoEntry(name.replace(/\.who$/, ""), turn));
  }
  return entries;
});
