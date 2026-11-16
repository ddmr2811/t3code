import {
  AVAILABLE_CONNECTION_STATE,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  homeEnvironmentState,
  isHomeThread,
  launchTarget,
  parseHomeThread,
  resolveStartScreen,
} from "./homeThread.logic";

const home = scopeThreadRef(EnvironmentId.make("env-pc"), ThreadId.make("thread-orchestrator"));

const connection = (overrides: Partial<SupervisorConnectionState>): SupervisorConnectionState => ({
  ...AVAILABLE_CONNECTION_STATE,
  ...overrides,
});

describe("homeEnvironmentState", () => {
  const state = (overrides: Partial<Parameters<typeof homeEnvironmentState>[0]> = {}) =>
    homeEnvironmentState({
      enabled: true,
      catalogComplete: true,
      shellStatus: "empty",
      hasSnapshot: false,
      connection: null,
      ...overrides,
    });

  it("keeps waiting while an enabled environment has not connected yet", () => {
    // The connection starts out "available" before its first attempt: not a failure.
    expect(state({ connection: AVAILABLE_CONNECTION_STATE })).toBe("pending");
    expect(state()).toBe("pending");
    expect(state({ connection: connection({ phase: "connecting", desired: true }) })).toBe(
      "pending",
    );
    expect(state({ connection: connection({ phase: "backoff", desired: true, attempt: 2 }) })).toBe(
      "pending",
    );
  });

  it("gives up once the connection settles offline or the environment is gone", () => {
    expect(state({ connection: connection({ phase: "offline" }) })).toBe("unavailable");
    expect(state({ connection: connection({ phase: "blocked" }) })).toBe("unavailable");
    expect(state({ connection: connection({ phase: "backoff", desired: true, attempt: 3 }) })).toBe(
      "unavailable",
    );
    expect(state({ enabled: false })).toBe("unavailable");
    expect(state({ enabled: false, catalogComplete: false })).toBe("pending");
  });

  it("trusts only the server's own snapshot to rule a thread out", () => {
    expect(state({ hasSnapshot: true, shellStatus: "cached" })).toBe("cached");
    expect(state({ hasSnapshot: true, shellStatus: "synchronizing" })).toBe("cached");
    expect(state({ hasSnapshot: true, shellStatus: "live" })).toBe("ready");
  });
});

describe("launchTarget", () => {
  it("waits for the primary server's welcome, which may name a thread to open", () => {
    expect(launchTarget({ expectsPrimary: true, welcome: null, primaryEnvironment: null })).toBe(
      "pending",
    );
    expect(
      launchTarget({ expectsPrimary: true, welcome: null, primaryEnvironment: "cached" }),
    ).toBe("pending");
    expect(
      launchTarget({
        expectsPrimary: true,
        welcome: { bootstrapProjectId: "project", bootstrapThreadId: "thread" },
        primaryEnvironment: "ready",
      }),
    ).toBe("present");
    expect(launchTarget({ expectsPrimary: true, welcome: {}, primaryEnvironment: "ready" })).toBe(
      "none",
    );
  });

  it("stops waiting once the primary's own snapshot is live without a welcome", () => {
    const before = launchTarget({
      expectsPrimary: true,
      welcome: null,
      primaryEnvironment: "cached",
    });
    const after = launchTarget({
      expectsPrimary: true,
      welcome: null,
      primaryEnvironment: "ready",
    });
    expect([before, after]).toEqual(["pending", "none"]);
  });

  it("does not wait for a welcome that cannot come", () => {
    expect(launchTarget({ expectsPrimary: false, welcome: null, primaryEnvironment: null })).toBe(
      "none",
    );
    expect(
      launchTarget({ expectsPrimary: true, welcome: null, primaryEnvironment: "unavailable" }),
    ).toBe("none");
  });
});

describe("resolveStartScreen", () => {
  const start = (overrides: Partial<Parameters<typeof resolveStartScreen>[0]> = {}) =>
    resolveStartScreen({
      initialEntry: true,
      launch: "none",
      homeThread: home,
      homeEnvironment: "ready",
      homeThreadExists: true,
      openDashboard: true,
      ...overrides,
    });

  it("opens the home thread, which wins over opening the Dashboard", () => {
    expect(start()).toEqual({ kind: "thread", threadRef: home });
    expect(start({ homeEnvironment: "cached" })).toEqual({ kind: "thread", threadRef: home });
  });

  it("waits while the home thread's environment cannot tell yet", () => {
    expect(start({ homeEnvironment: "pending", homeThreadExists: false })).toEqual({
      kind: "wait",
    });
    // A cache from before the thread was created elsewhere cannot rule it out.
    expect(start({ homeEnvironment: "cached", homeThreadExists: false })).toEqual({
      kind: "wait",
    });
  });

  it("lets the thread the server was launched for win, even when the home thread is ready", () => {
    // A remote environment's snapshot can arrive before the primary server's welcome.
    expect(start({ launch: "pending" })).toEqual({ kind: "wait" });
    expect(start({ launch: "present" })).toEqual({ kind: "stay" });
    expect(start({ launch: "pending", homeThread: null, openDashboard: false })).toEqual({
      kind: "stay",
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
