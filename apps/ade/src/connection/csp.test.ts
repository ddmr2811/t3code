import { describe, expect, it } from "vite-plus/test";

import { connectSrc, originAllowed, parseConnectOrigins } from "./csp.ts";

describe("parseConnectOrigins", () => {
  it.each([
    ["a directive smuggled after an origin", "https://a.ts.net; script-src *"],
    ["a quoted keyword", "'unsafe-inline'"],
    ["a bare scheme that would allow any host", "https:"],
    ["a wildcard that is not a whole label", "https://*a.ts.net"],
    ["a path", "https://a.ts.net/x"],
    ["plain http to another machine", "http://10.0.0.2:3773"],
    ["plain http to a name that only starts like loopback", "http://localhost.evil.net"],
  ])("rejects %s", (_name, raw) => {
    expect(() => parseConnectOrigins(raw)).toThrow();
  });

  it("splits on spaces and commas and allows nothing when unset", () => {
    expect(
      parseConnectOrigins("https://a.ts.net, http://127.0.0.1:3773 http://[::1]:3773"),
    ).toEqual(["https://a.ts.net", "http://127.0.0.1:3773", "http://[::1]:3773"]);
    expect(parseConnectOrigins(undefined)).toEqual([]);
  });
});

describe("connectSrc", () => {
  it("allows each origin for fetch and for its WebSocket, and nothing else", () => {
    expect(connectSrc(["https://*.tail.ts.net", "http://localhost:3773"])).toBe(
      "'self' https://*.tail.ts.net wss://*.tail.ts.net http://localhost:3773 ws://localhost:3773",
    );
    expect(connectSrc([])).toBe("'self'");
  });
});

describe("originAllowed", () => {
  const origins = ["https://*.tail.ts.net", "http://localhost:3773", "https://box.lan:*"];

  it.each([
    ["a machine of the wildcard tailnet", "https://dev.tail.ts.net/pair#token=x", true],
    ["the wildcard's own apex", "https://tail.ts.net", false],
    ["a lookalike suffix", "https://eviltail.ts.net", false],
    ["the wildcard host on another scheme", "http://dev.tail.ts.net", false],
    ["the wildcard host on a non-default port", "https://dev.tail.ts.net:8443", false],
    ["an exact origin", "http://localhost:3773", true],
    ["an exact origin on another port", "http://localhost:3774", false],
    ["any port when the entry says so", "https://box.lan:9000", true],
    ["an unlisted host", "https://example.com", false],
    ["text that is not a URL", "dev.tail.ts.net", false],
  ])("%s", (_name, url, expected) => {
    expect(originAllowed(url, origins)).toBe(expected);
  });
});
