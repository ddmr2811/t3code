// Fork-only: the Dashboard's "What the AI did": one feed from this server's threads, aon's event
// database, the plain activity logs, the `pesado` turns running now and the commits on `dev`.
// Every source is read-only and optional; one that is missing or fails adds nothing.
import type {
  ForkActivityEntry,
  ForkActivityFeed,
  ForkActivityFeedInput,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as SqlClient from "effect/sql/SqlClient";

import { ACTIVITY_LOG_PATTERN, ACTIVITY_LOG_TAIL_BYTES, parseActivityLog } from "./activityLog.ts";
import type * as ProcessRunner from "../../processRunner.ts";
import { aonEntry, readAonEvents } from "./aonActivity.ts";
import { commitEntry, readDevCommits } from "./gitActivity.ts";
import { readPesadoTurns } from "./pesadoActivity.ts";
import { readProjectRoots, readThreadActivity } from "./threadActivity.ts";

export class ForkActivity extends Context.Service<
  ForkActivity,
  {
    /** Never fails: a source that cannot be read adds no entries. */
    readonly feed: (input: ForkActivityFeedInput) => Effect.Effect<ForkActivityFeed>;
  }
>()("t3/fork/activity/ForkActivity") {}

const DEFAULT_SINCE_HOURS = 24;
const DEFAULT_LIMIT = 200;
/** Every open card and page asks every 30 s; devices share one read per input. */
const CACHE_TTL = Duration.seconds(30);
/** A handful of inputs are asked in practice; more than this starts the cache afresh. */
const CACHE_KEYS = 16;
const MAX_LOG_FILES = 20;
const MAX_GIT_PROJECTS = 30;
const GIT_CONCURRENCY = 4;

export interface ActivityPaths {
  /** aon's base folder: `$AON_HOME`, else `~/agentes`. */
  readonly agentsDir: string;
  /** `$PESADO_DIR`, else `/tmp/pesado`. */
  readonly pesadoDir: string;
}

const activityPaths = Effect.gen(function* () {
  const env = yield* HostProcess.Environment;
  const home = yield* HostProcess.HomeDirectory;
  const path = yield* Path.Path;
  const expand = (value: string) =>
    value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : value;
  return {
    agentsDir: expand(env.AON_HOME?.trim() || path.join(home, "agentes")),
    pesadoDir: env.PESADO_DIR?.trim() || "/tmp/pesado",
  } satisfies ActivityPaths;
});

/** Each matching log's tail, newest file name last; files are never read whole. */
const readActivityLogs = Effect.fn("ForkActivity.readActivityLogs")(function* (
  dir: string,
  sinceMs: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
  const logs = names
    .filter((name) => ACTIVITY_LOG_PATTERN.test(name))
    .toSorted()
    .slice(-MAX_LOG_FILES);
  const entries: ForkActivityEntry[] = [];
  for (const name of logs) {
    const tail = yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* fs.open(path.join(dir, name), { flag: "r" });
        const size = Number((yield* file.stat).size);
        const offset = Math.max(0, size - ACTIVITY_LOG_TAIL_BYTES);
        const bytes = yield* file.readAlloc(size - offset, { position: BigInt(offset) });
        return { offset, bytes: Option.getOrElse(bytes, () => new Uint8Array()) };
      }),
    ).pipe(Effect.option);
    if (tail._tag === "None") continue;
    entries.push(...parseActivityLog(name, tail.value.bytes, tail.value.offset, sinceMs));
  }
  return entries;
});

/**
 * The newest `limit` entries from every source, merged and newest first. Ids are unique across
 * sources, and a commit reached through two projects of one repository shows once.
 */
function mergeEntries(
  sources: ReadonlyArray<ReadonlyArray<ForkActivityEntry>>,
  limit: number,
): ReadonlyArray<ForkActivityEntry> {
  const seen = new Set<string>();
  const merged: ForkActivityEntry[] = [];
  for (const entry of sources.flat()) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    merged.push(entry);
  }
  return merged
    .toSorted((a, b) => (a.at === b.at ? a.id.localeCompare(b.id) : a.at < b.at ? 1 : -1))
    .slice(0, limit);
}

/** @public */
export const make = Effect.gen(function* () {
  const paths = yield* activityPaths;
  const path = yield* Path.Path;
  const context = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | SqlClient.SqlClient | ProcessRunner.ProcessRunner
  >();

  const read = Effect.fn("ForkActivity.read")(function* (sinceHours: number, limit: number) {
    const nowMs = yield* Clock.currentTimeMillis;
    const sinceMs = nowMs - sinceHours * 60 * 60_000;
    const sinceIso = DateTime.formatIso(DateTime.makeUnsafe(sinceMs));
    const gitSources = Effect.gen(function* () {
      const projects = yield* readProjectRoots(MAX_GIT_PROJECTS);
      const perProject = yield* Effect.forEach(
        projects,
        (project) =>
          readDevCommits(project.workspaceRoot, sinceIso).pipe(
            Effect.map((commits) => commits.map((commit) => commitEntry(project.title, commit))),
          ),
        { concurrency: GIT_CONCURRENCY },
      );
      return perProject.flat();
    });
    const sources = yield* Effect.all(
      [
        readThreadActivity(sinceIso, limit),
        readAonEvents(path.join(paths.agentsDir, "datos", "aon.db"), sinceIso).pipe(
          Effect.map((rows) =>
            rows.flatMap((row) => {
              const entry = aonEntry(row, sinceMs);
              return entry === null ? [] : [entry];
            }),
          ),
        ),
        readActivityLogs(path.join(paths.agentsDir, "logs"), sinceMs),
        readPesadoTurns(paths.pesadoDir),
        gitSources,
      ],
      { concurrency: "unbounded" },
    );
    return {
      entries: mergeEntries(sources, limit),
      readAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
    } satisfies ForkActivityFeed;
  });

  const cache = new Map<string, Effect.Effect<ForkActivityFeed>>();
  const feed = Effect.fn("ForkActivity.feed")(function* (input: ForkActivityFeedInput) {
    const sinceHours = input.sinceHours ?? DEFAULT_SINCE_HOURS;
    const limit = input.limit ?? DEFAULT_LIMIT;
    const key = `${sinceHours}:${limit}`;
    let cached = cache.get(key);
    if (cached === undefined) {
      if (cache.size >= CACHE_KEYS) cache.clear();
      cached = yield* Effect.cachedWithTTL(
        read(sinceHours, limit).pipe(Effect.provideContext(context)),
        CACHE_TTL,
      );
      cache.set(key, cached);
    }
    return yield* cached;
  });

  return ForkActivity.of({ feed });
});

export const layer = Layer.effect(ForkActivity, make);
