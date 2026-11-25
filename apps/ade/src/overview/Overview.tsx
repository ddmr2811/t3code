import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { ArrowsLeftRightIcon } from "@phosphor-icons/react/dist/csr/ArrowsLeftRight";
import { FoldersIcon } from "@phosphor-icons/react/dist/csr/Folders";
import { UserCircleIcon } from "@phosphor-icons/react/dist/csr/UserCircle";
import { KanbanIcon } from "@phosphor-icons/react/dist/csr/Kanban";
import { PlugsIcon } from "@phosphor-icons/react/dist/csr/Plugs";
import { SquaresFourIcon } from "@phosphor-icons/react/dist/csr/SquaresFour";
import type { ConnectionCatalogEntry } from "@t3tools/client-runtime/connection";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, PROVIDER_DISPLAY_NAMES, WS_METHODS } from "@t3tools/contracts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@ui-sdk/react/tooltip";
import { AsyncResult, Atom } from "effect/reactivity";
import { memo } from "react";

import { allCoordinationEntriesAtom } from "../coordination/coordination.state.ts";
import { ProjectBoard } from "../coordination/ProjectBoard.tsx";
import { BotsView } from "../bots/BotsView.tsx";
import { connectionAtomRuntime, environmentCatalog } from "../connection/runtime.ts";
import { ExtensionPanel, MachineExtensions } from "../extensions/Extensions.tsx";
import { allFailoverStatesAtom } from "../failover/failover.state.ts";
import { FailoverPanel } from "../failover/FailoverPanel.tsx";
import { Home } from "../home/Home.tsx";
import { useMachineStatus } from "../Machines.tsx";
import {
  closePanelsOnPhone,
  listedThreadsAtom,
  mobileSidebarOpenAtom,
  ProjectTitle,
  selectedThreadKeyAtom,
  ThreadStateBadge,
} from "../sidebar/Sidebar.tsx";
import type { ThreadState } from "../sidebar/sidebar.logic.ts";
import { groupSessions, openPullRequests, SESSION_GROUPS } from "./overview.logic.ts";
import { SpendCard } from "./Spend.tsx";
import { limitAccountsAtom } from "./spend.state.ts";

export type View = "inicio" | "resumen" | "proyectos" | "tablero" | "respaldo" | "bots";

// The view lives in `?vista=` beside `?hilo=`. Choosing a view also closes the open thread, in
// one history entry; the popstate tells the thread's atom to read the address again.
const readView = (): View => {
  const value = new URLSearchParams(window.location.search).get("vista");
  if (
    value === "resumen" ||
    value === "tablero" ||
    value === "proyectos" ||
    value === "respaldo" ||
    value === "bots"
  )
    return value;
  return "inicio";
};
export const viewAtom = Atom.writable(
  (get) => {
    const onPopState = () => {
      closePanelsOnPhone((atom, value) => get.set(atom, value));
      get.setSelf(readView());
    };
    window.addEventListener("popstate", onPopState);
    get.addFinalizer(() => window.removeEventListener("popstate", onPopState));
    return readView();
  },
  (ctx, view: View) => {
    closePanelsOnPhone((atom, value) => ctx.set(atom, value));
    const url = new URL(window.location.href);
    if (view === "inicio") url.searchParams.delete("vista");
    else url.searchParams.set("vista", view);
    url.searchParams.delete("hilo");
    if (url.href === window.location.href) return;
    window.history.pushState(null, "", url);
    window.dispatchEvent(new PopStateEvent("popstate"));
  },
).pipe(Atom.keepAlive);

const GROUP_TITLE = {
  "needs-you": "Te esperan",
  error: "Falló",
  working: "En marcha",
  done: "Terminados",
} satisfies Record<ThreadState, string>;

// A long-lived machine has hundreds of finished threads; a group shows its most recent ones.
const SHOWN = 40;

