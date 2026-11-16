import { describe, expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { activitySince, makeActivityReader, makeLimitSampler } from "./ForkInsights.ts";
import {
  EMPTY_LIMIT_HISTORY,
  LIMIT_HISTORY_RETENTION_MS,
  LIMIT_SAMPLE_INTERVAL_MS,
  type LimitSample,
  type StoredLimitHistory,
} from "./limitHistory.ts";

const reading = (usedPercent: number): ReadonlyArray<LimitSample> => [
  {
    key: "native:codex",
    driver: "codex",
    email: "dev@example.com",
    credentialFingerprint: null,
    workspaceId: null,
    windows: [{ id: "secondary", kind: "weekly", label: "Weekly", usedPercent }],
  },
];

describe("makeLimitSampler", () => {
  it.effect("samples on start and every interval, saving each round", () =>
    Effect.gen(function* () {
      const used = yield* Ref.make(10);
      const saved = yield* Ref.make<ReadonlyArray<StoredLimitHistory>>([]);
      const sampler = yield* makeLimitSampler({
        readSamples: () => Ref.get(used).pipe(Effect.map(reading)),
        load: Effect.succeed(EMPTY_LIMIT_HISTORY),
        save: (history) => Ref.update(saved, (all) => [...all, history]),
      });
      yield* TestClock.adjust(0);
      yield* Ref.set(used, 20);
      yield* TestClock.adjust(LIMIT_SAMPLE_INTERVAL_MS);
      yield* Ref.set(used, 30);
      yield* TestClock.adjust(LIMIT_SAMPLE_INTERVAL_MS);

      const history = yield* sampler.read(24);
      expect(history.collectingSince).toBe(0);
      expect(history.series[0]!.windows[0]!.points).toEqual([
        [0, 10],
        [LIMIT_SAMPLE_INTERVAL_MS, 20],
        [2 * LIMIT_SAMPLE_INTERVAL_MS, 30],
      ]);
      expect(yield* Ref.get(saved)).toHaveLength(3);
    }).pipe(Effect.scoped),
  );

  it.effect("writes nothing while no account reports limits", () =>
    Effect.gen(function* () {
      const saves = yield* Ref.make(0);
      const sampler = yield* makeLimitSampler({
        readSamples: () => Effect.succeed([]),
        load: Effect.succeed(EMPTY_LIMIT_HISTORY),
        save: () => Ref.update(saves, (count) => count + 1),
      });
      yield* TestClock.adjust(3 * LIMIT_SAMPLE_INTERVAL_MS);
      expect(yield* Ref.get(saves)).toBe(0);
      expect((yield* sampler.read(24)).collectingSince).toBeNull();
    }).pipe(Effect.scoped),
  );

  it.effect("holds a week: a server running for longer keeps only the last seven days", () =>
    Effect.gen(function* () {
      let last: StoredLimitHistory = EMPTY_LIMIT_HISTORY;
      const sampler = yield* makeLimitSampler({
        // Alternating readings, so no flat stretch folds the count.
        readSamples: (nowMs) => Effect.succeed(reading((nowMs / LIMIT_SAMPLE_INTERVAL_MS) % 2)),
        load: Effect.succeed(EMPTY_LIMIT_HISTORY),
        save: (history) =>
          Effect.sync(() => {
            last = history;
          }),
      });
      yield* TestClock.adjust(LIMIT_HISTORY_RETENTION_MS + 6 * 60 * 60_000);
      const points = last.series[0]!.windows[0]!.points;
      expect(points.length).toBe(LIMIT_HISTORY_RETENTION_MS / LIMIT_SAMPLE_INTERVAL_MS + 1);
      expect(points[0]![0]).toBe(6 * 60 * 60_000);
      expect((yield* sampler.read(24)).series[0]!.windows[0]!.points.length).toBe(24 * 12 + 2);
    }).pipe(Effect.scoped),
  );
});

describe("activitySince", () => {
  it("starts at the client's midnight, the given number of days back", () => {
    const now = Date.parse("2026-11-16T23:30:00.000Z");
    expect(activitySince(now, { days: 1, utcOffsetMinutes: 0 })).toBe("2026-11-16T00:00:00.000Z");
    // 00:30 on the 17th in UTC+1: that day began at 23:00 UTC on the 16th.
    expect(activitySince(now, { days: 2, utcOffsetMinutes: 60 })).toBe("2026-11-15T23:00:00.000Z");
    expect(activitySince(now, { days: 1, utcOffsetMinutes: -300 })).toBe(
      "2026-11-16T05:00:00.000Z",
    );
  });
});

describe("makeActivityReader", () => {
  it.effect("counts turns per day at the client's offset, from the asked days only", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE orchestration_v2_projection_runs (run_id TEXT, requested_at TEXT)`;
      const insert = (id: string, at: string) =>
        sql`INSERT INTO orchestration_v2_projection_runs VALUES (${id}, ${at})`;
      yield* insert("old", "2026-10-01T10:00:00.000Z");
      yield* insert("a", "2026-11-15T10:00:00.000Z");
      yield* insert("b", "2026-11-15T23:30:00.000Z");
      yield* insert("c", "2026-11-16T09:00:00.000Z");
      yield* TestClock.setTime(Date.parse("2026-11-16T12:00:00.000Z"));
      const activity = yield* makeActivityReader;

      expect((yield* activity({ days: 7, utcOffsetMinutes: 0 })).days).toEqual([
        { day: "2026-11-15", turns: 2 },
        { day: "2026-11-16", turns: 1 },
      ]);
      // In UTC+1 the late turn belongs to the 16th.
      expect((yield* activity({ days: 7, utcOffsetMinutes: 60 })).days).toEqual([
        { day: "2026-11-15", turns: 1 },
        { day: "2026-11-16", turns: 2 },
      ]);

      // Answers come from the cache until it expires.
      yield* insert("d", "2026-11-16T11:00:00.000Z");
      expect((yield* activity({ days: 7, utcOffsetMinutes: 0 })).days.at(-1)!.turns).toBe(1);
      yield* TestClock.adjust("5 minutes");
      expect((yield* activity({ days: 7, utcOffsetMinutes: 0 })).days.at(-1)!.turns).toBe(2);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("answers no days when the count fails, and tries again next time", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const activity = yield* makeActivityReader;
      expect((yield* activity({ days: 7, utcOffsetMinutes: 0 })).days).toEqual([]);
      yield* sql`CREATE TABLE orchestration_v2_projection_runs (run_id TEXT, requested_at TEXT)`;
      yield* sql`INSERT INTO orchestration_v2_projection_runs VALUES ('a', '1970-01-01T00:00:00.000Z')`;
      expect((yield* activity({ days: 7, utcOffsetMinutes: 0 })).days).toEqual([
        { day: "1970-01-01", turns: 1 },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
