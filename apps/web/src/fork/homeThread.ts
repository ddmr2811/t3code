// Fork-only: the home thread, a client setting the app opens on start with the Dashboard beside it.
import { useAtomValue } from "@effect/atom-react";
import {
  AVAILABLE_CONNECTION_STATE,
  connectionProjectionPhase,
} from "@t3tools/client-runtime/connection";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { environmentCatalog } from "../connection/catalog";
import { persistClientSettingsUpdate, useClientSettings } from "../hooks/useSettings";
import { catalogIsComplete, environmentShell, expectsPrimaryEnvironment } from "../state/shell";
import { type HomeEnvironmentState, isHomeThread } from "./homeThread.logic";

const NO_ENVIRONMENT_ATOM = Atom.make<HomeEnvironmentState>("unavailable").pipe(
  Atom.withLabel("fork-home-thread-environment:none"),
);

/**
 * Ready once the environment's threads are known, from the server or its cache. Unavailable when
 * it is not configured or has stopped trying to connect, the same test the app's bootstrap uses.
 */
const homeEnvironmentStateAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): HomeEnvironmentState => {
    const catalog = get(environmentCatalog.catalogValueAtom);
    if (![...enabledEnvironmentIds(catalog)].includes(environmentId)) {
      return catalogIsComplete(catalog, expectsPrimaryEnvironment()) ? "unavailable" : "pending";
    }
    if (Option.isSome(get(environmentShell.stateValueAtom(environmentId)).snapshot)) return "ready";
    const connection = AsyncResult.getOrElse(
      get(environmentCatalog.stateAtom(environmentId)),
      () => AVAILABLE_CONNECTION_STATE,
    );
    if (connectionProjectionPhase(connection) !== "disconnected") return "pending";
    if (connection.phase === "backoff" && connection.desired && connection.attempt <= 2) {
      return "pending";
    }
    return "unavailable";
  }).pipe(Atom.withLabel(`fork-home-thread-environment:${environmentId}`)),
);

export function useHomeEnvironmentState(environmentId: EnvironmentId | null): HomeEnvironmentState {
  return useAtomValue(
    environmentId === null ? NO_ENVIRONMENT_ATOM : homeEnvironmentStateAtom(environmentId),
  );
}

export function useIsHomeThread(ref: ScopedThreadRef | null): boolean {
  return useClientSettings(
    (settings) => ref !== null && isHomeThread(settings.forkHomeThread, ref),
  );
}

export async function setHomeThread(ref: ScopedThreadRef, home: boolean): Promise<void> {
  const key = scopedThreadKey(ref);
  try {
    await persistClientSettingsUpdate((current) => ({
      ...current,
      // Unsetting only clears this thread, never one another device chose meanwhile.
      forkHomeThread: home ? key : current.forkHomeThread === key ? null : current.forkHomeThread,
    }));
  } catch (error) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: home ? "Could not set the home thread" : "Could not unset the home thread",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  }
}