const sessionGroupsAtom = Atom.make((get) => groupSessions(get(listedThreadsAtom))).pipe(
  Atom.withLabel("ade-session-groups"),
);
const pullRequestsAtom = Atom.make((get) => openPullRequests(get(listedThreadsAtom))).pipe(
  Atom.withLabel("ade-open-pull-requests"),
);

// Fork servers stream their load about every second while a card listens, and stop after.
const hostLoad = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "ade-host-load",
  tag: WS_METHODS.forkMachinesHostResources,
  idleTtlMs: 0,
});
const NO_LOAD = Atom.make(AsyncResult.initial<never, never>());

/** Colour only for what is close to full; everything else stays quiet. */
const level = (share: number) => (share >= 0.95 ? "full" : share >= 0.85 ? "high" : undefined);
const percent = (share: number) => `${Math.round(share * 100)} %`;
const gigabytes = (bytes: number) =>
  (bytes / 2 ** 30).toLocaleString("es-ES", {
    maximumFractionDigits: bytes < 10 * 2 ** 30 ? 1 : 0,
  });
// The server names its windows in English.
const WINDOW_NAME = { session: "sesión", weekly: "semana", monthly: "mes" } as const;

export const VIEW_LINKS = [
  { target: "resumen", label: "Resumen", Icon: SquaresFourIcon },
  { target: "proyectos", label: "Proyectos", Icon: FoldersIcon },
  { target: "tablero", label: "Tablero", Icon: KanbanIcon },
  { target: "bots", label: "Bots", Icon: UserCircleIcon },
  { target: "respaldo", label: "Respaldo", Icon: ArrowsLeftRightIcon },
] as const;

export function ViewNav(props: { compact?: boolean }) {
  const [view, setView] = useAtom(viewAtom);
  const setMobileSidebar = useAtomSet(mobileSidebarOpenAtom);
  const threadOpen = useAtomValue(selectedThreadKeyAtom) !== null;
  if (props.compact) {
    return (
      <nav className="ade-rail-nav" aria-label="Vistas">
        {VIEW_LINKS.map(({ target, label, Icon }) => (
          <Tooltip key={target} type="label">
            <TooltipTrigger
              type="button"
              className="ade-rail-button"
              aria-current={!threadOpen && view === target ? "page" : undefined}
              onClick={() => setView(target)}
            >
              <Icon size={19} aria-hidden />
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8} className="ade-rail-tooltip">
              {label}
            </TooltipContent>
          </Tooltip>
        ))}
      </nav>
    );
  }
  return (
    <nav className="ade-views" aria-label="Vistas">
      {VIEW_LINKS.map(({ target, label, Icon }) => (
        <button
          key={target}
          type="button"
          className="ade-view-link"
          aria-current={!threadOpen && view === target ? "page" : undefined}
          onClick={() => {
            setView(target);
            setMobileSidebar(false);
          }}
        >
          <Icon size={16} aria-hidden />
          {label}
        </button>
      ))}
    </nav>
  );
}

function MachineLoad(props: { environmentId: EnvironmentId; entry: ConnectionCatalogEntry }) {
  const status = useMachineStatus(props.environmentId, props.entry);
  const load = AsyncResult.getOrElse(
    useAtomValue(
      status.tone === "ok" ? hostLoad({ environmentId: props.environmentId, input: {} }) : NO_LOAD,
    ),
    () => null,
  );
  const memory = load === null ? null : 1 - load.availableMemoryBytes / load.totalMemoryBytes;
  return (
    <li data-tone={status.tone}>
      <span className="ade-dot" />
      <span className="ade-summary-name">{props.entry.target.label}</span>
      {load === null || memory === null ? (
        <span className="ade-summary-aside">{status.tone === "ok" ? "…" : status.text}</span>
      ) : (
        <span className="ade-summary-aside">
          <span data-level={level(memory)}>
            {gigabytes(load.totalMemoryBytes - load.availableMemoryBytes)}/
            {gigabytes(load.totalMemoryBytes)} GB
          </span>
          {load.cpuUtilization === null ? null : (
            <span data-level={level(load.cpuUtilization)}>CPU {percent(load.cpuUtilization)}</span>
          )}
        </span>
      )}
      <div className="ade-summary-extensions">
        <MachineExtensions environmentId={props.environmentId} />
      </div>
    </li>
  );
}

