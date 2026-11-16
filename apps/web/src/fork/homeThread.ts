// Fork-only: whether the home thread's environment can tell yet if the thread is there.
import { useAtomValue } from "@effect/atom-react";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { catalogIsComplete, environmentShell, expectsPrimaryEnvironment } from "../state/shell";
import { type HomeEnvironmentState, homeEnvironmentState } from "./homeThread.logic";

const NO_ENVIRONMENT_ATOM = Atom.make<HomeEnvironmentState>("unavailable").pipe(
  Atom.withLabel("fork-home-thread-environment:none"),
);

const homeEnvironmentStateAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): HomeEnvironmentState => {
    const catalog = get(environmentCatalog.catalogValueAtom);
    const shell = get(environmentShell.stateValueAtom(environmentId));
    return homeEnvironmentState({
      enabled: [...enabledEnvironmentIds(catalog)].includes(environmentId),
      catalogComplete: catalogIsComplete(catalog, expectsPrimaryEnvironment()),
      shellStatus: shell.status,
      hasSnapshot: Option.isSome(shell.snapshot),
      connection: Option.getOrNull(
        AsyncResult.value(get(environmentCatalog.stateAtom(environmentId))),
      ),
    });
  }).pipe(Atom.withLabel(`fork-home-thread-environment:${environmentId}`)),
);

export function useHomeEnvironmentState(environmentId: EnvironmentId | null): HomeEnvironmentState {
  return useAtomValue(
    environmentId === null ? NO_ENVIRONMENT_ATOM : homeEnvironmentStateAtom(environmentId),
  );
}
