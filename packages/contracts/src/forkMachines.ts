// Fork-only: the Dashboard's machines: a live load stream and the node_exporters a server reads.
import * as Schema from "effect/Schema";

import { HostResourcesSnapshot } from "./resourceTelemetry.ts";

export const FORK_MACHINES_PROTOCOL_VERSION = 1;

export const ForkNodeExporterReading = Schema.Struct({
  name: Schema.String,
  /** The URL's host, which the Dashboard matches against the tailnet's peers. */
  host: Schema.String,
  /** Null when the exporter did not answer or its URL is refused; `problem` says why. */
  resources: Schema.NullOr(HostResourcesSnapshot),
  problem: Schema.NullOr(Schema.String),
  /** The scrape's round trip from the server. */
  latencyMs: Schema.NullOr(Schema.Number),
});
export type ForkNodeExporterReading = typeof ForkNodeExporterReading.Type;

export const ForkNodeExportersStatus = Schema.Struct({
  exporters: Schema.Array(ForkNodeExporterReading),
});
export type ForkNodeExportersStatus = typeof ForkNodeExportersStatus.Type;
