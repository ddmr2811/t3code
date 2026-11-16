// Fork-only: whether the home thread's environment can tell yet if the thread is there.
import { useAtomValue } from "@effect/atom-react";
import {
  AVAILABLE_CONNECTION_STATE,
  connectionProjectionPhase,
} from "@t3tools/client-runtime/connection";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { catalogIsComplete, environmentShell, expectsPrimaryEnvironment } from "../state/shell";
import type { HomeEnvironmentState } from "./homeThread.logic";

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
