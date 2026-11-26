import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type ForkIntegrationApp,
  type ForkIntegrationLevel,
  type ForkIntegrationRequest,
  WS_METHODS,
} from "@t3tools/contracts";
import { Atom, type AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime, environmentCatalog } from "../connection/runtime.ts";

export const INTEGRATION_APP_LABELS: Record<ForkIntegrationApp, string> = { github: "GitHub" };

/** A group's name on a bot's card. A group missing here would show its raw id. */
export const INTEGRATION_GROUP_LABELS: Record<string, string> = {
  read: "Leer issues, PR y código",
  comment: "Comentar y abrir issues",
  "branch-pr": "Ramas y pull requests",
  "merge-delete": "Fusionar, borrar y cerrar",
};

export const INTEGRATION_LEVEL_LABELS: Record<ForkIntegrationLevel, string> = {
  deny: "No puede",
  ask: "Me pregunta antes",
  allow: "Sin preguntar",
};

/** Groups whose every action waits for the user, so «Sin preguntar» is not offered. */
export const ALWAYS_ASK_GROUPS: ReadonlySet<string> = new Set(["merge-delete"]);

export const forkIntegrationsListQuery = createEnvironmentRpcQueryAtomFamily(
  connectionAtomRuntime,
  {
    label: "ade:fork-integrations:list",
    tag: WS_METHODS.forkIntegrationsList,
    staleTimeMs: 15_000,
    idleTtlMs: 60_000,
    // A bot asks from its own turn, with no ADE action to refresh after.
    refreshIntervalMs: 30_000,
  },
);

export const forkIntegrationsConnectCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "ade:fork-integrations:connect",
  tag: WS_METHODS.forkIntegrationsConnect,
});

export const forkIntegrationsAnswerCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "ade:fork-integrations:answer",
  tag: WS_METHODS.forkIntegrationsAnswer,
});

export function refreshIntegrations(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
) {
  registry.refresh(forkIntegrationsListQuery({ environmentId, input: {} }));
}

/** The requests waiting for the user on every machine. A machine that fails to answer has none. */
export const pendingIntegrationRequestsAtom = Atom.make((get) => {
  const pending: Array<{ environmentId: EnvironmentId; request: ForkIntegrationRequest }> = [];
  for (const environmentId of enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))) {
    const result = get(forkIntegrationsListQuery({ environmentId, input: {} }));
    if (result._tag !== "Success") continue;
    for (const request of result.value.requests) {
      if (request.status === "pending") pending.push({ environmentId, request });
    }
  }
  return pending;
}).pipe(Atom.withLabel("ade-pending-integration-requests"));
