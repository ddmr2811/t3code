import { describe, expect, it } from "vite-plus/test";

import { resolveBaseVersion } from "./forkVersion.ts";

describe("resolveBaseVersion", () => {
  it.each([
    ["0.1.903", "0.1.9", "0.1.9"],
    // fork-desktop-0.2.0-3 builds 0.2.3, which no rule can tell from upstream 0.2.3.
    ["0.2.3", "0.2.0", "0.2.0"],
    ["0.1.1001", "0.1.10", "0.1.10"],
  ])("uses the recorded base of fork build %s", (appVersion, base, expected) => {
    expect(resolveBaseVersion(appVersion, base)).toBe(expected);
  });

  it.each(["0.1.100", "0.1.199", "0.1.9", "0.1.10-nightly.20261115.4749"])(
    "leaves %s as it is when the build records no base",
    (appVersion) => {
      expect(resolveBaseVersion(appVersion, undefined)).toBe(appVersion);
      expect(resolveBaseVersion(appVersion, "")).toBe(appVersion);
    },
  );
});