function MachinesCard() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  return (
    <section className="ade-summary-card">
      <h2 className="ade-label">Máquinas</h2>
      <p className="ade-summary-figure">{catalog.entries.size}</p>
      <p className="ade-summary-caption">
        {catalog.entries.size === 1 ? "emparejada" : "emparejadas"} · RAM y CPU en vivo
      </p>
      <ul className="ade-summary-rows">
        {[...catalog.entries].map(([environmentId, entry]) => (
          <MachineLoad key={environmentId} environmentId={environmentId} entry={entry} />
        ))}
      </ul>
    </section>
  );
}

function UsageCard() {
  const accounts = useAtomValue(limitAccountsAtom).flatMap((account) => {
    const window = account.limits.windows.toSorted((a, b) => b.usedPercent - a.usedPercent)[0];
    if (window === undefined) return [];
    const name =
      account.displayName ?? PROVIDER_DISPLAY_NAMES[account.driver] ?? String(account.driver);
    return [{ key: account.key, name, window, share: window.usedPercent / 100 }];
  });
  const peak = Math.max(0, ...accounts.map((account) => account.share));
  return (
    <section className="ade-summary-card">
      <h2 className="ade-label">Uso</h2>
      <p className="ade-summary-figure" data-level={level(peak)}>
        {accounts.length === 0 ? "Sin datos" : percent(peak)}
      </p>
      <p className="ade-summary-caption">
        {accounts.length === 0
          ? "Las máquinas aún no han leído límites de uso."
          : "la ventana más llena de tus cuentas"}
      </p>
      <ul className="ade-summary-rows">
        {accounts.map((account) => (
          <li key={account.key}>
            <span className="ade-summary-name">{account.name}</span>
            <span className="ade-summary-aside">
              {account.window.kind === "other"
                ? account.window.label
                : WINDOW_NAME[account.window.kind]}
              <span className="ade-meter" data-level={level(account.share)}>
                <span style={{ width: `${Math.round(account.share * 100)}%` }} />
              </span>
              <span data-level={level(account.share)}>{percent(account.share)}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PullRequestsCard() {
  const pulls = useAtomValue(pullRequestsAtom);
  return (
    <section className="ade-summary-card">
      <h2 className="ade-label">Pull requests</h2>
      <p className="ade-summary-figure">{pulls.open}</p>
      <p className="ade-summary-caption">
        {pulls.open === 1 ? "abierto en tus hilos" : "abiertos en tus hilos"}
      </p>
      {pulls.open === 0 ? null : (
        <ul className="ade-summary-rows">
          <li>
            <span className="ade-summary-name">CI en rojo</span>
            <span className="ade-summary-aside" data-level={pulls.failing > 0 ? "full" : undefined}>
              {pulls.failing}
            </span>
          </li>
          <li>
            <span className="ade-summary-name">CI en curso</span>
            <span className="ade-summary-aside">{pulls.pending}</span>
          </li>
        </ul>
      )}
    </section>
  );
}

function useOpenThread() {
  return useAtom(selectedThreadKeyAtom)[1];
}

const sessionKey = (thread: EnvironmentThreadShell) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

function MachineLabel(props: { environmentId: EnvironmentId }) {
  return useAtomValue(
    environmentCatalog.catalogValueAtom,
    (catalog) => catalog.entries.get(props.environmentId)?.target.label ?? props.environmentId,
  );
}

function SessionMeta(props: { thread: EnvironmentThreadShell }) {
  return (
    <span className="ade-session-meta">
      <ProjectTitle environmentId={props.thread.environmentId} projectId={props.thread.projectId} />
      {" · "}
      <MachineLabel environmentId={props.thread.environmentId} />
      {props.thread.branch === null ? null : ` · ${props.thread.branch}`}
    </span>
  );
}

const SessionRow = memo(function SessionRow(props: {
  thread: EnvironmentThreadShell;
  state: ThreadState;
  onOpen: (key: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        className="ade-session"
        onClick={() => props.onOpen(sessionKey(props.thread))}
      >
        <ThreadStateBadge state={props.state} />
        <span className="ade-session-title">{props.thread.title}</span>
        <SessionMeta thread={props.thread} />
      </button>
    </li>
  );
});

const BoardCard = memo(function BoardCard(props: {
  thread: EnvironmentThreadShell;
  state: ThreadState;
  onOpen: (key: string) => void;
}) {
  return (
    <li>
      <button
        type="button"
        className="ade-board-card"
        data-state={props.state}
        onClick={() => props.onOpen(sessionKey(props.thread))}
      >
        <SessionMeta thread={props.thread} />
        <span className="ade-session-title">{props.thread.title}</span>
        <ThreadStateBadge state={props.state} withText />
      </button>
    </li>
  );
});

function More(props: { count: number }) {
  return props.count > SHOWN ? (
    <p className="ade-session-more">y {props.count - SHOWN} más</p>
  ) : null;
}

function Sessions() {
  const groups = useAtomValue(sessionGroupsAtom);
  const open = useOpenThread();
  const shown = SESSION_GROUPS.filter((state) => groups[state].length > 0);
  if (shown.length === 0) return <p className="ade-session-more">Aún no hay hilos.</p>;
  return (
    <div className="ade-sessions">
      {shown.map((state) => (
        <section key={state} className="ade-session-group" data-state={state}>
          <h2>
            {GROUP_TITLE[state]} <span>{groups[state].length}</span>
          </h2>
          <ul>
            {groups[state].slice(0, SHOWN).map((thread) => (
              <SessionRow key={sessionKey(thread)} thread={thread} state={state} onOpen={open} />
            ))}
          </ul>
          <More count={groups[state].length} />
        </section>
      ))}
    </div>
  );
}

function CoordinationSummaryCard() {
  const { byEnv } = useAtomValue(allCoordinationEntriesAtom);
  const setView = useAtomSet(viewAtom);
  const entries = [...byEnv.values()].flat();
  const projects = new Set(entries.map((entry) => entry.projectKey)).size;
  const blocked = entries.filter((entry) => entry.status === "blocked").length;
  const waiting = entries.filter((entry) => entry.status === "waiting").length;
  return (
    <section className="ade-summary-card">
      <h2 className="ade-label">Tablero por proyecto</h2>
      <p className="ade-summary-figure" data-level={blocked > 0 ? "full" : undefined}>
        {entries.length}
      </p>
      <p className="ade-summary-caption">
        {entries.length === 0
          ? "Sin notas activas · coordina hilos por proyecto"
          : `${entries.length === 1 ? "nota" : "notas"} en ${projects === 1 ? "1 proyecto" : `${projects} proyectos`}`}
      </p>
      {entries.length === 0 ? null : (
        <ul className="ade-summary-rows">
          <li>
            <span className="ade-summary-name">Bloqueados</span>
            <span className="ade-summary-aside" data-level={blocked > 0 ? "full" : undefined}>
              {blocked}
            </span>
          </li>
          <li>
            <span className="ade-summary-name">Esperando</span>
            <span className="ade-summary-aside" data-level={waiting > 0 ? "high" : undefined}>
              {waiting}
            </span>
          </li>
        </ul>
      )}
      <button
        type="button"
        className="ade-button-quiet ade-summary-action"
        onClick={() => setView("proyectos")}
      >
        Abrir proyectos
      </button>
    </section>
  );
}

function FailoverSummaryCard() {
  const { byEnv, errors } = useAtomValue(allFailoverStatesAtom);
  const setView = useAtomSet(viewAtom);
  const states = [...byEnv.values()].filter((state) => state !== null);
  const activeCount = states.filter((state) => state.config.enabled).length;
  const totalChains = states.reduce((sum, state) => sum + state.config.chains.length, 0);
  const switchedEvents = states.reduce(
    (sum, state) => sum + state.recentEvents.filter((event) => event.status === "switched").length,
    0,
  );
  return (
    <section className="ade-summary-card">
      <h2 className="ade-label">Respaldo de modelos</h2>
      <p className="ade-summary-figure" data-level={errors.length > 0 ? "high" : undefined}>
        {activeCount > 0 ? "Activo" : "Manual"}
      </p>
      <p className="ade-summary-caption">
        {totalChains === 0
          ? "Sin cadenas configuradas ante límites de cuota"
          : `${totalChains === 1 ? "1 cadena" : `${totalChains} cadenas`} · ${switchedEvents} ${switchedEvents === 1 ? "relevo reciente" : "relevos recientes"}`}
      </p>
      {errors.length > 0 ? (
        <p className="ade-summary-caption" data-level="high">
          Error al leer {errors.length} {errors.length === 1 ? "máquina" : "máquinas"}
        </p>
      ) : null}
      <button
        type="button"
        className="ade-button-quiet ade-summary-action"
        onClick={() => setView("respaldo")}
      >
        Configurar respaldo
      </button>
    </section>
  );
}

function Summary() {
  return (
    <div className="ade-summary">
      <h1>Resumen</h1>
      <div className="ade-summary-cards">
        <MachinesCard />
        <CoordinationSummaryCard />
        <FailoverSummaryCard />
        <UsageCard />
        <SpendCard />
        <PullRequestsCard />
      </div>
      <ExtensionPanel />
      <Sessions />
    </div>
  );
}

function Board() {
  const groups = useAtomValue(sessionGroupsAtom);
  const open = useOpenThread();
  return (
    <div className="ade-board">
      {SESSION_GROUPS.map((state) => (
        <section
          key={state}
          className="ade-board-column"
          data-state={state}
          data-empty={groups[state].length === 0 ? "" : undefined}
        >
          <h2>
            {GROUP_TITLE[state]} <span>{groups[state].length}</span>
          </h2>
          <ul>
            {groups[state].slice(0, SHOWN).map((thread) => (
              <BoardCard key={sessionKey(thread)} thread={thread} state={state} onOpen={open} />
            ))}
          </ul>
          {groups[state].length === 0 ? <p className="ade-session-more">Nada aquí.</p> : null}
          <More count={groups[state].length} />
        </section>
      ))}
    </div>
  );
}

/** The centre with no thread open: the chosen view, or the empty state with no machine. */
export function Overview() {
  const paired = useAtomValue(environmentCatalog.catalogValueAtom).entries.size > 0;
  const view = useAtomValue(viewAtom);
  const setMobileSidebar = useAtomSet(mobileSidebarOpenAtom);
  if (!paired) {
    return (
      <section className="ade-empty">
        <PlugsIcon size={28} />
        <h1>Sin conectar</h1>
        <p>Empareja una máquina con T3 Code desde la barra lateral para empezar.</p>
        <button
          type="button"
          className="ade-button ade-empty-mobile-action"
          onClick={() => setMobileSidebar(true)}
        >
          Emparejar máquina
        </button>
      </section>
    );
  }
  if (view === "inicio") return <Home />;
  if (view === "proyectos") return <ProjectBoard />;
  if (view === "bots") return <BotsView />;
  if (view === "respaldo") return <FailoverPanel />;
  return view === "tablero" ? <Board /> : <Summary />;
}
