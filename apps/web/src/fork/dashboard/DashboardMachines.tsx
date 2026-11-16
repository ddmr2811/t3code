// Fork-only: the Dashboard's machines, as a map around this client, and the tailnet's other machines.
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";
import {
  AuthDiagnosticsReadScope,
  type EnvironmentId,
  type ForkNodeExporterReading,
  type ForkTailnetPeer,
  type ForkTailnetStatus,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { MonitorIcon } from "lucide-react";
import { Fragment, type ReactNode, useContext } from "react";

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
  exporterEnvironments,
  type MachineLoad,
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
  dashboardHostStream,
  dashboardLatency,
  dashboardNodeExporters,
  dashboardTailnetStatus,
  LATENCY_INTERVAL_MS,
  NODE_EXPORTER_INTERVAL_MS,
  HOST_PROBE_INTERVAL_MS,
  TAILNET_INTERVAL_MS,
} from "./dashboardState";
import { usePageVisible } from "./pageVisible";
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

interface MachineCardViewProps {
  readonly label: string;
  readonly connected: boolean;
  readonly load: MachineLoad;
  /** "56 ms", "…" while it is measured, or null when the machine is offline. */
  readonly latency: string | null;
  /** Dims a sample the last refresh could not renew. */
  readonly stale: boolean;
  /** Takes the meters' place when the machine cannot be read. */
  readonly problem: string | null;
  /** What reports the machine when it is not T3 Code, such as "node_exporter". */
  readonly source?: string;
}

