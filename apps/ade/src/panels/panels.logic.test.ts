import { describe, expect, it } from "vite-plus/test";

import { terminalAfterShortcut } from "./panels.logic.ts";

describe("terminalAfterShortcut", () => {
  const open = { kind: "terminal", key: "a", pairing: "p1" } as const;

  it("closes the terminal of the thread on screen", () => {
    expect(terminalAfterShortcut(open, "a", "p1")).toBeNull();
  });

  it("opens one for the thread on screen when the open one is another thread's", () => {
    expect(terminalAfterShortcut(open, "b", "p1")).toEqual({
      kind: "terminal",
      key: "b",
      pairing: "p1",
    });
  });

  it("reopens after the machine is paired again, in one press", () => {
    expect(terminalAfterShortcut(open, "a", "p2")).toEqual({
      kind: "terminal",
      key: "a",
      pairing: "p2",
    });
  });
});
