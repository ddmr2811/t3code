import { describe, expect, it } from "vite-plus/test";

import { parseGatewayManifest } from "./manifest.ts";

const manifest = (entry: Record<string, unknown>) =>
  JSON.stringify({ extensions: [{ id: "panel", port: 8642, ...entry }] });

describe("parseGatewayManifest", () => {
  it("accepts a port on 127.0.0.1 with a title and a panel path", () => {
    expect(parseGatewayManifest(manifest({ title: "Hermes", panelPath: "/ui/" }))).toEqual({
      extensions: [{ id: "panel", port: 8642, title: "Hermes", panelPath: "/ui/" }],
    });
  });

  it.each([
    ["another host", { host: "192.168.1.5" }],
    ["a URL instead of a port", { url: "http://10.0.0.1:80" }],
    ["port 0", { port: 0 }],
    ["a port past 65535", { port: 65_536 }],
    ["a port as text", { port: "8642" }],
    ["an id that is not a slug", { id: "../admin" }],
    ["a panel path that names another host", { panelPath: "//evil.test/" }],
    ["a panel path that climbs out", { panelPath: "/a/../../b" }],
  ])("refuses the whole manifest for %s", (_name, entry) => {
    const read = parseGatewayManifest(manifest(entry));
    expect(read.extensions).toEqual([]);
    expect(read.problem).toBeTypeOf("string");
  });

  it("refuses an id declared twice", () => {
    const read = parseGatewayManifest(
      JSON.stringify({
        extensions: [
          { id: "panel", port: 1 },
          { id: "panel", port: 2 },
        ],
      }),
    );
    expect(read.extensions).toEqual([]);
    expect(read.problem).toBeTypeOf("string");
  });
});