function MachineCardView(props: MachineCardViewProps) {
  const { load } = props;
  const specs = [
    load.cores === null ? null : `${load.cores} cores`,
    load.totalMemoryBytes === null ? null : formatBytes(load.totalMemoryBytes),
  ].filter((value) => value !== null);
  return (
    <article
      aria-label={props.label}
      className={cn(
        "flex min-w-0 flex-col gap-1.5 rounded-md border bg-card px-3 py-2.5",
        (props.stale || !props.connected) && "opacity-60",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <StatusDot tone={props.connected ? "online" : "offline"} />
        <span className="min-w-0 flex-1 truncate font-medium text-sm">{props.label}</span>
        {props.source ? (
          <span className="shrink-0 font-mono text-2xs text-muted-foreground">{props.source}</span>
        ) : null}
        <span className="shrink-0 font-mono text-2xs text-muted-foreground tabular-nums">
          {props.latency ?? "offline"}
        </span>
      </div>
      {props.problem !== null ? (
        <span className="truncate text-muted-foreground text-xs">{props.problem}</span>
      ) : (
        <div className="flex flex-col gap-1">
          <Meter label="CPU" share={load.cpuShare} />
          <Meter label="MEM" share={load.memoryShare} />
        </div>
      )}
      <span className="truncate font-mono text-2xs text-muted-foreground">
        {specs.length > 0 ? specs.join(" · ") : props.connected ? "…" : "Not connected"}
      </span>
    </article>
  );
}

/** A fork server streams its load about every second; the latency is a probe on that socket. */
function LiveMachineCard({ environment }: { readonly environment: DashboardEnvironment }) {
  const pageVisible = usePageVisible();
  const stream = useEnvironmentQuery(
    environment.connected && pageVisible ? dashboardHostStream(environment.environmentId) : null,
  );
  const latency = useEnvironmentQuery(
    environment.connected ? dashboardLatency(environment.environmentId) : null,
  );
  useVisibleInterval(latency.refresh, LATENCY_INTERVAL_MS);
  const unreachable = environment.connected && stream.data === null && stream.error !== null;
  return (
    <MachineCardView
      label={environment.label}
      connected={environment.connected}
      load={machineLoad(stream.data)}
      latency={
        environment.connected ? (latency.data ? `${Math.min(...latency.data)} ms` : "…") : null
      }
      stale={stream.data !== null && stream.error !== null}
      problem={unreachable ? stream.error : null}
    />
  );
}

/** Older and upstream servers: the load sample the server keeps, read on a timer. */
function PolledMachineCard({ environment }: { readonly environment: DashboardEnvironment }) {
  const probe = useEnvironmentQuery(
    environment.connected ? dashboardHostProbe(environment.environmentId) : null,
  );
  useVisibleInterval(probe.refresh, HOST_PROBE_INTERVAL_MS);
  // A failed refresh keeps the last sample; dim it rather than pass it off as current.
  const unreachable = environment.connected && probe.data === null && probe.error !== null;
  return (
    <MachineCardView
      label={environment.label}
      connected={environment.connected}
      load={probe.data ? machineLoad(probe.data.host) : NO_LOAD}
      latency={environment.connected ? (probe.data ? `${probe.data.roundTripMs} ms` : "…") : null}
      stale={probe.data !== null && probe.error !== null}
      problem={unreachable ? probe.error : null}
    />
  );
}

function MachineCard({ environment }: { readonly environment: DashboardEnvironment }) {
  return environment.liveLoad ? (
    <LiveMachineCard environment={environment} />
  ) : (
    <PolledMachineCard environment={environment} />
  );
}

function ExporterCard({ reading }: { readonly reading: ForkNodeExporterReading }) {
  return (
    <MachineCardView
      label={reading.name}
      connected={reading.resources !== null}
      load={machineLoad(reading.resources)}
      latency={reading.latencyMs === null ? null : `${Math.round(reading.latencyMs)} ms`}
      stale={false}
      problem={reading.problem}
      source="node_exporter"
    />
  );
}

/** A wing of the map: each machine with its link to the hub drawn on the hub's side. */
function Wing(props: {
  readonly machines: ReadonlyArray<MachineEntry>;
  readonly side: "left" | "right";
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {props.machines.map((machine) => (
        <div
          key={machine.key}
          className={cn("flex items-center", props.side === "right" && "flex-row-reverse")}
        >
          <div className="min-w-0 flex-1">{machine.card}</div>
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
  /** node_exporter machines count as identified by their scrape host. */
  readonly exporters: ReadonlyArray<ForkNodeExporterReading>;
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
    environments: [...props.environments, ...exporterEnvironments(props.exporters)],
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

interface MachineEntry {
  readonly key: string;
  readonly card: ReactNode;
}

const nodeExporterReadingsAtom = Atom.family((key: string) =>
  Atom.make((get): ReadonlyArray<ForkNodeExporterReading> => {
    const seen = new Set<string>();
    const readings: ForkNodeExporterReading[] = [];
    for (const environmentId of JSON.parse(key) as ReadonlyArray<EnvironmentId>) {
      const status = AsyncResult.getOrElse(get(dashboardNodeExporters(environmentId)), () => null);
      for (const reading of status?.exporters ?? []) {
        // Two servers may read the same exporter; the first, nearest the user, counts.
        const id = `${reading.name}\u0000${reading.host}`;
        if (seen.has(id)) continue;
        seen.add(id);
        readings.push(reading);
      }
    }
    return readings;
  }).pipe(Atom.withLabel(`fork-dashboard:node-exporters:${key}`)),
);

/** The machines each fork server reads through a node_exporter, from every server that may. */
function useNodeExporters(
  environments: ReadonlyArray<DashboardEnvironment>,
): ReadonlyArray<ForkNodeExporterReading> {
  const registry = useContext(RegistryContext);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const canRead = useEnvironmentsWithScope(environments, AuthDiagnosticsReadScope);
  const sources = environments
    .filter((environment) => environment.liveLoad && canRead.has(environment.environmentId))
    .map((environment) => environment.environmentId)
    .toSorted(
      (left, right) =>
        Number(right === primaryEnvironmentId) - Number(left === primaryEnvironmentId),
    );
  const readings = useAtomValue(nodeExporterReadingsAtom(JSON.stringify(sources)));
  useVisibleInterval(() => {
    for (const environmentId of sources) registry.refresh(dashboardNodeExporters(environmentId));
  }, NODE_EXPORTER_INTERVAL_MS);
  return readings;
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
      .map(([environmentId, presentation]): TailnetEnvironment => {
        const connected = presentation.connection.phase === "connected";
        return {
          environmentId,
          label: presentation.entry.target.label,
          connected,
          liveLoad:
            connected &&
            (presentation.serverConfig?.environment.capabilities.forkMachines ?? 0) >= 1,
          hostname: presentation.serverConfig?.hostname ?? null,
          tailnetHosts: tailnetEndpointHosts(presentation.serverConfig?.directEndpoints),
        };
      }),
  );
  const exporters = useNodeExporters(environments);
  const machines: ReadonlyArray<MachineEntry> = [
    ...environments.map((environment) => ({
      key: environment.environmentId,
      card: <MachineCard environment={environment} />,
    })),
    ...exporters.map((reading) => ({
      key: `exporter:${reading.name}:${reading.host}`,
      card: <ExporterCard reading={reading} />,
    })),
  ];
  const tailnet = (
    <TailnetPeers
      environments={environments}
      exporters={exporters}
      presentations={presentations}
      nowMs={nowMs}
      compact={compact}
    />
  );
  if (compact) {
    return (
      <div className="@container flex flex-col gap-2 rounded-lg border p-2">
        <div className="grid grid-cols-1 gap-2 @xs:grid-cols-2">
          {machines.map((machine) => (
            <Fragment key={machine.key}>{machine.card}</Fragment>
          ))}
        </div>
        {tailnet}
      </div>
    );
  }
  const { left, right } = splitAroundHub(machines);

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
