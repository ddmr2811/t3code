// Fork-only: the Dashboard's machines, as a map around this client, and the tailnet's other machines.
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";
import {
  AuthDiagnosticsReadScope,
  type EnvironmentId,
  type ForkTailnetPeer,
  type ForkTailnetStatus,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { MonitorIcon } from "lucide-react";
import { useContext } from "react";

import { isElectron } from "../../env";
import { formatBytes } from "../../lib/formatBytes";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { environmentPresentations } from "../../state/presentation";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentsWithScope } from "../../state/session";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  type DashboardEnvironment,
  machineLoad,
  NO_LOAD,
  onlineSummary,
  orderMachines,
  pickTailnetSource,
  splitAroundHub,
  tailnetEndpointHosts,
  type TailnetEnvironment,
  tailnetOnlyPeers,
  type TailnetReading,
} from "./dashboard.logic";
import {
  dashboardHostProbe,
  dashboardTailnetStatus,
  HOST_PROBE_INTERVAL_MS,
  TAILNET_INTERVAL_MS,
} from "./dashboardState";
import { useVisibleInterval } from "./visibleInterval";

const BUSY_SHARE = 0.85;
const SATURATED_SHARE = 0.95;

const caption = "text-3xs font-medium uppercase tracking-widest text-muted-foreground";

function shareTone(share: number | null): string {
  if (share === null) return "bg-muted-foreground/40";
  if (share >= SATURATED_SHARE) return "bg-destructive";
  if (share >= BUSY_SHARE) return "bg-warning";
  return "bg-primary";
}

const percent = (share: number | null) => (share === null ? "–" : `${Math.round(share * 100)}%`);

/** A thin meter; its width changes per sample without a transition, so nothing repaints between. */
function Meter({ label, share }: { readonly label: string; readonly share: number | null }) {
  return (
    <div className="grid grid-cols-[2.25rem_minmax(2rem,1fr)_2.5rem] items-center gap-1.5 font-mono text-2xs tabular-nums">
      <span className="text-muted-foreground">{label}</span>
      <span className="h-1 overflow-hidden rounded-full bg-muted">
        <span
          className={cn("block h-full rounded-full", shareTone(share))}
          style={{ width: `${Math.round(Math.min(1, Math.max(0, share ?? 0)) * 100)}%` }}
        />
      </span>
      <span className="text-end">{percent(share)}</span>
    </div>
  );
}

function StatusDot({ tone }: { readonly tone: "online" | "offline" | "idle" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        tone === "online" && "bg-success",
        tone === "idle" && "bg-warning",
        tone === "offline" && "bg-muted-foreground/50",
      )}
    />
  );
}

