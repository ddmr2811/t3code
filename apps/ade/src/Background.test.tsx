import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  AdeBackground,
  readBackgroundPreference,
  writeBackgroundPreference,
} from "./Background.tsx";

describe("Background preference storage", () => {
  it("falls back to quiet moon in grayscale when storage is empty or invalid", () => {
    const empty = { getItem: () => null };
    const invalid = { getItem: () => "animado" };
    expect(readBackgroundPreference(empty)).toEqual({ mode: "luna", color: false });
    expect(readBackgroundPreference(invalid)).toEqual({ mode: "luna", color: false });
  });

  it("round-trips valid mode and color settings", () => {
    const map = new Map<string, string>();
    const storage = {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        map.set(key, value);
      },
    };
    writeBackgroundPreference({ mode: "imagen", color: true }, storage);
    expect(readBackgroundPreference(storage)).toEqual({ mode: "imagen", color: true });

    writeBackgroundPreference({ mode: "liso", color: false }, storage);
    expect(readBackgroundPreference(storage)).toEqual({ mode: "liso", color: false });
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
    expect(readBackgroundPreference(broken)).toEqual({ mode: "luna", color: false });
    expect(() => writeBackgroundPreference({ mode: "liso", color: false }, broken)).not.toThrow();
  });
});

describe("AdeBackground", () => {
  it("renders a CSS-only background layer and accessible mode toggles without canvas", () => {
    const html = renderToStaticMarkup(<AdeBackground />);
    expect(html).not.toContain("<canvas");
    expect(html).toContain('data-ade-bg="luna"');
    expect(html).toContain('aria-label="Fondo"');
    expect(html).toContain("Luna");
    expect(html).toContain("Imagen");
    expect(html).toContain("Liso");
    expect(html).toContain('aria-pressed="true"');
  });
});
