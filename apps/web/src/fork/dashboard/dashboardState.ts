// Fork-only: the Dashboard's per-machine queries. The Dashboard refreshes them while its tab is
// visible (visibleInterval.ts); an atom interval would keep running in a hidden tab.
import { request } from "@t3tools/client-runtime/rpc";
import {
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, type HostResourcesSnapshot, WS_METHODS } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { connectionAtomRuntime } from "../../connection/runtime";
import { nextRoundTrips } from "./dashboard.logic";

interface HostProbe {
  readonly host: HostResourcesSnapshot;
  readonly roundTrips: ReadonlyArray<number>;
  /** The latency: the fastest recent round trip. */
  readonly roundTripMs: number;
}

/**
 * The machine's load, read from the sample the server already keeps for load balancing. Timing
 * that same request gives the round trip over the connection the app already holds, so the
 * latency costs no extra request. Polled faster than the server's 5 s sample cache so every
 * window holds a cached answer, whose time is the network alone.
 */
const hostProbe = createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:fork-dashboard:host-probe",
  idleTtlMs: 0,
  staleTimeMs: 2_000,
  execute: (
    input: Record<string, never>,
    _emit: (value: HostProbe) => Effect.Effect<void>,
    previous: Option.Option<HostProbe>,
  ) =>
    request(WS_METHODS.serverGetHostResources, input).pipe(
      Effect.timeout("5 seconds"),
      Effect.timed,
      Effect.map(([elapsed, host]): HostProbe => {
        const roundTrips = nextRoundTrips(
          Option.match(previous, { onNone: () => [], onSome: (value) => value.roundTrips }),
          Duration.toMillis(elapsed),
        );
        return { host, roundTrips, roundTripMs: Math.min(...roundTrips) };
      }),
    ),
});

export const HOST_PROBE_INTERVAL_MS = 2_500;
export const TAILNET_INTERVAL_MS = 15_000;
export const LATENCY_INTERVAL_MS = 3_000;
export const NODE_EXPORTER_INTERVAL_MS = 3_000;

/** Fork servers stream a fresh sample about every second while someone listens. */
const hostStream = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:fork-dashboard:host-stream",
  tag: WS_METHODS.forkMachinesHostResources,
  idleTtlMs: 0,
});

export const dashboardHostStream = (environmentId: EnvironmentId) =>
  hostStream({ environmentId, input: {} });

/**
 * The round trip of an empty request over the connection the stream already holds: the
 * latency, without waiting on the server's own work.
 */
const latencyProbe = createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:fork-dashboard:latency",
  idleTtlMs: 0,
  staleTimeMs: 1_000,
  execute: (
    input: Record<string, never>,
    _emit: (value: ReadonlyArray<number>) => Effect.Effect<void>,
    previous: Option.Option<ReadonlyArray<number>>,
  ) =>
    request(WS_METHODS.serverProbe, input).pipe(
      Effect.timeout("5 seconds"),
      Effect.timed,
      Effect.map(([elapsed]) =>
        nextRoundTrips(
          Option.getOrElse(previous, (): ReadonlyArray<number> => []),
          Duration.toMillis(elapsed),
        ),
      ),
    ),
});

export const dashboardLatency = (environmentId: EnvironmentId) =>
  latencyProbe({ environmentId, input: {} });

const nodeExporters = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:fork-dashboard:node-exporters",
  tag: WS_METHODS.forkMachinesNodeExporters,
  idleTtlMs: 0,
  staleTimeMs: 2_000,
});

export const dashboardNodeExporters = (environmentId: EnvironmentId) =>
  nodeExporters({ environmentId, input: {} });

export const dashboardHostProbe = (environmentId: EnvironmentId) =>
  hostProbe({ environmentId, input: {} });

const tailnetStatus = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:fork-dashboard:tailnet",
  tag: WS_METHODS.forkTailnetStatus,
  idleTtlMs: 0,
  staleTimeMs: 30_000,
});

/** Only the source machine pings; every candidate also answers who it is and whether it can read. */
export const dashboardTailnetStatus = (environmentId: EnvironmentId, ping: boolean) =>
  tailnetStatus({ environmentId, input: { ping } });