function MachineCard({ environment }: { readonly environment: DashboardEnvironment }) {
  const probe = useEnvironmentQuery(
    environment.connected ? dashboardHostProbe(environment.environmentId) : null,
  );
  useVisibleInterval(probe.refresh, HOST_PROBE_INTERVAL_MS);
  const load = probe.data ? machineLoad(probe.data.host) : NO_LOAD;
  // A failed refresh keeps the last sample; dim it rather than pass it off as current.
  const stale = probe.data !== null && probe.error !== null;
  const unreachable = environment.connected && probe.data === null && probe.error !== null;
  const specs = [
    load.cores === null ? null : `${load.cores} cores`,
    load.totalMemoryBytes === null ? null : formatBytes(load.totalMemoryBytes),
  ].filter((value) => value !== null);

  return (
    <article
      aria-label={environment.label}
      className={cn(
        "flex min-w-0 flex-col gap-1.5 rounded-md border bg-card px-3 py-2.5",
        (stale || !environment.connected) && "opacity-60",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <StatusDot tone={environment.connected ? "online" : "offline"} />
        <span className="min-w-0 flex-1 truncate font-medium text-sm">{environment.label}</span>
        <span className="shrink-0 font-mono text-2xs text-muted-foreground tabular-nums">
          {environment.connected ? (probe.data ? `${probe.data.roundTripMs} ms` : "…") : "offline"}
        </span>
      </div>
      {unreachable ? (
        <span className="truncate text-muted-foreground text-xs">{probe.error}</span>
      ) : (
        <div className="flex flex-col gap-1">
          <Meter label="CPU" share={load.cpuShare} />
          <Meter label="MEM" share={load.memoryShare} />
        </div>
      )}
      <span className="truncate font-mono text-2xs text-muted-foreground">
        {specs.length > 0 ? specs.join(" · ") : environment.connected ? "…" : "Not connected"}
      </span>
    </article>
  );
}

/** A wing of the map: each machine with its link to the hub drawn on the hub's side. */
function Wing(props: {
  readonly machines: ReadonlyArray<DashboardEnvironment>;
  readonly side: "left" | "right";
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {props.machines.map((environment) => (
        <div
          key={environment.environmentId}
          className={cn("flex items-center", props.side === "right" && "flex-row-reverse")}
        >
          <div className="min-w-0 flex-1">
            <MachineCard environment={environment} />
          </div>
          <span aria-hidden className="hidden h-px w-6 shrink-0 bg-border lg:block" />
        </div>
      ))}
    </div>
  );
}

function Hub({ environments }: { readonly environments: ReadonlyArray<DashboardEnvironment> }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 rounded-md border border-primary/40 bg-card px-5 py-4 text-center lg:min-w-48">
      <MonitorIcon aria-hidden className="size-5 text-muted-foreground" />
      <span className="font-serif text-lg">This {isElectron ? "computer" : "browser"}</span>
      <span className="font-mono text-2xs text-muted-foreground">
        {onlineSummary(environments)}
      </span>
      <span className="text-2xs text-muted-foreground">Latency is measured from here</span>
    </div>
  );
}

const connectionLabel = (peer: ForkTailnetPeer) => {
  switch (peer.connection) {
    case "direct":
      return "direct";
    case "relay":
      return peer.relay ? `relay · ${peer.relay}` : "relay";
    case "idle":
      return "idle";
    case "offline":
      return "offline";
  }
};

function PeerCard({ peer, nowMs }: { readonly peer: ForkTailnetPeer; readonly nowMs: number }) {
  return (
    <article
      aria-label={peer.hostName}
      className={cn(
        "flex min-w-0 flex-col gap-1 rounded-md border border-dashed px-3 py-2",
        !peer.online && "opacity-60",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <StatusDot tone={peer.online ? "online" : "offline"} />
        <span className="min-w-0 flex-1 truncate font-medium text-sm">{peer.hostName}</span>
        <span className="shrink-0 font-mono text-2xs text-muted-foreground tabular-nums">
          {peer.latencyMs !== null ? `${Math.round(peer.latencyMs)} ms` : peer.online ? "–" : ""}
        </span>
      </div>
      <span className="truncate font-mono text-2xs text-muted-foreground">
        {[
          peer.os,
          connectionLabel(peer),
          peer.lastSeen ? `seen ${formatRelativeTimeLabel(peer.lastSeen, nowMs)}` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </span>
    </article>
  );
}

/** The Dashboard column's peer: its name and latency, in a row of chips. */
function PeerChip({ peer }: { readonly peer: ForkTailnetPeer }) {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 text-xs",
        !peer.online && "opacity-60",
      )}
    >
      <StatusDot tone={peer.online ? "online" : "offline"} />
      <span className="truncate">{peer.hostName}</span>
      {peer.latencyMs !== null ? (
        <span className="shrink-0 font-mono text-2xs text-muted-foreground tabular-nums">
          {Math.round(peer.latencyMs)} ms
        </span>
      ) : null}
    </span>
  );
}

const tailnetReadingsAtom = Atom.family((key: string) =>
  Atom.make((get): ReadonlyArray<TailnetReading> => {
    const targets = JSON.parse(key) as ReadonlyArray<{
      readonly environmentId: EnvironmentId;
      readonly ping: boolean;
    }>;
    return targets.map(({ environmentId, ping }) => ({
      environmentId,
      status: AsyncResult.getOrElse(
        get(dashboardTailnetStatus(environmentId, ping)),
        (): ForkTailnetStatus | null => null,
      ),
    }));
  }).pipe(Atom.withLabel(`fork-dashboard:tailnet:${key}`)),
);

function TailnetPeers(props: {
  readonly environments: ReadonlyArray<TailnetEnvironment>;
  readonly presentations: ReadonlyMap<EnvironmentId, EnvironmentPresentation>;
  readonly nowMs: number;
  readonly compact: boolean;
}) {
  const registry = useContext(RegistryContext);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const canRead = useEnvironmentsWithScope(props.environments, AuthDiagnosticsReadScope);
  const candidates = props.environments
    .filter(
      (environment) =>
        environment.connected &&
        (props.presentations.get(environment.environmentId)?.serverConfig?.environment.capabilities
          .forkTailnet ?? 0) >= 1 &&
        canRead.has(environment.environmentId),
    )
    .map((environment) => environment.environmentId);
  // Every candidate's plain reading: who it is on the tailnet, and whether it can read it at all.
  const targets = candidates.map((environmentId) => ({ environmentId, ping: false }));
  const readings = useAtomValue(tailnetReadingsAtom(JSON.stringify(targets)));
  const sourceEnvironmentId = pickTailnetSource(candidates, primaryEnvironmentId, readings);
  const pinged = useAtomValue(
    tailnetReadingsAtom(
      JSON.stringify(
        sourceEnvironmentId === null ? [] : [{ environmentId: sourceEnvironmentId, ping: true }],
      ),
    ),
  )[0]?.status;
  useVisibleInterval(() => {
    for (const target of targets) {
      registry.refresh(dashboardTailnetStatus(target.environmentId, false));
    }
    if (sourceEnvironmentId !== null) {
      registry.refresh(dashboardTailnetStatus(sourceEnvironmentId, true));
    }
  }, TAILNET_INTERVAL_MS);
  if (candidates.length === 0) return null;
  const plain = readings.find((reading) => reading.environmentId === sourceEnvironmentId)?.status;
  // The pinged reading adds latencies; until it answers, the plain one already lists the peers.
  const sourceStatus = pinged?.available ? pinged : (plain ?? null);
  const peers = tailnetOnlyPeers({
    source: sourceStatus,
    readings,
    environments: props.environments,
  });
  const view = peers === null ? null : { peers };
  const sourceLabel =
    sourceEnvironmentId === null
      ? null
      : (props.environments.find((environment) => environment.environmentId === sourceEnvironmentId)
          ?.label ?? "");
  // With no machine able to read the tailnet, say why the first one could not.
  const problem =
    sourceEnvironmentId === null
      ? (readings[0]?.status?.problem ?? "No data")
      : sourceStatus === null
        ? null
        : (sourceStatus.problem ?? "No data");

  return (
    <section
      aria-label="Tailnet machines without T3 Code"
      className={cn(
        "flex flex-col gap-2 rounded-md border border-dashed",
        props.compact ? "px-2.5 py-2" : "p-3",
      )}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className={caption}>Tailnet · without T3 Code</span>
        {sourceLabel !== null ? (
          <span className="font-mono text-2xs text-muted-foreground">via {sourceLabel}</span>
        ) : null}
        {view ? (
          <span className="ms-auto font-mono text-2xs text-muted-foreground">
            {view.peers.filter((peer) => peer.online).length} of {view.peers.length} online
          </span>
        ) : null}
      </div>
      {view === null ? (
        <p className="text-muted-foreground text-xs">{problem ?? "Reading the tailnet…"}</p>
      ) : view.peers.length === 0 ? (
        <p className="text-muted-foreground text-xs">Every machine on the tailnet runs T3 Code.</p>
      ) : props.compact ? (
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {view.peers.map((peer) => (
            <PeerChip key={peer.id} peer={peer} />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-2">
          {view.peers.map((peer) => (
            <PeerCard key={peer.id} peer={peer} nowMs={props.nowMs} />
          ))}
        </div>
      )}
    </section>
  );
}

/** `compact` is the Dashboard column beside a chat: a grid of machines, without the map. */
export function DashboardMachines({
  nowMs,
  compact = false,
}: {
  readonly nowMs: number;
  readonly compact?: boolean;
}) {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const environments = orderMachines(
    [...presentations]
      .filter(([, presentation]) => presentation.entry.enabled)
      .map(([environmentId, presentation]): TailnetEnvironment => ({
        environmentId,
        label: presentation.entry.target.label,
        connected: presentation.connection.phase === "connected",
        hostname: presentation.serverConfig?.hostname ?? null,
        tailnetHosts: tailnetEndpointHosts(presentation.serverConfig?.directEndpoints),
      })),
  );
  const tailnet = (
    <TailnetPeers
      environments={environments}
      presentations={presentations}
      nowMs={nowMs}
      compact={compact}
    />
  );
  if (compact) {
    return (
      <div className="flex flex-col gap-2 rounded-lg border p-2">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-2">
          {environments.map((environment) => (
            <MachineCard key={environment.environmentId} environment={environment} />
          ))}
        </div>
        {tailnet}
      </div>
    );
  }
  const { left, right } = splitAroundHub(environments);

  return (
    <div className="flex flex-col gap-3">
      <div className="grid items-center gap-2 rounded-lg border p-3 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] lg:gap-0">
        <div className="lg:order-2">
          <Hub environments={environments} />
        </div>
        <div className="lg:order-1">
          <Wing machines={left} side="left" />
        </div>
        <div className="lg:order-3">
          <Wing machines={right} side="right" />
        </div>
      </div>
      {tailnet}
    </div>
  );
}
