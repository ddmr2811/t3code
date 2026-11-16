// Fork-only: the charts under a new thread and on the Dashboard: how much of each subscription
// limit was left over time, which the server samples itself, and the turns started per day.
import * as Schema from "effect/Schema";

export const FORK_INSIGHTS_PROTOCOL_VERSION = 1;

/** `[sampled at, epoch ms; used percent, 0 to 100]`. */
export const ForkLimitHistoryPoint = Schema.Tuple([Schema.Number, Schema.Number]);
export type ForkLimitHistoryPoint = typeof ForkLimitHistoryPoint.Type;

export const ForkLimitHistoryWindow = Schema.Struct({
  id: Schema.String,
  /** `session`, `weekly`, `monthly` or `other`, as the provider reports it. */
  kind: Schema.String,
  label: Schema.String,
  /** Oldest first. A flat stretch keeps only its first and last sample. */
  points: Schema.Array(ForkLimitHistoryPoint),
});
export type ForkLimitHistoryWindow = typeof ForkLimitHistoryWindow.Type;

/** One account's limits as one server reads them: a provider instance or a hub account. */
export const ForkLimitHistorySeries = Schema.Struct({
  /**
   * Local to the server: the instance or hub account plus the login, so signing in as someone
   * else starts a new series.
   */
  key: Schema.String,
  driver: Schema.String,
  email: Schema.NullOr(Schema.String),
  credentialFingerprint: Schema.NullOr(Schema.String),
  workspaceId: Schema.NullOr(Schema.String),
  /** The provider instance, for a login that reports no e-mail or credential; null for hubs. */
  instanceId: Schema.NullOr(Schema.String),
  windows: Schema.Array(ForkLimitHistoryWindow),
});
export type ForkLimitHistorySeries = typeof ForkLimitHistorySeries.Type;

export const ForkLimitHistoryInput = Schema.Struct({
  hours: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 168 })),
});
export type ForkLimitHistoryInput = typeof ForkLimitHistoryInput.Type;

export const ForkLimitHistory = Schema.Struct({
  /** When this server kept its first sample, epoch ms; null before the first one. */
  collectingSince: Schema.NullOr(Schema.Number),
  sampleIntervalMs: Schema.Number,
  series: Schema.Array(ForkLimitHistorySeries),
});
export type ForkLimitHistory = typeof ForkLimitHistory.Type;

export const ForkActivityInput = Schema.Struct({
  /** Counted back from the current UTC hour, a day of hours each. */
  days: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 371 })),
});
export type ForkActivityInput = typeof ForkActivityInput.Type;

/** By UTC hour, so each client splits days at its own midnight, daylight saving included. */
export const ForkActivityHour = Schema.Struct({
  /** `YYYY-MM-DDTHH`, UTC. */
  hour: Schema.String,
  turns: Schema.Int,
});
export type ForkActivityHour = typeof ForkActivityHour.Type;

export const ForkActivity = Schema.Struct({
  /** Only hours with turns, oldest first. */
  hours: Schema.Array(ForkActivityHour),
  readAt: Schema.String,
});
export type ForkActivity = typeof ForkActivity.Type;
