import { describe, expect, it } from "vite-plus/test";

import { forkBaseVersion } from "./forkVersion.ts";

describe("forkBaseVersion", () => {
  it.each([
    ["0.1.901", "0.1.9"],
    ["0.1.903", "0.1.9"],
    ["0.1.999", "0.1.9"],
    ["0.1.1001", "0.1.10"],
    ["1.2.100", "1.2.1"],
  ])("maps fork build %s to its base %s", (version, base) => {
    expect(forkBaseVersion(version)).toBe(base);
  });

  it.each(["0.1.9", "0.1.99", "0.2.3", "0.1.10-nightly.20261115.4749", "dev", ""])(
    "leaves %s unchanged",
    (version) => {
      expect(forkBaseVersion(version)).toBe(version);
    },
  );
});
