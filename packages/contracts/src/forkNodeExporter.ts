// Fork-only: a Prometheus node_exporter a server reads for the Dashboard, kept apart from the
// RPC types so the settings schema can name it without an import cycle.
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ForkNodeExporter = Schema.Struct({
  name: TrimmedNonEmptyString,
  /** Plain http to a Tailscale address or MagicDNS name, such as http://100.96.210.49:9100/metrics. */
  url: TrimmedNonEmptyString,
});
export type ForkNodeExporter = typeof ForkNodeExporter.Type;
