// Fork-only: the extension gateway's manifest, `<stateDir>/fork/gateway.json`, which only the
// owner edits by hand. Its shape is strict so a host or URL cannot slip in under another key.
import * as Schema from "effect/Schema";

const ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
// Segments that never start with a dot: no `.` or `..`, and no `//` a browser reads as a host.
const PANEL_PATH = /^(?=\/)(?:\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)*\/?$/;

const GatewayEntry = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(ID)),
  // Always 127.0.0.1: the manifest names a port, never a host.
  port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
  title: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(80))),
  panelPath: Schema.optionalKey(Schema.String.check(Schema.isPattern(PANEL_PATH))),
});
export type GatewayEntry = typeof GatewayEntry.Type;

const GatewayManifest = Schema.Struct({ extensions: Schema.Array(GatewayEntry) });
const decodeManifest = Schema.decodeUnknownSync(GatewayManifest);

export type GatewayManifestRead =
  | { readonly extensions: ReadonlyArray<GatewayEntry>; readonly problem?: undefined }
  | { readonly extensions: readonly []; readonly problem: string };

/** One bad entry refuses the whole file, so a typo never routes to the wrong port. */
export function parseGatewayManifest(text: string): GatewayManifestRead {
  try {
    const { extensions } = decodeManifest(JSON.parse(text), { onExcessProperty: "error" });
    const ids = new Set<string>();
    for (const { id } of extensions) {
      if (ids.has(id)) return { extensions: [], problem: `The id "${id}" is declared twice.` };
      ids.add(id);
    }
    return { extensions };
  } catch (error) {
    return { extensions: [], problem: error instanceof Error ? error.message : String(error) };
  }
}
