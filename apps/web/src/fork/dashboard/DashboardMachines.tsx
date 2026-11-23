// Fork-only: the Dashboard's machines, as a map around this client, and the tailnet's other machines.
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";
import {
  AuthDiagnosticsReadScope,
  type EnvironmentId,
  type ForkDashboardLayout,
  type ForkNodeExporterReading,
  type ForkTailnetPeer,
  type ForkTailnetStatus,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { MonitorIcon } from "@phosphor-icons/react/dist/csr/Monitor";
import { type ReactNode, useContext } from "react";

import { isElectron } from "../../env";
import { formatBytes } from "../../lib/formatBytes";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { environmentPresentations } from "../../state/presentation";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentsWithScope } from "../../state/session";
import type { MessageResolver } from "../../i18n/messages";
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
  linkTailnet,
  tailnetOnlyPeers,
  type TailnetReading,
} from "./dashboard.logic";
import {
  environmentIdentity,
  exporterIdentity,
  type LiveMachine,
  type PlacedMachine,
  type PlacedSection,
  placeMachines,
  TAILNET_SECTION,
  T3_SECTION,
  tailnetIdentity,
} from "./dashboardLayout.logic";
import { DashboardMachinesEditor, type MachineStatus } from "./DashboardMachinesEditor";
import { MachineGlyph } from "./machineAppearance";
import { DotMeter, toneColor } from "../widgets/DitherChart";
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

function shareColor(share: number | null): string {
  if (share === null) return "var(--muted-foreground)";
  if (share >= SATURATED_SHARE) return "var(--destructive)";
  if (share >= BUSY_SHARE) return "var(--warning)";
  return toneColor("accent");
}

const percent = (share: number | null) => (share === null ? "–" : `${Math.round(share * 100)}%`);

