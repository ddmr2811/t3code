import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, type ForkBot, WS_METHODS } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { Atom, type AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime, environmentCatalog } from "../connection/runtime.ts";

export interface BotLoadError {
  readonly environmentId: EnvironmentId;
  readonly message: string;
}

export const forkBotsListQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "ade:fork-bots:list",
  tag: WS_METHODS.forkBotsList,
  staleTimeMs: 15_000,
  idleTtlMs: 60_000,
});

export const forkBotsUpsertCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "ade:fork-bots:upsert",
  tag: WS_METHODS.forkBotsUpsert,
});

export const forkBotsSetArchivedCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "ade:fork-bots:set-archived",
  tag: WS_METHODS.forkBotsSetArchived,
});

export const forkBotsRemoveCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "ade:fork-bots:remove",
  tag: WS_METHODS.forkBotsRemove,
});

export const forkBotsSendMessageCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "ade:fork-bots:send-message",
  tag: WS_METHODS.forkBotsSendMessage,
});

export function refreshBots(registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) {
  registry.refresh(forkBotsListQuery({ environmentId, input: {} }));
}

export const allBotsAtom = Atom.make((get) => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  const byEnv = new Map<EnvironmentId, ReadonlyArray<ForkBot>>();
  const errors: BotLoadError[] = [];

  for (const environmentId of enabledEnvironmentIds(catalog)) {
    const result = get(forkBotsListQuery({ environmentId, input: {} }));
    if (result._tag === "Failure") {
      const detail = errorDisplayMessage(Cause.squash(result.cause));
      errors.push({
        environmentId,
        message: detail ?? "No se pudo leer el directorio de bots.",
      });
    }
    if (result._tag === "Success") byEnv.set(environmentId, result.value.bots);
  }

  return { byEnv, errors };
}).pipe(Atom.withLabel("ade-all-bots"));
