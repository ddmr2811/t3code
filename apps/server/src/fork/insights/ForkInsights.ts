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
const DAY_MS = 24 * 60 * 60_000;
/** Turns change slowly next to a few months of days; every open chart shares one count. */
const ACTIVITY_CACHE_MS = 5 * 60_000;

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

/** The first instant of the oldest day asked for, at the client's offset. */
export function activitySince(nowMs: number, input: ForkActivityInput): string {
  const offsetMs = input.utcOffsetMinutes * 60_000;
  const todayStart = Math.floor((nowMs + offsetMs) / DAY_MS) * DAY_MS - offsetMs;
  return DateTime.formatIso(DateTime.makeUnsafe(todayStart - (input.days - 1) * DAY_MS));
}

const offsetModifier = (minutes: number) =>
  `${minutes >= 0 ? "+" : "-"}${Math.abs(minutes)} minutes`;

/** Turns started per day, read once per few minutes for every chart that asks. */
export const makeActivityReader = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const cache = new Map<string, { readonly atMs: number; readonly value: ForkActivity }>();
  const activity = Effect.fn("ForkInsights.activity")(function* (input: ForkActivityInput) {
    const key = `${input.days}:${input.utcOffsetMinutes}`;
    const nowMs = yield* Clock.currentTimeMillis;
    const cached = cache.get(key);
    if (cached !== undefined && nowMs - cached.atMs < ACTIVITY_CACHE_MS) return cached.value;
    const rows = yield* sql<{ readonly day: string; readonly turns: number }>`
      SELECT strftime('%Y-%m-%d', requested_at, ${offsetModifier(input.utcOffsetMinutes)}) AS day,
        COUNT(*) AS turns
      FROM orchestration_v2_projection_runs
      WHERE requested_at >= ${activitySince(nowMs, input)}
      GROUP BY day
      ORDER BY day
    `.pipe(Effect.option);
    const readAt = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
    if (rows._tag === "None") return { days: [], readAt };
    const value: ForkActivity = {
      days: rows.value.flatMap((row) =>
        typeof row.day === "string" ? [{ day: row.day, turns: Number(row.turns) }] : [],
      ),
      readAt,
    };
    cache.set(key, { atMs: nowMs, value });
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
