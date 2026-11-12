import {
  AuthProvidersManageScope,
  EnvironmentId,
  type ForkExtensionsSnapshot,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_HEALTH_PROGRESS,
  type ForkHealthProgress,
} from "../components/settings/ForkExtensions.logic";

import {
  forkExtensionsAuthorize,
  forkExtensionsAuthorizeComplete,
  forkExtensionsInspectSource,
  forkExtensionsInstall,
  forkExtensionsSetEnabled,
  forkExtensionsUninstall,
  makeForkMachineHealth,
} from "./forkExtensions";

it("guards every write on the client, and lets anyone with read inspect a paste", () => {
  for (const command of [
    forkExtensionsInstall,
    forkExtensionsUninstall,
    forkExtensionsSetEnabled,
    forkExtensionsAuthorize,
    forkExtensionsAuthorizeComplete,
  ]) {
    expect(command.requiredScopes(), command.label).toEqual([AuthProvidersManageScope]);
  }
  expect(forkExtensionsInspectSource.requiredScopes()).toEqual([]);
});

describe("forkExtensionsMachineHealth", () => {
  const PC = EnvironmentId.make("env-pc");
  const checkedAt = "2026-11-12T10:00:00.000Z";
  const snapshotAt = (healthCheckedAt: string | null): ForkExtensionsSnapshot => ({
    protocolVersion: 1,
    agents: [{ agent: "claude", available: true }],
    projects: [],
    items: [],
    healthCheckedAt,
  });

  it("refetches the snapshot when a check finishes, so a later visit does not check again", async () => {
    const tasks: Array<() => void> = [];
    const registry = AtomRegistry.make({
      scheduleTask: (task) => {
        tasks.push(task);
        return () => {};
      },
    });
    // The server's answer; the cached query only rereads it when refreshed.
    let served = snapshotAt(null);
    let snapshotReads = 0;
    const snapshot = Atom.readable(() => {
      snapshotReads += 1;
      return AsyncResult.success(served);
    }).pipe(Atom.keepAlive);
    // The subscription: dropped once unread, as after its idle TTL.
    const progress = Atom.make(
      AsyncResult.success<ForkHealthProgress>(EMPTY_HEALTH_PROGRESS, { waiting: true }),
    ).pipe(Atom.keepAlive);
    let checksStarted = 0;
    const health = Atom.make((get) => {
      if (Option.isNone(get.self())) checksStarted += 1;
      return get(progress);
    });
    const { machineHealth } = makeForkMachineHealth({
      snapshot: () => snapshot,
      health: () => health,
      now: () => Date.parse(checkedAt) + 2 * 60_000,
    });

    let unmount = registry.mount(machineHealth(PC));
    expect(registry.get(machineHealth(PC)).decision).toEqual({ decided: true, active: true });
    expect(checksStarted).toBe(1);

    served = snapshotAt(checkedAt);
    registry.set(progress, AsyncResult.success({ cells: [], checkedAt }));
    expect(registry.get(machineHealth(PC)).result).not.toBeNull();
    await Promise.resolve();
    expect(registry.get(snapshot).value).toEqual(snapshotAt(checkedAt));
    expect(snapshotReads).toBe(2);

    unmount();
    for (const task of tasks.splice(0)) task();
    unmount = registry.mount(machineHealth(PC));
    expect(registry.get(machineHealth(PC)).decision).toEqual({ decided: true, active: false });
    expect(checksStarted).toBe(1);
    unmount();
    registry.dispose();
  });
});
