// Fork-only: how the user arranged the Dashboard, saved in the primary server's settings so every
// client of that server shows the same one. Values are plain strings so a newer client's icon or
// panel never fails an older server's settings decode; clients ignore what they do not know.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** Fork: the server keeps `forkDashboard` in its settings; older servers drop it on save. */
export const FORK_DASHBOARD_PROTOCOL_VERSION = 1;

const Text = Schema.String.check(Schema.isMaxLength(200));

export const ForkDashboardMachine = Schema.Struct({
  /** Every identity the machine was seen with: `env:<environmentId>`, `tailnet:<node ID>`, `exporter:<name>@<host>`. */
  ids: Schema.Array(Text),
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

export const ForkDashboardPanelSetting = Schema.Struct({
  /** `machines`, `subscriptions` or `threads`. */
  id: Text,
  hidden: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type ForkDashboardPanelSetting = typeof ForkDashboardPanelSetting.Type;

/** Arrays only, so a settings patch replaces each one whole; their order is the Dashboard's. */
export const ForkDashboardLayout = Schema.Struct({
  panels: Schema.Array(ForkDashboardPanelSetting).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  sections: Schema.Array(ForkDashboardSection).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  machines: Schema.Array(ForkDashboardMachine).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  hiddenProviders: Schema.Array(Text).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type ForkDashboardLayout = typeof ForkDashboardLayout.Type;

export const DEFAULT_FORK_DASHBOARD_LAYOUT: ForkDashboardLayout = {
  panels: [],
  sections: [],
  machines: [],
  hiddenProviders: [],
};
