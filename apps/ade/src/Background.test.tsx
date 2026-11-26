import { describe, expect, it } from "vite-plus/test";

import { readBackgroundPreference, writeBackgroundPreference } from "./Background.tsx";

describe("Background preference storage", () => {
  it("falls back to the still sky when storage is empty or invalid", () => {
    const empty = { getItem: () => null };
    const invalid = { getItem: () => "animado" };
    expect(readBackgroundPreference(empty)).toEqual({ mode: "cielo", color: false });
    expect(readBackgroundPreference(invalid)).toEqual({ mode: "cielo", color: false });
  });

  it("handles storage errors without throwing", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(readBackgroundPreference(broken)).toEqual({ mode: "cielo", color: false });
    expect(() => writeBackgroundPreference({ mode: "liso", color: false }, broken)).not.toThrow();
  });
});