/** A thin dotted meter; its width changes per sample without a transition, so nothing repaints between. */
function Meter({ label, share }: { readonly label: string; readonly share: number | null }) {
  return (
    <div className="grid grid-cols-[2.25rem_minmax(2rem,1fr)_2.5rem] items-center gap-1.5 font-mono text-2xs tabular-nums">
      <span className="text-muted-foreground">{label}</span>
      <DotMeter share={share} color={shareColor(share)} />
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
  readonly glyph?: ReactNode;
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
  const gt = useGT();
  const specs = [
    load.cores === null ? null : gt("{cores} cores", { cores: load.cores }),
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
        {props.glyph}
        <span className="min-w-0 flex-1 truncate font-medium text-sm">{props.label}</span>
        {props.source ? (
          <span className="shrink-0 font-mono text-2xs text-muted-foreground">{props.source}</span>
        ) : null}
        <span className="shrink-0 font-mono text-2xs text-muted-foreground tabular-nums">
          {props.latency ?? gt("offline")}
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
        {specs.length > 0 ? specs.join(" · ") : props.connected ? "…" : gt("Not connected")}
      </span>
    </article>
  );
}

interface Appearance {
  readonly label: string;
  readonly glyph: ReactNode;
}

/** A fork server streams its load about every second; the latency is a probe on that socket. */
function LiveMachineCard({
  environment,
  ...appearance
}: Appearance & { readonly environment: DashboardEnvironment }) {
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
      {...appearance}
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
function PolledMachineCard({
  environment,
  ...appearance
}: Appearance & { readonly environment: DashboardEnvironment }) {
  const probe = useEnvironmentQuery(
    environment.connected ? dashboardHostProbe(environment.environmentId) : null,
  );
  useVisibleInterval(probe.refresh, HOST_PROBE_INTERVAL_MS);
  // A failed refresh keeps the last sample; dim it rather than pass it off as current.
  const unreachable = environment.connected && probe.data === null && probe.error !== null;
  return (
    <MachineCardView
      {...appearance}
      connected={environment.connected}
      load={probe.data ? machineLoad(probe.data.host) : NO_LOAD}
      latency={environment.connected ? (probe.data ? `${probe.data.roundTripMs} ms` : "…") : null}
      stale={probe.data !== null && probe.error !== null}
      problem={unreachable ? probe.error : null}
    />
  );
}

function ExporterCard({
  reading,
  ...appearance
}: Appearance & { readonly reading: ForkNodeExporterReading }) {
  return (
    <MachineCardView
      {...appearance}
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
  readonly machines: ReadonlyArray<ShownMachine>;
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
  const gt = useGT();
  const m = useMessages();
  return (
    <div className="flex flex-col items-center justify-center gap-1 rounded-md border border-primary/40 bg-card px-5 py-4 text-center lg:min-w-48">
      <MonitorIcon aria-hidden className="size-5 text-muted-foreground" />
      <span className="font-serif text-lg">
        {isElectron ? gt("This computer") : gt("This browser")}
      </span>
      <span className="font-mono text-2xs text-muted-foreground">
        {onlineSummary(environments, m)}
      </span>
      <span className="text-2xs text-muted-foreground">
        <T>Latency is measured from here</T>
      </span>
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

function PeerCard({
  peer,
  nowMs,
  label,
  glyph,
}: Appearance & { readonly peer: ForkTailnetPeer; readonly nowMs: number }) {
  return (
    <article
      aria-label={label}
      className={cn(
        "flex min-w-0 flex-col gap-1 rounded-md border border-dashed px-3 py-2",
        !peer.online && "opacity-60",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <StatusDot tone={peer.online ? "online" : "offline"} />
        {glyph}
        <span className="min-w-0 flex-1 truncate font-medium text-sm">{label}</span>
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
function PeerChip({ peer, label, glyph }: Appearance & { readonly peer: ForkTailnetPeer }) {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 text-xs",
        !peer.online && "opacity-60",
      )}
    >
      <StatusDot tone={peer.online ? "online" : "offline"} />
      {glyph}
      <span className="truncate">{label}</span>
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

interface TailnetView {
  /** False when no machine here can read the tailnet: the box is left out. */
  readonly readable: boolean;
  readonly sourceLabel: string | null;
  /** The peers without T3 Code, or null until a reading lists them. */
  readonly peers: ReadonlyArray<ForkTailnetPeer> | null;
  /** Why there are no peers to list, or null while the first reading loads. */
  readonly problem: string | null;
  /** The tailnet nodes each machine is, for the identities its saved look is kept under. */
  readonly nodes: ReadonlyMap<EnvironmentId, ReadonlyArray<string>>;
}

/** The tailnet as the best placed machine reads it, and which of its nodes run T3 Code. */
function useTailnet(
  environments: ReadonlyArray<TailnetEnvironment>,
  exporters: ReadonlyArray<ForkNodeExporterReading>,
  presentations: ReadonlyMap<EnvironmentId, EnvironmentPresentation>,
): TailnetView {
  const m = useMessages();
  const registry = useContext(RegistryContext);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const canRead = useEnvironmentsWithScope(environments, AuthDiagnosticsReadScope);
  const candidates = environments
    .filter(
      (environment) =>
        environment.connected &&
        (presentations.get(environment.environmentId)?.serverConfig?.environment.capabilities
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
  const plain = readings.find((reading) => reading.environmentId === sourceEnvironmentId)?.status;
  // The pinged reading adds latencies; until it answers, the plain one already lists the peers.
  const sourceStatus = pinged?.available ? pinged : (plain ?? null);
  const identified = [...environments, ...exporterEnvironments(exporters)];
  const peers = tailnetOnlyPeers({ source: sourceStatus, readings, environments: identified });
  return {
    readable: candidates.length > 0,
    sourceLabel:
      sourceEnvironmentId === null
        ? null
        : (environments.find((environment) => environment.environmentId === sourceEnvironmentId)
            ?.label ?? ""),
    peers,
    // With no machine able to read the tailnet, say why the first one could not.
    problem:
      sourceEnvironmentId === null
        ? (readings[0]?.status?.problem ?? m(msg("No data")))
        : sourceStatus === null
          ? null
          : (sourceStatus.problem ?? m(msg("No data"))),
    nodes: linkTailnet({
      peers: sourceStatus?.available ? sourceStatus.peers : [],
      readings,
      environments: identified,
    }).nodes,
  };
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

type MachineData =
  | { readonly type: "environment"; readonly environment: TailnetEnvironment }
  | { readonly type: "exporter"; readonly reading: ForkNodeExporterReading }
  | { readonly type: "peer"; readonly peer: ForkTailnetPeer };

interface ShownMachine {
  readonly key: string;
  readonly card: ReactNode;
}

function liveMachines(input: {
  readonly environments: ReadonlyArray<TailnetEnvironment>;
  readonly exporters: ReadonlyArray<ForkNodeExporterReading>;
  readonly tailnet: TailnetView;
}): ReadonlyArray<LiveMachine<MachineData>> {
  const nodeIds = (id: EnvironmentId) => (input.tailnet.nodes.get(id) ?? []).map(tailnetIdentity);
  const exporterIds = new Map(
    exporterEnvironments(input.exporters).map((environment, index) => [
      input.exporters[index]!,
      environment.environmentId,
    ]),
  );
  return [
    ...input.environments.map((environment): LiveMachine<MachineData> => ({
      ids: [environmentIdentity(environment.environmentId), ...nodeIds(environment.environmentId)],
      kind: "environment",
      name: environment.label,
      data: { type: "environment", environment },
    })),
    ...input.exporters.map((reading): LiveMachine<MachineData> => ({
      ids: [exporterIdentity(reading.name, reading.host), ...nodeIds(exporterIds.get(reading)!)],
      kind: "exporter",
      name: reading.name,
      data: { type: "exporter", reading },
    })),
    ...(input.tailnet.peers ?? []).map((peer): LiveMachine<MachineData> => ({
      ids: [tailnetIdentity(peer.id)],
      kind: "peer",
      name: peer.hostName,
      data: { type: "peer", peer },
    })),
  ];
}

const isOnline = (data: MachineData) =>
  data.type === "environment"
    ? data.environment.connected
    : data.type === "exporter"
      ? data.reading.resources !== null
      : data.peer.online;

function machineStatus(nowMs: number, resolve: MessageResolver) {
  return (machine: PlacedMachine<MachineData>): MachineStatus => {
    const data = machine.live?.data;
    if (data === undefined) {
      return {
        online: false,
        detail: machine.ambiguous
          ? resolve(msg("Matches more than one machine"))
          : resolve(msg("No longer reported")),
      };
    }
    if (data.type === "peer") {
      return {
        online: data.peer.online,
        detail: data.peer.lastSeen
          ? resolve(
              msg("seen {when}", {
                when: formatRelativeTimeLabel(data.peer.lastSeen, nowMs, resolve),
              }),
            )
          : data.peer.os || null,
      };
    }
    if (data.type === "exporter") return { online: isOnline(data), detail: "node_exporter" };
    return { online: data.environment.connected, detail: "T3 Code" };
  };
}

function MachineTile(props: {
  readonly machine: PlacedMachine<MachineData>;
  readonly nowMs: number;
  readonly chip?: boolean;
}) {
  const { machine } = props;
  const data = machine.live!.data;
  const appearance = {
    label: machine.label,
    glyph: <MachineGlyph icon={machine.icon} color={machine.color} kind={machine.live!.kind} />,
  };
  switch (data.type) {
    case "environment":
      return data.environment.liveLoad ? (
        <LiveMachineCard {...appearance} environment={data.environment} />
      ) : (
        <PolledMachineCard {...appearance} environment={data.environment} />
      );
    case "exporter":
      return <ExporterCard {...appearance} reading={data.reading} />;
    case "peer":
      return props.chip ? (
        <PeerChip {...appearance} peer={data.peer} />
      ) : (
        <PeerCard {...appearance} peer={data.peer} nowMs={props.nowMs} />
      );
  }
}

/** What the view shows of a section: live machines that are not hidden. */
const shownOf = (section: PlacedSection<MachineData>) =>
  section.machines.filter((machine) => machine.live !== null && !machine.hidden);

const onlineCount = (
  machines: ReadonlyArray<PlacedMachine<MachineData>>,
  resolve: MessageResolver,
) =>
  resolve(
    msg("{online} of {total} online", {
      online: machines.filter((machine) => isOnline(machine.live!.data)).length,
      total: machines.length,
    }),
  );

function CustomSection(props: {
  readonly section: PlacedSection<MachineData>;
  readonly nowMs: number;
  readonly compact: boolean;
}) {
  const m = useMessages();
  const machines = shownOf(props.section);
  if (machines.length === 0) return null;
  return (
    <section
      aria-label={props.section.name}
      className={cn("flex flex-col gap-2 rounded-lg border", props.compact ? "p-2" : "p-3")}
    >
      <div className="flex items-baseline gap-3">
        <span className={caption}>{props.section.name}</span>
        <span className="ms-auto font-mono text-2xs text-muted-foreground">
          {onlineCount(machines, m)}
        </span>
      </div>
      <div
        className={cn(
          "grid gap-2",
          props.compact
            ? "grid-cols-1 @xs:grid-cols-2"
            : "grid-cols-[repeat(auto-fill,minmax(16rem,1fr))]",
        )}
      >
        {machines.map((machine) => (
          <MachineTile key={machine.key} machine={machine} nowMs={props.nowMs} />
        ))}
      </div>
    </section>
  );
}

function TailnetBox(props: {
  readonly tailnet: TailnetView;
  readonly section: PlacedSection<MachineData>;
  readonly nowMs: number;
  readonly compact: boolean;
}) {
  const { tailnet } = props;
  const gt = useGT();
  const m = useMessages();
  if (!tailnet.readable) return null;
  const machines = shownOf(props.section);
  const listed = tailnet.peers !== null;
  return (
    <section
      aria-label={gt("Tailnet machines without T3 Code")}
      className={cn(
        "flex flex-col gap-2 rounded-md border border-dashed",
        props.compact ? "px-2.5 py-2" : "p-3",
      )}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className={caption}>
          <T>Tailnet · without T3 Code</T>
        </span>
        {tailnet.sourceLabel !== null ? (
          <span className="font-mono text-2xs text-muted-foreground">
            <T>
              via <Var>{tailnet.sourceLabel}</Var>
            </T>
          </span>
        ) : null}
        {listed ? (
          <span className="ms-auto font-mono text-2xs text-muted-foreground">
            {onlineCount(machines, m)}
          </span>
        ) : null}
      </div>
      {!listed ? (
        <p className="text-muted-foreground text-xs">
          {tailnet.problem ?? gt("Reading the tailnet…")}
        </p>
      ) : machines.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          {tailnet.peers!.length === 0
            ? gt("Every machine on the tailnet runs T3 Code.")
            : gt("Every machine here is hidden or moved to another section.")}
        </p>
      ) : props.compact ? (
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {machines.map((machine) => (
            <MachineTile key={machine.key} machine={machine} nowMs={props.nowMs} chip />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(13rem,1fr))] gap-2">
          {machines.map((machine) => (
            <MachineTile key={machine.key} machine={machine} nowMs={props.nowMs} />
          ))}
        </div>
      )}
    </section>
  );
}

export interface DashboardMachineData {
  readonly environments: ReadonlyArray<TailnetEnvironment>;
  readonly tailnet: TailnetView;
  readonly live: ReadonlyArray<LiveMachine<MachineData>>;
}

const NO_ENVIRONMENTS: ReadonlyArray<TailnetEnvironment> = [];

/**
 * Every machine there is to show, read once for the page so a save can join the identities the
 * view found. `enabled` false, as for a hidden Machines panel, reads nothing.
 */
export function useDashboardMachineData(enabled: boolean): DashboardMachineData {
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
  const exporters = useNodeExporters(enabled ? environments : NO_ENVIRONMENTS);
  const tailnet = useTailnet(enabled ? environments : NO_ENVIRONMENTS, exporters, presentations);
  return { environments, tailnet, live: liveMachines({ environments, exporters, tailnet }) };
}

/**
 * `compact` is the Dashboard column beside a chat: a grid of machines, without the map. With
 * `onLayoutChange` it shows the editor, which writes every change to the layout it was given.
 */
export function DashboardMachines({
  nowMs,
  data,
  layout,
  onLayoutChange,
  compact = false,
}: {
  readonly nowMs: number;
  readonly data: DashboardMachineData;
  readonly layout: ForkDashboardLayout;
  readonly onLayoutChange?: ((layout: ForkDashboardLayout) => void) | undefined;
  readonly compact?: boolean;
}) {
  const { environments, tailnet } = data;
  const m = useMessages();
  const sections = placeMachines(layout, data.live, m);

  if (onLayoutChange) {
    return (
      <DashboardMachinesEditor
        sections={sections}
        layout={layout}
        onChange={onLayoutChange}
        status={machineStatus(nowMs, m)}
      />
    );
  }

  const mapSection = sections.find((section) => section.id === T3_SECTION)!;
  const tailnetSection = sections.find((section) => section.id === TAILNET_SECTION)!;
  const custom = sections
    .filter((section) => section.custom)
    .map((section) => (
      <CustomSection key={section.id} section={section} nowMs={nowMs} compact={compact} />
    ));
  const tailnetBox = (
    <TailnetBox tailnet={tailnet} section={tailnetSection} nowMs={nowMs} compact={compact} />
  );
  const mapMachines: ReadonlyArray<ShownMachine> = shownOf(mapSection).map((machine) => ({
    key: machine.key,
    card: <MachineTile machine={machine} nowMs={nowMs} />,
  }));

  if (compact) {
    return (
      <div className="@container flex flex-col gap-2 rounded-lg border p-2">
        {mapMachines.length > 0 ? (
          <div className="grid grid-cols-1 gap-2 @xs:grid-cols-2">
            {mapMachines.map((machine) => (
              <div key={machine.key} className="min-w-0">
                {machine.card}
              </div>
            ))}
          </div>
        ) : null}
        {custom}
        {tailnetBox}
      </div>
    );
  }
  const { left, right } = splitAroundHub(mapMachines);

  return (
    <div className="flex flex-col gap-3">
      <div
        className={cn(
          "grid items-center gap-2 rounded-lg border p-3 lg:gap-0",
          // A lone machine has no right wing; it should not leave half the map empty.
          right.length === 0
            ? "lg:grid-cols-[minmax(0,1fr)_auto]"
            : "lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]",
        )}
      >
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
      {custom}
      {tailnetBox}
    </div>
  );
}
