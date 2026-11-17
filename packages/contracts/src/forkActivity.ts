// Fork-only: what the agents did on one server, for the Dashboard's "What the AI did" card and
// page. Titles and one-line summaries only, never message text; the client adds the machine.
import * as Schema from "effect/Schema";

export const FORK_ACTIVITY_PROTOCOL_VERSION = 1;

export const FORK_ACTIVITY_SUMMARY_MAX = 160;

export const ForkActivitySource = Schema.Literals(["thread", "aon", "log", "git", "pesado"]);
export type ForkActivitySource = typeof ForkActivitySource.Type;

export const ForkActivityActor = Schema.Literals([
  "orchestrator",
  "worker",
  "timer",
  "user",
  "unknown",
]);
export type ForkActivityActor = typeof ForkActivityActor.Type;

export const ForkActivityStatus = Schema.Literals(["ok", "error", "waiting", "running"]);
export type ForkActivityStatus = typeof ForkActivityStatus.Type;

export const ForkActivityEntry = Schema.Struct({
  /** Unique within one server's feed. */
  id: Schema.String,
  /** ISO 8601. */
  at: Schema.String,
  source: ForkActivitySource,
  project: Schema.optionalKey(Schema.String),
  actor: ForkActivityActor,
  summary: Schema.String.check(Schema.isMaxLength(FORK_ACTIVITY_SUMMARY_MAX)),
  status: ForkActivityStatus,
});
export type ForkActivityEntry = typeof ForkActivityEntry.Type;

export const ForkActivityFeedInput = Schema.Struct({
  sinceHours: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 72 }))),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }))),
});
export type ForkActivityFeedInput = typeof ForkActivityFeedInput.Type;

export const ForkActivityFeed = Schema.Struct({
  /** Newest first. */
  entries: Schema.Array(ForkActivityEntry),
  readAt: Schema.String,
});
export type ForkActivityFeed = typeof ForkActivityFeed.Type;
