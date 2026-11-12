import { type EnvironmentId, type ForkExtensionsSnapshot, WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcStreamCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import {
  EMPTY_HEALTH_PROGRESS,
  type ForkHealthProgress,
  type HealthDecision,
  isForkHealthRunning,
  nextHealthDecision,
  reduceHealthEvent,
} from "../components/settings/ForkExtensions.logic";
import { connectionAtomRuntime } from "../connection/runtime";

const forkExtensionsSnapshot = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:fork-extensions:snapshot",
  tag: WS_METHODS.forkExtensionsSnapshot,
  staleTimeMs: 30_000,
  idleTtlMs: 5 * 60_000,
});

export const forkExtensionsSnapshotAtom = (environmentId: EnvironmentId) =>
  forkExtensionsSnapshot({ environmentId, input: {} });

/**
 * Reading it runs a health check on that machine; the server shares a run already in progress.
 * Values accumulate into a `ForkHealthProgress`, and the stream ends with the `done` event.
 * Refresh the atom to check again.
 */
const forkExtensionsHealth = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:fork-extensions:health",
  tag: WS_METHODS.forkExtensionsCheckHealth,
  // Outlives a re-keyed machine list, so adding a machine does not restart the others' checks.
  idleTtlMs: 60_000,
  transform: (stream) =>
    stream.pipe(
      Stream.scan(() => EMPTY_HEALTH_PROGRESS, reduceHealthEvent),
      Stream.takeUntil((progress) => progress.checkedAt !== null),
    ),
});

const forkExtensionsHealthAtom = (environmentId: EnvironmentId) =>
  forkExtensionsHealth({ environmentId, input: {} });

export interface ForkMachineHealth {
  readonly decision: HealthDecision;
  /** null until a check starts on this machine. */
  readonly result: AsyncResult.AsyncResult<ForkHealthProgress, unknown> | null;
  /** The finished check whose snapshot refetch was already asked for. */
  readonly refreshedFor: string | null;
}

/** Sources are parameters so tests can stand in for the RPC atoms. */
export function makeForkMachineHealth(sources: {
  readonly snapshot: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<ForkExtensionsSnapshot, unknown>>;
  readonly health: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<ForkHealthProgress, unknown>>;
  readonly now: () => number;
}) {
  /** Set by "Check status"; dropped with the page, like the decision that reads it. */
  const wanted = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(false).pipe(Atom.withLabel(`web-fork-extensions-health-wanted:${environmentId}`)),
  );

  /**
   * Health of one machine while the page is open: the first snapshot decides whether opening the
   * page checks it (spec §7.2). The atom is dropped with its last reader, so each visit decides
   * again.
   */
  const machineHealth = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): ForkMachineHealth => {
      const previous = Option.getOrNull(get.self<ForkMachineHealth>());
      const isWanted = get(wanted(environmentId));
      const snapshot =
        isWanted || previous?.decision.decided === true
          ? null
          : AsyncResult.getOrElse(get(sources.snapshot(environmentId)), () => null);
      const decision = nextHealthDecision(previous?.decision ?? null, {
        wanted: isWanted,
        snapshot,
        nowMs: sources.now(),
      });
      const result = decision.active ? get(sources.health(environmentId)) : null;
      const checkedAt =
        result === null ? null : (AsyncResult.getOrElse(result, () => null)?.checkedAt ?? null);
      const refreshedFor = previous?.refreshedFor ?? null;
      if (checkedAt !== null && checkedAt !== refreshedFor) {
        // The server cached the check: refetch the snapshot so the cached one carries its time
        // (a later visit then skips the check) and its canonical cell states replace the overlay.
        // Deferred: this builds while React renders, and a refresh would re-render other readers.
        const registry = get.registry;
        queueMicrotask(() => registry.refresh(sources.snapshot(environmentId)));
      }
      return { decision, result, refreshedFor: checkedAt ?? refreshedFor };
    }).pipe(Atom.withLabel(`web-fork-extensions-machine-health:${environmentId}`)),
  );

  /** "Check status" on one machine: starts a check, or runs a finished one again. */
  const request = (registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId): void => {
    const current = registry.get(machineHealth(environmentId));
    if (!current.decision.active) {
      registry.set(wanted(environmentId), true);
    } else if (!isForkHealthRunning(current.result)) {
      registry.refresh(sources.health(environmentId));
    }
  };

  return { machineHealth, request };
}

const machineHealth = makeForkMachineHealth({
  snapshot: forkExtensionsSnapshotAtom,
  health: forkExtensionsHealthAtom,
  now: Date.now,
});

export const forkExtensionsMachineHealth = machineHealth.machineHealth;
export const requestForkHealthCheck = machineHealth.request;

/** Every write changes what the machine's snapshot shows. */
const refreshSnapshot = (
  target: { readonly environmentId: EnvironmentId },
  registry: AtomRegistry.AtomRegistry,
) => Effect.sync(() => registry.refresh(forkExtensionsSnapshotAtom(target.environmentId)));

export const forkExtensionsInspectSource = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:fork-extensions:inspect-source",
  tag: WS_METHODS.forkExtensionsInspectSource,
});

/** Results decide success by `ok`; `ok` with a `problem` is a success with a warning. */
export const forkExtensionsInstall = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:fork-extensions:install",
  tag: WS_METHODS.forkExtensionsInstall,
  onSettled: refreshSnapshot,
});

export const forkExtensionsUninstall = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:fork-extensions:uninstall",
  tag: WS_METHODS.forkExtensionsUninstall,
  onSettled: refreshSnapshot,
});

export const forkExtensionsSetEnabled = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:fork-extensions:set-enabled",
  tag: WS_METHODS.forkExtensionsSetEnabled,
  onSettled: refreshSnapshot,
});

export const forkExtensionsAuthorizeComplete = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:fork-extensions:authorize-complete",
  tag: WS_METHODS.forkExtensionsAuthorizeComplete,
});

/**
 * Runs one login: input `{ payload: { itemId, agent }, onEvent }`. `onEvent` gets `authUrl`
 * (open it, then send the pasted address with `forkExtensionsAuthorizeComplete`), then `done` or
 * `failed`; the command resolves with the last event. A stream command, not a subscription, so a
 * reconnect never starts a second login.
 */
export const forkExtensionsAuthorize = createEnvironmentRpcStreamCommand(connectionAtomRuntime, {
  label: "environment-data:fork-extensions:authorize",
  tag: WS_METHODS.forkExtensionsAuthorize,
  onSettled: refreshSnapshot,
});
