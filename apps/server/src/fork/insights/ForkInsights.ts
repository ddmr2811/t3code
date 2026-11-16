// Fork-only: what the charts read that the server does not already keep: a sample of every
// subscription limit every few minutes, saved to a small file in the state folder, and the turns
// started per day, counted in SQL and cached.
import type {
  ForkActivity,
  ForkActivityInput,
  ForkLimitHistory,
  ForkLimitHistoryInput,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import * as ServerConfig from "../../config.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import { forkParked } from "../../serverActivation.ts";
import * as UsageLimitSources from "../../usage/UsageLimitSources.ts";
import {
  appendLimitSamples,
  EMPTY_LIMIT_HISTORY,
  LIMIT_SAMPLE_INTERVAL_MS,
  type LimitSample,
  limitHistorySince,
  limitSamples,
  StoredLimitHistory,
} from "./limitHistory.ts";

export class ForkInsights extends Context.Service<
  ForkInsights,
  {
    readonly limitHistory: (input: ForkLimitHistoryInput) => Effect.Effect<ForkLimitHistory>;
    /** Never fails: a failed count answers no days and is not cached. */
    readonly activity: (input: ForkActivityInput) => Effect.Effect<ForkActivity>;
  }
>()("t3/fork/insights/ForkInsights") {}

const HISTORY_FILE = "fork-limit-history.json";
/** Turns change slowly next to months of days; every open chart shares one count. */
const ACTIVITY_CACHE_MS = 30 * 60_000;

const decodeHistory = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredLimitHistory));

/**
 * Samples on start and then every few minutes, for as long as the scope lives. A save that fails
 * is logged and the history stays in memory, so the next one tries again.
 */
export const makeLimitSampler = Effect.fn("ForkInsights.makeLimitSampler")(function* <R>(deps: {
  readonly readSamples: (nowMs: number) => Effect.Effect<ReadonlyArray<LimitSample>, never, R>;
  readonly load: Effect.Effect<StoredLimitHistory>;
  readonly save: (history: StoredLimitHistory) => Effect.Effect<void, never, R>;
}): Effect.fn.Return<
  {
    readonly sampleOnce: Effect.Effect<void, never, R>;
    readonly read: (hours: number) => Effect.Effect<ForkLimitHistory>;
  },
  never,
  Scope.Scope | R
> {
  const history = yield* Ref.make(yield* deps.load);
  const sampleOnce = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const samples = yield* deps.readSamples(nowMs);
    const previous = yield* Ref.get(history);
    if (samples.length === 0 && previous.series.length === 0) return;
    const next = appendLimitSamples(previous, samples, nowMs);
    yield* Ref.set(history, next);
    yield* deps.save(next);
  });
  yield* forkParked(sampleOnce.pipe(Effect.repeat(Schedule.spaced(LIMIT_SAMPLE_INTERVAL_MS))));
  const read = Effect.fn("ForkInsights.readLimitHistory")(function* (hours: number) {
    const nowMs = yield* Clock.currentTimeMillis;
    return limitHistorySince(yield* Ref.get(history), nowMs - hours * 60 * 60_000);
  });
  return { sampleOnce, read };
});

const HOUR_MS = 60 * 60_000;

/** The UTC hours asked for: `days` of them back from the current hour, inclusive. */
export function activityRange(
  nowMs: number,
  input: ForkActivityInput,
): { readonly since: string; readonly until: string } {
  const hourStart = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  return {
    since: DateTime.formatIso(DateTime.makeUnsafe(hourStart - (input.days * 24 - 1) * HOUR_MS)),
    until: DateTime.formatIso(DateTime.makeUnsafe(hourStart + HOUR_MS)),
  };
}

/**
 * Turns started per UTC hour, counted on a read-only connection and kept a while for every chart
 * that asks. The count scans runs in the range; the upstream table has no index on the time.
 */
export const makeActivityReader = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const cache = new Map<number, { readonly atMs: number; readonly value: ForkActivity }>();
  const activity = Effect.fn("ForkInsights.activity")(function* (input: ForkActivityInput) {
    const nowMs = yield* Clock.currentTimeMillis;
    const cached = cache.get(input.days);
    if (cached !== undefined && nowMs - cached.atMs < ACTIVITY_CACHE_MS) return cached.value;
    const range = activityRange(nowMs, input);
    const rows = yield* sql<{ readonly hour: string; readonly turns: number }>`
      SELECT substr(requested_at, 1, 13) AS hour, COUNT(*) AS turns
      FROM orchestration_v2_projection_runs
      WHERE requested_at >= ${range.since} AND requested_at < ${range.until}
      GROUP BY hour
      ORDER BY hour
    `.pipe(NodeSqliteClient.readOnly, Effect.option);
    const readAt = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
    if (rows._tag === "None") return { hours: [], readAt };
    const value: ForkActivity = {
      hours: rows.value.flatMap((row) =>
        typeof row.hour === "string" && row.hour.length === 13
          ? [{ hour: row.hour, turns: Number(row.turns) }]
          : [],
      ),
      readAt,
    };
    cache.set(input.days, { atMs: nowMs, value });
    return value;
  });
  return activity;
});

/** @public */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const limitSources = yield* UsageLimitSources.UsageLimitSources;
  const filePath = path.join(config.stateDir, HISTORY_FILE);

  const load = fs.readFileString(filePath).pipe(
    Effect.flatMap(decodeHistory),
    Effect.catchCause((cause) =>
      fs.exists(filePath).pipe(
        Effect.orElseSucceed(() => false),
        Effect.tap((exists) =>
          exists
            ? Effect.logWarning("fork limit history could not be read; starting afresh", { cause })
            : Effect.void,
        ),
        Effect.as(EMPTY_LIMIT_HISTORY),
      ),
    ),
  );
  const save = (history: StoredLimitHistory) =>
    writeFileStringAtomically({ filePath, contents: JSON.stringify(history) }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("fork limit history could not be saved", { cause }),
      ),
    );
  const sampler = yield* makeLimitSampler({
    readSamples: (nowMs) =>
      Effect.all([providers.getProviders, limitSources.current]).pipe(
        Effect.map(([current, sources]) => limitSamples(current, sources, nowMs)),
      ),
    load,
    save,
  });

  const activity = yield* makeActivityReader;

  return ForkInsights.of({
    limitHistory: Effect.fn("ForkInsights.limitHistory")(function* (input) {
      return yield* sampler.read(input.hours);
    }),
    activity,
  });
});

export const layer = Layer.effect(ForkInsights, make);
