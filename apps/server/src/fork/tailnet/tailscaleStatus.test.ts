import { describe, expect, it } from "@effect/vitest";

import {
  parseTailscalePing,
  parseTailscaleStatus,
  shouldPing,
  withPong,
} from "./tailscaleStatus.ts";

/** Trimmed from a real `tailscale status --json` (1.104), with made-up keys and addresses. */
const STATUS_SAMPLE = JSON.stringify({
  Version: "1.104.7",
  BackendState: "Running",
  Self: {
    ID: "nSelf",
    PublicKey: "nodekey:self",
    HostName: "dev-box",
    DNSName: "dev-box.tail0000.ts.net.",
    OS: "linux",
    TailscaleIPs: ["100.64.0.1", "fd7a:115c:a1e0::1"],
    CurAddr: "",
    Relay: "nue",
    Online: true,
    LastSeen: "0001-01-01T00:00:00Z",
  },
  Peer: {
    "nodekey:a": {
      ID: "nProd",
      HostName: "prod-box",
      DNSName: "prod-box.tail0000.ts.net.",
      OS: "linux",
      TailscaleIPs: ["100.64.0.2"],
      CurAddr: "",
      Relay: "hel",
      Active: false,
      Online: true,
      LastSeen: "0001-01-01T00:00:00Z",
    },
    "nodekey:b": {
      ID: "nPc",
      HostName: "Desk",
      DNSName: "desk.tail0000.ts.net.",
      OS: "windows",
      TailscaleIPs: ["100.64.0.3"],
      CurAddr: "203.0.113.7:41641",
      Relay: "mad",
      Active: true,
      Online: true,
      LastSeen: "0001-01-01T00:00:00Z",
    },
    "nodekey:c": {
      ID: "nPhone",
      HostName: "Phone",
      DNSName: "phone.tail0000.ts.net.",
      OS: "android",
      TailscaleIPs: ["100.64.0.4"],
      CurAddr: "",
      Relay: "mad",
      Active: true,
      Online: true,
      LastSeen: "0001-01-01T00:00:00Z",
    },
    "nodekey:d": {
      ID: "nOld",
      HostName: "old-box",
      DNSName: "old-box.tail0000.ts.net.",
      OS: "linux",
      TailscaleIPs: ["100.64.0.5"],
      Relay: "fra",
      Online: false,
      LastSeen: "2026-11-15T19:20:00.1Z",
    },
  },
});

describe("parseTailscaleStatus", () => {
  it("reads self and every peer, online first, with how each is reached", () => {
    const parsed = parseTailscaleStatus(STATUS_SAMPLE);
    expect(parsed.available).toBe(true);
    if (!parsed.available) return;
    expect(parsed.self).toEqual({
      id: "nSelf",
      hostName: "dev-box",
      dnsName: "dev-box.tail0000.ts.net",
      os: "linux",
      addresses: ["100.64.0.1", "fd7a:115c:a1e0::1"],
    });
    expect(
      parsed.peers.map(({ hostName, connection, relay, lastSeen }) => ({
        hostName,
        connection,
        relay,
        lastSeen,
      })),
    ).toEqual([
      { hostName: "Desk", connection: "direct", relay: "mad", lastSeen: null },
      { hostName: "Phone", connection: "relay", relay: "mad", lastSeen: null },
      { hostName: "prod-box", connection: "idle", relay: "hel", lastSeen: null },
      {
        hostName: "old-box",
        connection: "offline",
        relay: "fra",
        lastSeen: "2026-11-15T19:20:00.1Z",
      },
    ]);
  });

  it("reads a tailnet with no peers", () => {
    const parsed = parseTailscaleStatus(JSON.stringify({ BackendState: "Running", Self: null }));
    expect(parsed).toEqual({ available: true, self: null, peers: [] });
  });

  it.each([
    ["", "Tailscale returned no readable status."],
    ["failed to connect to local tailscaled", "Tailscale returned no readable status."],
    ["[]", "Tailscale returned no readable status."],
    [JSON.stringify({ BackendState: "Stopped", Peer: {} }), "Tailscale is stopped."],
    [JSON.stringify({ BackendState: "NeedsLogin" }), "Tailscale is needslogin."],
  ])("reports %j as unavailable", (stdout, problem) => {
    expect(parseTailscaleStatus(stdout)).toEqual({ available: false, problem });
  });
});

describe("parseTailscalePing", () => {
  it.each([
    [
      "pong from prod-box (100.64.0.2) via DERP(hel) in 83ms\ndirect connection not established\n",
      { latencyMs: 83, via: "DERP(hel)" },
    ],
    [
      "pong from desk (100.64.0.3) via 203.0.113.7:41641 in 4ms\n",
      { latencyMs: 4, via: "203.0.113.7:41641" },
    ],
    [
      "pong from desk (100.64.0.3) via 203.0.113.7:41641 in 1.2s\n",
      { latencyMs: 1200, via: "203.0.113.7:41641" },
    ],
    ["timeout waiting for ping reply\n", null],
    ["", null],
  ])("reads %j", (stdout, expected) => {
    expect(parseTailscalePing(stdout)).toEqual(expected);
  });
});

describe("withPong and shouldPing", () => {
  const parsed = parseTailscaleStatus(STATUS_SAMPLE);
  const peers = parsed.available ? parsed.peers : [];
  const prod = peers.find((peer) => peer.hostName === "prod-box");

  it("takes the path the pong came back on", () => {
    if (prod === undefined) throw new Error("sample has prod-box");
    expect(withPong(prod, { latencyMs: 83, via: "DERP(hel)" })).toMatchObject({
      connection: "relay",
      relay: "hel",
      latencyMs: 83,
    });
    expect(withPong(prod, { latencyMs: 3, via: "203.0.113.9:41641" })).toMatchObject({
      connection: "direct",
      latencyMs: 3,
    });
    expect(withPong(prod, null)).toBe(prod);
  });

  it("pings online computers only", () => {
    expect(peers.filter(shouldPing).map((peer) => peer.hostName)).toEqual(["Desk", "prod-box"]);
  });
});
