// Fork-only: how the user arranged the Dashboard, saved in one server's settings (the primary
// unless a client picks another) so every client using that server shows the same one. Icons and
// colours are plain strings so a newer client's never fails an older server's settings decode;
// clients ignore what they do not know.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";

/**
 * Fork: the server keeps `forkDashboard` in its settings and refuses a save made from an older
 * revision (2), keeps `charts` (3) and `activity` (4); older servers drop them or overwrite blindly.
 */
export const FORK_DASHBOARD_PROTOCOL_VERSION = 4;

/** Bounds that keep a bad client from bloating every client's settings. */
const FORK_DASHBOARD_LIMITS = {
  sections: 50,
  machines: 500,
  idsPerMachine: 10,
  providers: 50,
} as const;

const Text = Schema.String.check(Schema.isMaxLength(200));

export const ForkDashboardMachine = Schema.Struct({
  /** Every identity the machine was seen with: `env:<environmentId>`, `tailnet:<node ID>`, `exporter:<name>@<host>`. */
  ids: Schema.Array(Text).check(Schema.isMaxLength(FORK_DASHBOARD_LIMITS.idsPerMachine)),
  /** Its own name when last saved, so a machine that is gone still reads in edit mode. */
  name: Text.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  alias: Schema.NullOr(Text).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  icon: Schema.NullOr(Text).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  color: Schema.NullOr(Text).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  hidden: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** A custom section's id; null keeps the machine in its default section. */
  section: Schema.NullOr(Text).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type ForkDashboardMachine = typeof ForkDashboardMachine.Type;

export const ForkDashboardSection = Schema.Struct({ id: Text, name: Text });
export type ForkDashboardSection = typeof ForkDashboardSection.Type;

export const ForkDashboardPanelId = Schema.Literals(["machines", "subscriptions", "threads"]);
export type ForkDashboardPanelId = typeof ForkDashboardPanelId.Type;

export const ForkDashboardPanelSetting = Schema.Struct({
  id: ForkDashboardPanelId,
  hidden: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type ForkDashboardPanelSetting = typeof ForkDashboardPanelSetting.Type;

/**
 * The Charts panel, kept apart from `panels`: clients from before it decode `panels` as a closed
 * set, while a key they do not know is dropped.
 */
export const ForkDashboardChartsSetting = Schema.Struct({
  hidden: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** The panel it follows; null puts it first. */
  after: Schema.NullOr(ForkDashboardPanelId).pipe(
    Schema.withDecodingDefault(Effect.succeed("subscriptions" as const)),
  ),
});
export type ForkDashboardChartsSetting = typeof ForkDashboardChartsSetting.Type;

export const DEFAULT_FORK_DASHBOARD_CHARTS: ForkDashboardChartsSetting = {
  hidden: false,
  after: "subscriptions",
};

/**
 * The "What the AI did" panel, kept apart like Charts. It may follow Charts; Charts never follows
 * it, since clients from before it decode `charts.after` as a closed set.
 */
export const ForkDashboardActivitySetting = Schema.Struct({
  hidden: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** The panel it follows; null puts it first. */
  after: Schema.NullOr(Schema.Union([ForkDashboardPanelId, Schema.Literal("charts")])).pipe(
    Schema.withDecodingDefault(Effect.succeed("threads" as const)),
  ),
});
export type ForkDashboardActivitySetting = typeof ForkDashboardActivitySetting.Type;

export const DEFAULT_FORK_DASHBOARD_ACTIVITY: ForkDashboardActivitySetting = {
  hidden: false,
  after: "threads",
};

/** Arrays only, so a settings patch replaces each one whole; their order is the Dashboard's. */
export const ForkDashboardLayout = Schema.Struct({
  /**
   * Counts saves. A save carries the revision it was edited from plus one; the server refuses any
   * other, so two devices never overwrite each other unseen.
   */
  revision: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  panels: Schema.Array(ForkDashboardPanelSetting)
    .check(Schema.isMaxLength(ForkDashboardPanelId.literals.length))
    .pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  sections: Schema.Array(ForkDashboardSection)
    .check(Schema.isMaxLength(FORK_DASHBOARD_LIMITS.sections))
    .pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  machines: Schema.Array(ForkDashboardMachine)
    .check(Schema.isMaxLength(FORK_DASHBOARD_LIMITS.machines))
    .pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  hiddenProviders: Schema.Array(Text)
    .check(Schema.isMaxLength(FORK_DASHBOARD_LIMITS.providers))
    .pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  charts: ForkDashboardChartsSetting.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_FORK_DASHBOARD_CHARTS)),
  ),
  activity: ForkDashboardActivitySetting.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_FORK_DASHBOARD_ACTIVITY)),
  ),
});
export type ForkDashboardLayout = typeof ForkDashboardLayout.Type;

/**
 * What a save sends. A client from before Activity sends no `activity`; with no default here the
 * settings merge keeps the saved one, where the stored layout's default would reset it.
 */
export const ForkDashboardLayoutWrite = Schema.Struct({
  ...ForkDashboardLayout.fields,
  activity: Schema.optionalKey(ForkDashboardActivitySetting),
});
export type ForkDashboardLayoutWrite = typeof ForkDashboardLayoutWrite.Type;

export const DEFAULT_FORK_DASHBOARD_LAYOUT: ForkDashboardLayout = {
  revision: 0,
  panels: [],
  sections: [],
  machines: [],
  hiddenProviders: [],
  charts: DEFAULT_FORK_DASHBOARD_CHARTS,
  activity: DEFAULT_FORK_DASHBOARD_ACTIVITY,
};
