import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { NonNegativeInt } from "./baseSchemas.ts";
import { DEFAULT_FORK_DASHBOARD_LAYOUT, ForkDashboardLayout } from "./forkDashboard.ts";

// The layout schema as released in desktop 0.1.905 (9c0a017489), whose panel ids are closed.
/** Bounds that keep a bad client from bloating every client's settings. */
const FORK_DASHBOARD_LIMITS = {
  sections: 50,
  machines: 500,
  idsPerMachine: 10,
  providers: 50,
} as const;

const Text = Schema.String.check(Schema.isMaxLength(200));

const ReleasedMachine = Schema.Struct({
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

const ReleasedSection = Schema.Struct({ id: Text, name: Text });

const ReleasedPanelId = Schema.Literals(["machines", "subscriptions", "threads"]);

const ReleasedPanelSetting = Schema.Struct({
  id: ReleasedPanelId,
  hidden: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});

/** Arrays only, so a settings patch replaces each one whole; their order is the Dashboard's. */
const ReleasedForkDashboardLayout = Schema.Struct({
  /**
   * Counts saves. A save carries the revision it was edited from plus one; the server refuses any
   * other, so two devices never overwrite each other unseen.
   */
  revision: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  panels: Schema.Array(ReleasedPanelSetting)
    .check(Schema.isMaxLength(ReleasedPanelId.literals.length))
    .pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  sections: Schema.Array(ReleasedSection)
    .check(Schema.isMaxLength(FORK_DASHBOARD_LIMITS.sections))
    .pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  machines: Schema.Array(ReleasedMachine)
    .check(Schema.isMaxLength(FORK_DASHBOARD_LIMITS.machines))
    .pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  hiddenProviders: Schema.Array(Text)
    .check(Schema.isMaxLength(FORK_DASHBOARD_LIMITS.providers))
    .pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});

const encodeLayout = Schema.encodeSync(ForkDashboardLayout);
const decodeLayout = Schema.decodeUnknownSync(ForkDashboardLayout);
const decodeReleasedLayout = Schema.decodeUnknownSync(ReleasedForkDashboardLayout);

describe("ForkDashboardLayout", () => {
  it("saves Charts where a 0.1.905 client still decodes the layout", () => {
    const saved = encodeLayout({
      ...DEFAULT_FORK_DASHBOARD_LAYOUT,
      revision: 4,
      panels: [
        { id: "threads", hidden: false },
        { id: "machines", hidden: true },
        { id: "subscriptions", hidden: false },
      ],
      charts: { hidden: true, after: null },
    });
    const released = decodeLayout(JSON.parse(JSON.stringify(saved)));
    expect(released.charts).toEqual({ hidden: true, after: null });
    const older = decodeReleasedLayout(JSON.parse(JSON.stringify(saved)));
    expect(older.revision).toBe(4);
    expect(older.panels.map((panel) => panel.id)).toEqual(["threads", "machines", "subscriptions"]);
    expect(Object.keys(older)).not.toContain("charts");
  });

  it("reads a layout saved before Charts with Charts after Subscriptions", () => {
    expect(decodeLayout({ revision: 1 }).charts).toEqual({
      hidden: false,
      after: "subscriptions",
    });
  });
});
