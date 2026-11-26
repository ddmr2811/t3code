import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type ForkBot,
  type ForkBotHandoff,
  type ForkBotProposal,
  type ForkGap,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { Atom, type AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime, environmentCatalog } from "../connection/runtime.ts";
import { lacksMethod } from "./bots.logic.ts";

export interface BotLoadError {
  readonly environmentId: EnvironmentId;
  readonly message: string;
}

export const forkBotsListQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "ade:fork-bots:list",
  tag: WS_METHODS.forkBotsList,
  staleTimeMs: 15_000,
  idleTtlMs: 60_000,
  // A coordinator proposes from its nightly pass, with no ADE action to refresh after.
  refreshIntervalMs: 60_000,
});

export const forkBotsUpsertCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "ade:fork-bots:upsert",
  tag: WS_METHODS.forkBotsUpsert,
});

export const forkBotsDraftCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "ade:fork-bots:draft",
  tag: WS_METHODS.forkBotsDraft,
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

export const forkBotsHandoffCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "ade:fork-bots:handoff",
  tag: WS_METHODS.forkBotsHandoff,
});

export const forkBotsDismissHandoffCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "ade:fork-bots:dismiss-handoff",
  tag: WS_METHODS.forkBotsDismissHandoff,
});

export const forkBotsAnswerProposalCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "ade:fork-bots:answer-proposal",
  tag: WS_METHODS.forkBotsAnswerProposal,
});

export const forkGapsListQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "ade:fork-gaps:list",
  tag: WS_METHODS.forkGapsList,
  staleTimeMs: 15_000,
  idleTtlMs: 60_000,
  // A bot asks for an install from its own turn, with no ADE action to refresh after.
  refreshIntervalMs: 60_000,
});

export const forkGapsAnswerInstallCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "ade:fork-gaps:answer-install",
  tag: WS_METHODS.forkGapsAnswerInstall,
});

export const forkMemoryListQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "ade:fork-memory:list",
  tag: WS_METHODS.forkMemoryList,
  staleTimeMs: 15_000,
  idleTtlMs: 60_000,
  // The coordinator saves from its own turn, with no ADE action to refresh after.
  refreshIntervalMs: 15_000,
});

export const forkMemoryUpsertCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "ade:fork-memory:upsert",
  tag: WS_METHODS.forkMemoryUpsert,
});

export const forkMemoryRemoveCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "ade:fork-memory:remove",
  tag: WS_METHODS.forkMemoryRemove,
});

export const forkMemoryCorrectCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "ade:fork-memory:correct",
  tag: WS_METHODS.forkMemoryCorrect,
});

export const forkMemoryRestoreCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "ade:fork-memory:restore",
  tag: WS_METHODS.forkMemoryRestore,
});

export function refreshBots(registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) {
  registry.refresh(forkBotsListQuery({ environmentId, input: {} }));
  registry.refresh(forkGapsListQuery({ environmentId, input: {} }));
}

export const allBotsAtom = Atom.make((get) => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  const byEnv = new Map<EnvironmentId, ReadonlyArray<ForkBot>>();
  const handoffsByEnv = new Map<EnvironmentId, ReadonlyArray<ForkBotHandoff>>();
  const proposalsByEnv = new Map<EnvironmentId, ReadonlyArray<ForkBotProposal>>();
  const gapsByEnv = new Map<EnvironmentId, ReadonlyArray<ForkGap>>();
  const errors: BotLoadError[] = [];
  /** Machines whose pending installs could not be read, so the tray can say so. */
  const gapErrors: EnvironmentId[] = [];

  for (const environmentId of enabledEnvironmentIds(catalog)) {
    const result = get(forkBotsListQuery({ environmentId, input: {} }));
    if (result._tag === "Failure") {
      const detail = errorDisplayMessage(Cause.squash(result.cause));
      errors.push({
        environmentId,
        message: detail ?? "No se pudo leer el directorio de bots.",
      });
    }
    if (result._tag === "Success") {
      byEnv.set(environmentId, result.value.bots);
      handoffsByEnv.set(environmentId, result.value.handoffs);
      proposalsByEnv.set(environmentId, result.value.proposals);
    }
    const gaps = get(forkGapsListQuery({ environmentId, input: {} }));
    if (gaps._tag === "Success") gapsByEnv.set(environmentId, gaps.value.gaps);
    if (gaps._tag === "Failure" && !lacksMethod(gaps.cause, WS_METHODS.forkGapsList)) {
      gapErrors.push(environmentId);
    }
  }

  return { byEnv, handoffsByEnv, proposalsByEnv, gapsByEnv, errors, gapErrors };
}).pipe(Atom.withLabel("ade-all-bots"));
