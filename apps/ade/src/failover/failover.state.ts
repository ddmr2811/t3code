import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, type ForkFailoverState, WS_METHODS } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime, environmentCatalog } from "../connection/runtime.ts";

export interface FailoverLoadError {
  readonly environmentId: EnvironmentId;
  readonly message: string;
}

export const forkFailoverGetStateQuery = createEnvironmentRpcQueryAtomFamily(
  connectionAtomRuntime,
  {
    label: "ade:fork-failover:get-state",
    tag: WS_METHODS.forkFailoverGetState,
    staleTimeMs: 15_000,
    idleTtlMs: 60_000,
  },
);

export const forkFailoverSetConfigCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "ade:fork-failover:set-config",
  tag: WS_METHODS.forkFailoverSetConfig,
});

export const forkFailoverSwitchThreadCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "ade:fork-failover:switch-thread",
  tag: WS_METHODS.forkFailoverSwitchThread,
});

export function refreshFailoverState(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
) {
  registry.refresh(forkFailoverGetStateQuery({ environmentId, input: {} }));
}

export const allFailoverStatesAtom = Atom.make((get) => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  const byEnv = new Map<EnvironmentId, ForkFailoverState | null>();
  const errors: FailoverLoadError[] = [];
  let loadingCount = 0;

  for (const environmentId of enabledEnvironmentIds(catalog)) {
    const result = get(forkFailoverGetStateQuery({ environmentId, input: {} }));
    if (result._tag === "Initial") loadingCount += 1;
    if (result._tag === "Failure") {
      const detail = errorDisplayMessage(Cause.squash(result.cause));
      errors.push({
        environmentId,
        message: detail ?? "No se pudo leer la configuración de respaldo.",
      });
    }
    byEnv.set(
      environmentId,
      AsyncResult.getOrElse(result, () => null),
    );
  }

  return { byEnv, loadingCount, errors };
}).pipe(Atom.withLabel("ade-all-failover-states"));
