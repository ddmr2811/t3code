// Fork-only: reads `tailscale status --json` and `tailscale ping` output into the Dashboard's shape.
import type { ForkTailnetNode, ForkTailnetPeer } from "@t3tools/contracts";

/** Go's zero time, which Tailscale prints for "never". */
const ZERO_TIME_PREFIX = "0001-01-01";

export type ParsedTailscaleStatus =
  | {
      readonly available: true;
      readonly self: ForkTailnetNode | null;
      readonly peers: ReadonlyArray<ForkTailnetPeer>;
    }
  | { readonly available: false; readonly problem: string };

const text = (value: unknown): string => (typeof value === "string" ? value : "");

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function node(raw: Record<string, unknown>): ForkTailnetNode {
  const addresses = Array.isArray(raw.TailscaleIPs)
    ? raw.TailscaleIPs.filter((address): address is string => typeof address === "string")
    : [];
  return {
    id: text(raw.ID) || text(raw.PublicKey),
    hostName: text(raw.HostName),
    dnsName: text(raw.DNSName).replace(/\.$/, ""),
    os: text(raw.OS),
    addresses,
  };
}

function peer(raw: Record<string, unknown>): ForkTailnetPeer {
  const online = raw.Online === true;
  const relay = text(raw.Relay) || null;
  const lastSeen = text(raw.LastSeen);
  return {
    ...node(raw),
    online,
    connection: !online
      ? "offline"
      : text(raw.CurAddr) !== ""
        ? "direct"
        : raw.Active === true && relay !== null
          ? "relay"
          : "idle",
    relay,
    lastSeen: online || lastSeen === "" || lastSeen.startsWith(ZERO_TIME_PREFIX) ? null : lastSeen,
    latencyMs: null,
  };
}

export function parseTailscaleStatus(stdout: string): ParsedTailscaleStatus {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { available: false, problem: "Tailscale returned no readable status." };
  }
  const status = record(parsed);
  if (status === null)
    return { available: false, problem: "Tailscale returned no readable status." };
  const backend = text(status.BackendState);
  if (backend !== "" && backend !== "Running") {
    return { available: false, problem: `Tailscale is ${backend.toLowerCase()}.` };
  }
  const self = record(status.Self);
  const peers = Object.values(record(status.Peer) ?? {})
    .map(record)
    .filter((entry) => entry !== null)
    .map(peer)
    .toSorted(
      (left, right) =>
        Number(right.online) - Number(left.online) || left.hostName.localeCompare(right.hostName),
    );
  return { available: true, self: self === null ? null : node(self), peers };
}

export interface TailscalePong {
  readonly latencyMs: number;
  /** `DERP(fra)` for a relayed answer, the peer's `ip:port` for a direct one. */
  readonly via: string;
}

/** `tailscale ping` exits 1 when no direct path exists even though the pong came back. */
export function parseTailscalePing(stdout: string): TailscalePong | null {
  const match = /pong from .* via (\S+) in ([\d.]+)\s*(ms|s|µs|us)\b/.exec(stdout);
  if (match === null) return null;
  const [, via = "", amount = "", unit] = match;
  const value = Number(amount);
  if (!Number.isFinite(value)) return null;
  const latencyMs = unit === "s" ? value * 1000 : unit === "ms" ? value : value / 1000;
  return { latencyMs: Math.round(latencyMs * 10) / 10, via };
}

/** A pong also says which path answered, which is fresher than the status snapshot. */
export function withPong(target: ForkTailnetPeer, pong: TailscalePong | null): ForkTailnetPeer {
  if (pong === null) return target;
  const relay = /^DERP\(([^)]+)\)$/.exec(pong.via)?.[1] ?? null;
  return {
    ...target,
    latencyMs: pong.latencyMs,
    connection: relay === null ? "direct" : "relay",
    relay: relay ?? target.relay,
  };
}

/** Phones and tablets wake up for every ping, so they only report presence. */
export function shouldPing(target: ForkTailnetPeer): boolean {
  return target.online && target.addresses.length > 0 && !/^(android|ios)$/i.test(target.os);
}
