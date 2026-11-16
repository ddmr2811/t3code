// Fork-only: where the app lands when it starts on Home, kept pure so it can be tested.
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

/** Whether the home thread's environment can say yet if the thread is there. */
export type HomeEnvironmentState = "pending" | "ready" | "unavailable";

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

/**
 * The home thread wins over opening the Dashboard; a missing thread or an unreachable
 * environment falls back to that setting, and then to Home. Only the entry the app opened
 * on counts, so a deep link or a later visit to Home stays where it is.
 */
export function resolveStartScreen(input: {
  readonly initialEntry: boolean;
  readonly homeThread: ScopedThreadRef | null;
  readonly homeEnvironment: HomeEnvironmentState;
  readonly homeThreadExists: boolean;
  readonly openDashboard: boolean;
}): StartScreen {
  if (!input.initialEntry) return { kind: "stay" };
  if (input.homeThread !== null) {
    if (input.homeEnvironment === "pending") return { kind: "wait" };
    if (input.homeEnvironment === "ready" && input.homeThreadExists) {
      return { kind: "thread", threadRef: input.homeThread };
    }
  }
  return input.openDashboard ? { kind: "dashboard" } : { kind: "stay" };
}
