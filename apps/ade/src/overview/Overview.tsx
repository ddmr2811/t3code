import { useAtom, useAtomValue } from "@effect/atom-react";
import { KanbanIcon } from "@phosphor-icons/react/dist/csr/Kanban";
import { PlugsIcon } from "@phosphor-icons/react/dist/csr/Plugs";
import { SquaresFourIcon } from "@phosphor-icons/react/dist/csr/SquaresFour";
import type { ConnectionCatalogEntry } from "@t3tools/client-runtime/connection";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, PROVIDER_DISPLAY_NAMES, WS_METHODS } from "@t3tools/contracts";
import { collectLimitAccounts } from "@t3tools/shared/usageLimits";
import { AsyncResult, Atom } from "effect/reactivity";
import { memo } from "react";

import { connectionAtomRuntime, environmentCatalog } from "../connection/runtime.ts";
import { ExtensionPanel, MachineExtensions } from "../extensions/Extensions.tsx";
import { useMachineStatus } from "../Machines.tsx";
import {
  listedThreadsAtom,
  ProjectTitle,
  selectedThreadKeyAtom,
  ThreadStateBadge,
} from "../sidebar/Sidebar.tsx";
import type { ThreadState } from "../sidebar/sidebar.logic.ts";
import { serverEnvironment } from "../state.ts";
import { groupSessions, openPullRequests, SESSION_GROUPS } from "./overview.logic.ts";

type View = "resumen" | "tablero";

// The view lives in `?vista=` beside `?hilo=`. Choosing a view also closes the open thread, in
// one history entry; the popstate tells the thread's atom to read the address again.
const readView = (): View =>
  new URLSearchParams(window.location.search).get("vista") === "tablero" ? "tablero" : "resumen";
const viewAtom = Atom.writable(
  (get) => {
    const onPopState = () => get.setSelf(readView());
    window.addEventListener("popstate", onPopState);
    get.addFinalizer(() => window.removeEventListener("popstate", onPopState));
    return readView();
  },
  (_ctx, view: View) => {
    const url = new URL(window.location.href);
    if (view === "tablero") url.searchParams.set("vista", view);
    else url.searchParams.delete("vista");
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
const limitAccountsAtom = Atom.make((get) => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  return collectLimitAccounts(
    new Map(
      [...catalog.entries].map(([environmentId, entry]) => [
        environmentId,
        { entry, serverConfig: get(serverEnvironment.configValueAtom(environmentId)) },
      ]),
    ),
  );
}).pipe(Atom.withLabel("ade-limit-accounts"));

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
const gigabytes = (bytes: number) => (bytes / 2 ** 30).toFixed(bytes < 10 * 2 ** 30 ? 1 : 0);

export function ViewNav() {
  const [view, setView] = useAtom(viewAtom);
  const threadOpen = useAtomValue(selectedThreadKeyAtom) !== null;
  const link = (target: View, label: string, Icon: typeof KanbanIcon) => (
    <button
      type="button"
      className="ade-view-link"
      aria-current={!threadOpen && view === target ? "page" : undefined}
      onClick={() => setView(target)}
    >
      <Icon size={16} aria-hidden />
      {label}
    </button>
  );
  return (
    <nav className="ade-views" aria-label="Vistas">
      {link("resumen", "Resumen", SquaresFourIcon)}
      {link("tablero", "Tablero", KanbanIcon)}
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
              {account.window.label}
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

function Summary() {
  return (
    <div className="ade-summary">
      <h1>Resumen</h1>
      <div className="ade-summary-cards">
        <MachinesCard />
        <UsageCard />
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
        <section key={state} className="ade-board-column" data-state={state}>
          <h2>
            {GROUP_TITLE[state]} <span>{groups[state].length}</span>
          </h2>
          <ul>
            {groups[state].slice(0, SHOWN).map((thread) => (
              <BoardCard key={sessionKey(thread)} thread={thread} state={state} onOpen={open} />
            ))}
          </ul>
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
  if (!paired) {
    return (
      <section className="ade-empty">
        <PlugsIcon size={28} />
        <h1>Sin conectar</h1>
        <p>Empareja una máquina con T3 Code desde la barra lateral para empezar.</p>
      </section>
    );
  }
  return view === "tablero" ? <Board /> : <Summary />;
}
