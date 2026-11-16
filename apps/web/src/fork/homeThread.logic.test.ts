import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isHomeThread, parseHomeThread, resolveStartScreen } from "./homeThread.logic";

const home = scopeThreadRef(EnvironmentId.make("env-pc"), ThreadId.make("thread-orchestrator"));

describe("resolveStartScreen", () => {
  const start = (overrides: Partial<Parameters<typeof resolveStartScreen>[0]> = {}) =>
    resolveStartScreen({
      initialEntry: true,
      homeThread: home,
      homeEnvironment: "ready",
      homeThreadExists: true,
      openDashboard: true,
      ...overrides,
    });

  it("opens the home thread, which wins over opening the Dashboard", () => {
    expect(start()).toEqual({ kind: "thread", threadRef: home });
  });

  it("waits while the home thread's environment cannot tell yet", () => {
    expect(start({ homeEnvironment: "pending", homeThreadExists: false })).toEqual({
      kind: "wait",
    });
  });

  it("falls back to the start setting when the thread or its environment is gone", () => {
    expect(start({ homeThreadExists: false })).toEqual({ kind: "dashboard" });
    expect(start({ homeEnvironment: "unavailable" })).toEqual({ kind: "dashboard" });
    expect(start({ homeEnvironment: "unavailable", openDashboard: false })).toEqual({
      kind: "stay",
    });
    expect(start({ homeThread: null, openDashboard: false })).toEqual({ kind: "stay" });
  });

  it("leaves a deep link or a later visit to Home where it is", () => {
    expect(start({ initialEntry: false })).toEqual({ kind: "stay" });
    expect(start({ initialEntry: false, homeEnvironment: "pending" })).toEqual({ kind: "stay" });
  });
});

describe("home thread key", () => {
  it("round-trips the scoped thread key and ignores a malformed one", () => {
    const key = scopedThreadKey(home);
    expect(parseHomeThread(key)).toEqual(home);
    expect(isHomeThread(key, home)).toBe(true);
    expect(isHomeThread(null, home)).toBe(false);
    expect(parseHomeThread("no-separator")).toBe(null);
    expect(parseHomeThread(null)).toBe(null);
  });
});
