// Fork-only: the Dashboard's per-machine queries. Both poll only while the Dashboard reads them.
import { request } from "@t3tools/client-runtime/rpc";
import {
  createEnvironmentQueryAtomFamily,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "../../connection/runtime";

/**
 * The machine's load, read from the sample the server already keeps for load balancing. Timing
 * that same request gives the round trip over the connection the app already holds, so the
 * latency costs no extra request.
 */
const hostProbe = createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:fork-dashboard:host-probe",
  idleTtlMs: 0,
  staleTimeMs: 4_000,
  refreshIntervalMs: 5_000,
  execute: (input: Record<string, never>) =>
    request(WS_METHODS.serverGetHostResources, input).pipe(
      Effect.timeout("5 seconds"),
      Effect.timed,
      Effect.map(([elapsed, host]) => ({
        host,
        roundTripMs: Math.round(Duration.toMillis(elapsed)),
      })),
    ),
});

export const dashboardHostProbe = (environmentId: EnvironmentId) =>
  hostProbe({ environmentId, input: {} });

const tailnetStatus = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:fork-dashboard:tailnet",
  tag: WS_METHODS.forkTailnetStatus,
  idleTtlMs: 0,
  staleTimeMs: 30_000,
  refreshIntervalMs: 45_000,
});

/** Only the source machine pings; the others answer who they are on the tailnet. */
export const dashboardTailnetStatus = (environmentId: EnvironmentId, ping: boolean) =>
  tailnetStatus({ environmentId, input: { ping } });
