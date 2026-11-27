import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { HouseIcon } from "@phosphor-icons/react/dist/csr/House";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { TrayIcon } from "@phosphor-icons/react/dist/csr/Tray";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ReactNode } from "react";

import { allBotsAtom } from "../bots/bots.state.ts";
import { botState } from "../bots/bots.logic.ts";
import { activeMissionsAtom } from "../missions/missions.state.ts";
import { VIEW_LINKS, viewAtom } from "../overview/Overview.tsx";
import {
  listedThreadsAtom,
  mobileSidebarOpenAtom,
  selectedThreadKeyAtom,
  useDecisionsPanel,
} from "../sidebar/Sidebar.tsx";
import { AgentAvatar, botMascot } from "./AgentAvatar.tsx";

// Adaptado de WorkspacePreview.tsx de Backroom (github.com/AdrianAlonsoDev/backroom, 4ca0ae9),
// MIT, © 2026 Adrián Alonso. Ver ./NOTICE.

// Backroom's order first (Inicio, Misiones, Para ti, Contexto), then the rest of the ADE's views.
const ORDER = [
  "misiones",
  "memoria",
  "proyectos",
  "bots",
  "tablero",
  "resumen",
  "gasto",
  "respaldo",
];
const LINKS = VIEW_LINKS.toSorted(
  (left, right) => ORDER.indexOf(left.target) - ORDER.indexOf(right.target),
);
const TEAM_SHOWN = 6;

/** Backroom's sidebar with the ADE's entries: menu with counts, the team and who you are. */
export function SideNav(props: {
  brand: ReactNode;
  isHome: boolean;
  homeShortcut: string | undefined;
  onHome: () => void;
  machines: ReactNode;
  settings: ReactNode;
  children?: ReactNode;
}) {
  const [view, setView] = useAtom(viewAtom);
  const [selected, setSelected] = useAtom(selectedThreadKeyAtom);
  const setDrawer = useAtomSet(mobileSidebarOpenAtom);
  const decisions = useDecisionsPanel();
  const missions = useAtomValue(activeMissionsAtom).length;
  const go = (target: (typeof VIEW_LINKS)[number]["target"]) => {
    setDrawer(false);
    setView(target);
  };
  const link = ({ target, label, Icon }: (typeof VIEW_LINKS)[number], count = 0) => (
    <button
      key={target}
      type="button"
      aria-current={selected === null && view === target ? "page" : undefined}
      onClick={() => go(target)}
    >
      <Icon aria-hidden />
      {label}
      {count > 0 ? <small className="v2-nav-count">{count}</small> : null}
    </button>
  );
  const forYou = decisions.count > 0 ? decisions.count : decisions.snoozedCount;
  const forYouLink = (
    <button
      key="para-ti"
      type="button"
      aria-expanded={decisions.open}
      aria-controls="ade-decisions"
      disabled={forYou === 0}
      onClick={() => {
        setDrawer(false);
        decisions.setOpen(!decisions.open);
      }}
    >
      <TrayIcon aria-hidden />
      Para ti
      {forYou > 0 ? (
        <small className="v2-nav-count" data-quiet={decisions.count === 0 || undefined}>
          {forYou}
          {decisions.count === 0 ? <span className="ade-sr-only"> pospuestas</span> : null}
        </small>
      ) : null}
    </button>
  );

  return (
    <div className="br br-side">
      <div className="v2-app">
        <div className="br-side-brand">{props.brand}</div>
        <nav className="v2-app-sidebar" aria-label="Navegación">
          {props.machines}
          <div className="v2-app-nav">
            <button
              type="button"
              aria-current={props.isHome ? "page" : undefined}
              aria-keyshortcuts={props.homeShortcut}
              onClick={props.onHome}
            >
              <HouseIcon aria-hidden />
              Inicio
            </button>
            {LINKS.flatMap((entry) =>
              entry.target === "misiones" ? [link(entry, missions), forYouLink] : [link(entry)],
            )}
          </div>
          <Team
            selected={selected}
            onOpen={(key) => {
              setDrawer(false);
              setSelected(key);
            }}
            onBots={() => go("bots")}
          />
          {props.children}
          <div className="v2-app-user">
            <span aria-hidden>T</span>
            <div>
              <strong>Tú</strong>
              <small>Cuenta personal</small>
            </div>
            {props.settings}
          </div>
        </nav>
      </div>
    </div>
  );
}

const STATUS_LABEL = {
  working: "trabajando",
  "needs-you": "te necesita",
  error: "con error",
  done: "hecho",
  asleep: "dormido",
};

function Team(props: {
  selected: string | null;
  onOpen: (key: string) => void;
  onBots: () => void;
}) {
  const { byEnv } = useAtomValue(allBotsAtom);
  const threads = useAtomValue(listedThreadsAtom);
  const bots = [...byEnv]
    .flatMap(([environmentId, list]) => list.map((bot) => ({ environmentId, bot })))
    .filter(({ bot }) => !bot.archived)
    .toSorted((left, right) => Number(right.bot.coordinator) - Number(left.bot.coordinator));
  return (
    <>
      <span className="v2-team-label">
        Tu equipo
        <button type="button" aria-label="Bots: crear o ver todos" onClick={props.onBots}>
          <PlusIcon size={13} aria-hidden />
        </button>
      </span>
      <div className="v2-sidebar-team">
        {bots.length === 0 ? <span className="br-side-empty">Aún sin bots</span> : null}
        {bots.slice(0, TEAM_SHOWN).map(({ environmentId, bot }) => {
          const thread = threads.find(
            (candidate) =>
              candidate.environmentId === environmentId && candidate.id === bot.threadId,
          );
          const { status } = botState(bot, thread, false);
          const key =
            bot.threadId === null
              ? null
              : scopedThreadKey(scopeThreadRef(environmentId, bot.threadId));
          return (
            <button
              key={`${environmentId}:${bot.id}`}
              type="button"
              aria-current={key !== null && key === props.selected ? "page" : undefined}
              onClick={() => (key === null ? props.onBots() : props.onOpen(key))}
            >
              <AgentAvatar kind={botMascot(bot)} />
              <span>{bot.name}</span>
              <i data-status={status} aria-hidden />
              <span className="ade-sr-only">, {STATUS_LABEL[status]}</span>
            </button>
          );
        })}
        {bots.length > TEAM_SHOWN ? (
          <button type="button" className="br-side-more" onClick={props.onBots}>
            {bots.length - TEAM_SHOWN} más
          </button>
        ) : null}
      </div>
    </>
  );
}
