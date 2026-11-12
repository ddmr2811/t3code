import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useContext } from "react";

import { environmentAtomList, environmentIdsKey } from "../../state/environmentAtomList";
import { useEnvironmentIdentities, useEnvironments } from "../../state/environments";
import {
  forkExtensionsMachineHealth,
  forkExtensionsSnapshotAtom,
  requestForkHealthCheck,
} from "../../state/forkExtensions";
import { formatEnvironmentQueryError } from "../../state/query";
import { environmentSessionStatesAtom } from "../../state/session";
import {
  applyHealthProgress,
  classifyMachineSupport,
  isForkHealthRunning,
  type MachineState,
} from "./ForkExtensions.logic";
import { resolveRemoteOperateAccess } from "./ProviderSettingsPanel.logic";
import { useSettingsScope } from "./SettingsScopeContext";

// Only machines that can answer are listed, so the others never get the RPC (spec §6.5).
const snapshotsAtom = environmentAtomList(
  "web-fork-extensions-snapshots",
  forkExtensionsSnapshotAtom,
);
const healthAtom = environmentAtomList("web-fork-extensions-health", forkExtensionsMachineHealth);

export interface ForkExtensionsView {
  /** In settings-scope order; unsupported machines carry no snapshot. */
  readonly machines: ReadonlyArray<MachineState>;
  /** Refetches the snapshot of one machine, or of every supported one. */
  readonly refresh: (environmentId?: EnvironmentId) => void;
  /** "Check status": one machine, or every supported one. */
  readonly checkHealth: (environmentId?: EnvironmentId) => void;
}

export function useForkExtensions(): ForkExtensionsView {
  const registry = useContext(RegistryContext);
  const { scope } = useSettingsScope();
  const identities = useEnvironmentIdentities();
  const { presentationById } = useEnvironments();
  const inScope = new Set(scope.environmentIds);
  const listed = identities.filter((identity) => inScope.has(identity.environmentId));
  const sessions = useAtomValue(
    environmentSessionStatesAtom(environmentIdsKey(listed.map((entry) => entry.environmentId))),
  );

  const classified = listed.map((identity, index) => {
    const presentation = presentationById.get(identity.environmentId);
    const session = sessions[index]!;
    // Installs and toggles need the same grant as provider settings; reading needs none of it.
    const operateAccess = resolveRemoteOperateAccess({
      session: AsyncResult.getOrElse(session, () => null),
      isPending: session.waiting || session._tag === "Initial",
      hasError: session._tag === "Failure",
    });
    return {
      identity,
      ...classifyMachineSupport({
        connectionPhase: presentation?.connection.phase ?? "offline",
        hasServerConfig: presentation?.serverConfig != null,
        forkExtensionsVersion: presentation?.serverConfig?.environment.capabilities.forkExtensions,
        operateAccess,
      }),
    };
  });
  const supportedIds = classified
    .filter((entry) => entry.support === "supported")
    .map((entry) => entry.identity.environmentId);
  const supportedKey = environmentIdsKey(supportedIds);
  const snapshots = useAtomValue(snapshotsAtom(supportedKey));
  const health = useAtomValue(healthAtom(supportedKey));

  const machines = classified.map(({ identity, support, isPending, canOperate }): MachineState => {
    const base = {
      environmentId: identity.environmentId,
      label: identity.label,
      support,
      canOperate,
    };
    const index = supportedIds.indexOf(identity.environmentId);
    if (index === -1) {
      return {
        ...base,
        snapshot: null,
        error: null,
        isPending,
        isCheckingHealth: false,
        healthError: null,
      };
    }
    const result = snapshots[index]!;
    const healthResult = health[index]!.result;
    const snapshot = AsyncResult.getOrElse(result, () => null);
    return {
      ...base,
      snapshot:
        snapshot === null
          ? null
          : applyHealthProgress(
              snapshot,
              healthResult === null ? null : AsyncResult.getOrElse(healthResult, () => null),
            ),
      error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
      // A background refetch keeps showing the snapshot it already has.
      isPending: snapshot === null && (result.waiting || result._tag === "Initial"),
      isCheckingHealth: isForkHealthRunning(healthResult),
      healthError:
        healthResult?._tag === "Failure" ? formatEnvironmentQueryError(healthResult.cause) : null,
    };
  });

  const targets = (environmentId?: EnvironmentId) =>
    environmentId === undefined
      ? supportedIds
      : supportedIds.filter((candidate) => candidate === environmentId);
  return {
    machines,
    refresh: (environmentId) => {
      for (const id of targets(environmentId)) registry.refresh(forkExtensionsSnapshotAtom(id));
    },
    checkHealth: (environmentId) => {
      for (const id of targets(environmentId)) requestForkHealthCheck(registry, id);
    },
  };
}
