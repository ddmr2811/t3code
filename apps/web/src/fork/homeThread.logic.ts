// Fork-only: where the app lands when it starts on Home, kept pure so it can be tested.
import type { SupervisorConnectionState } from "@t3tools/client-runtime/connection";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentShellStatus } from "@t3tools/client-runtime/state/shell";
import type { ScopedThreadRef } from "@t3tools/contracts";

/**
 * What the home thread's environment can say about the thread: nothing yet, a cache that can
 * confirm it but not rule it out, the server's own snapshot, or nothing ever (gone or offline).
 */
export type HomeEnvironmentState = "pending" | "cached" | "ready" | "unavailable";

/** Whether the primary server's welcome named a thread to open, which outranks the settings. */
export type LaunchTarget = "pending" | "none" | "present";

export type StartScreen =
  | { readonly kind: "wait" }
  | { readonly kind: "stay" }
  | { readonly kind: "dashboard" }
  | { readonly kind: "thread"; readonly threadRef: ScopedThreadRef };

export function parseHomeThread(key: string | null): ScopedThreadRef | null {
  return key === null ? null : parseScopedThreadKey(key);
}

export function isHomeThread(key: string | null, ref: ScopedThreadRef): boolean {
  return key !== null && key === scopedThreadKey(ref);
}

/** Settled offline: the same test the app's bootstrap uses; a first connect is still trying. */
function stoppedTrying(connection: SupervisorConnectionState | null): boolean {
  if (connection === null) return false;
  switch (connection.phase) {
    case "offline":
    case "blocked":
      return true;
    case "backoff":
      return !(connection.desired && connection.attempt <= 2);
    case "available":
    case "connecting":
    case "connected":
      return false;
  }
}

export function homeEnvironmentState(input: {
  readonly enabled: boolean;
  readonly catalogComplete: boolean;
  readonly shellStatus: EnvironmentShellStatus;
  readonly hasSnapshot: boolean;
  /** Null until the environment's connection reports a state. */
  readonly connection: SupervisorConnectionState | null;
}): HomeEnvironmentState {
  if (!input.enabled) return input.catalogComplete ? "unavailable" : "pending";
  if (input.hasSnapshot && input.shellStatus === "live") return "ready";
  if (stoppedTrying(input.connection)) return "unavailable";
  return input.hasSnapshot ? "cached" : "pending";
}

export function launchTarget(input: {
  readonly expectsPrimary: boolean;
  readonly welcome: {
    readonly bootstrapProjectId?: string | undefined;
    readonly bootstrapThreadId?: string | undefined;
  } | null;
  /** Null until the primary environment is known. */
  readonly primaryEnvironment: HomeEnvironmentState | null;
}): LaunchTarget {
  if (!input.expectsPrimary) return "none";
  if (input.welcome !== null) {
    return input.welcome.bootstrapProjectId && input.welcome.bootstrapThreadId ? "present" : "none";
  }
  // The welcome comes on its own subscription, unordered with the shell's, but it is replayed
  // at once on connect; once the primary's own snapshot is live without one, it names nothing.
  // A primary that has stopped trying will not send one either.
  return input.primaryEnvironment === "unavailable" || input.primaryEnvironment === "ready"
    ? "none"
    : "pending";
}

/**
 * A thread the server was launched for wins; then the home thread, then opening the Dashboard.
 * A cache can confirm the home thread but only the server's snapshot can rule it out; a missing
 * thread or an unreachable environment falls back. Only the entry the app opened on counts, so
 * a deep link or a later visit to Home stays where it is.
 */
export function resolveStartScreen(input: {
  readonly initialEntry: boolean;
  readonly launch: LaunchTarget;
  readonly homeThread: ScopedThreadRef | null;
  readonly homeEnvironment: HomeEnvironmentState;
  readonly homeThreadExists: boolean;
  readonly openDashboard: boolean;
}): StartScreen {
  if (!input.initialEntry || input.launch === "present") return { kind: "stay" };
  if (input.homeThread === null && !input.openDashboard) return { kind: "stay" };
  if (input.launch === "pending") return { kind: "wait" };
  if (input.homeThread !== null) {
    const canGo = input.homeEnvironment === "ready" || input.homeEnvironment === "cached";
    if (canGo && input.homeThreadExists) return { kind: "thread", threadRef: input.homeThread };
    if (input.homeEnvironment === "pending" || input.homeEnvironment === "cached") {
      return { kind: "wait" };
    }
  }
  return input.openDashboard ? { kind: "dashboard" } : { kind: "stay" };
}
