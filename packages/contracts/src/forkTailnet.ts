// Fork-only: what an environment's Tailscale client reports about the tailnet, for the Dashboard.
import * as Schema from "effect/Schema";

export const FORK_TAILNET_PROTOCOL_VERSION = 1;

/** `idle` is an online peer with no live path yet; Tailscale only picks one when traffic flows. */
export const ForkTailnetConnection = Schema.Literals(["direct", "relay", "idle", "offline"]);
export type ForkTailnetConnection = typeof ForkTailnetConnection.Type;

export const ForkTailnetNode = Schema.Struct({
  id: Schema.String,
  hostName: Schema.String,
  /** MagicDNS name without the trailing dot; empty when MagicDNS is off. */
  dnsName: Schema.String,
  os: Schema.String,
  addresses: Schema.Array(Schema.String),
});
export type ForkTailnetNode = typeof ForkTailnetNode.Type;

export const ForkTailnetPeer = Schema.Struct({
  ...ForkTailnetNode.fields,
  online: Schema.Boolean,
  connection: ForkTailnetConnection,
  /** The DERP region a relayed path goes through, such as `fra`. */
  relay: Schema.NullOr(Schema.String),
  /** Only for offline peers; Tailscale leaves it empty while a peer is online. */
  lastSeen: Schema.NullOr(Schema.String),
  /** A `tailscale ping` round trip, when asked for and answered. */
  latencyMs: Schema.NullOr(Schema.Number),
});
export type ForkTailnetPeer = typeof ForkTailnetPeer.Type;

export const ForkTailnetStatusInput = Schema.Struct({
  /** Ping the online peers. Without it the call only reads `tailscale status`. */
  ping: Schema.optional(Schema.Boolean),
});
export type ForkTailnetStatusInput = typeof ForkTailnetStatusInput.Type;

export const ForkTailnetStatus = Schema.Struct({
  checkedAt: Schema.String,
  /** False when Tailscale is missing, stopped or unreadable; `problem` says why. */
  available: Schema.Boolean,
  problem: Schema.NullOr(Schema.String),
  self: Schema.NullOr(ForkTailnetNode),
  peers: Schema.Array(ForkTailnetPeer),
});
export type ForkTailnetStatus = typeof ForkTailnetStatus.Type;
