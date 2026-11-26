import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ForkBot } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { AgentAvatar, botMascot } from "../backroom/AgentAvatar.tsx";
import { WorkTile } from "../backroom/WorkTile.tsx";
import { allBotsAtom } from "../bots/bots.state.ts";
import { environmentCatalog } from "../connection/runtime.ts";
import { formatUpdatedShort } from "../coordination/ProjectBoard.tsx";
import { QuickBotNotice, useBotNotices } from "../decisions/BotNotices.tsx";
import { KIND_LABELS } from "../decisions/DecisionsPanel.tsx";
import { QuickRequest } from "../decisions/Requests.tsx";
import { viewAtom } from "../overview/Overview.tsx";
import { buildPendingTrayItems } from "../decisions/tray.logic.ts";
import {
  listedThreadsAtom,
  ProjectTitle,
  selectedThreadKeyAtom,
  useDecisionsPanel,
} from "../sidebar/Sidebar.tsx";
import { forYouEntries, homeActivity, workingThreadCount } from "./home.logic.ts";
import { Overnight } from "./Overnight.tsx";

const FOR_YOU_SHOWN = 4;

const activityAtom = Atom.make((get) => {
  const threads = get(listedThreadsAtom);
  return { ...homeActivity(threads), workingCount: workingThreadCount(threads) };
}).pipe(Atom.withLabel("ade-home-activity"));

/** The bot whose own thread this is, so it reads as the bot. */
function useBotOf() {
  const { byEnv } = useAtomValue(allBotsAtom);
  return (environmentId: EnvironmentId, threadId: string) =>
    byEnv.get(environmentId)?.find((bot) => bot.threadId === threadId) ?? null;
}

function useMachineLabel() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  return (environmentId: EnvironmentId) =>
    catalog.entries.get(environmentId)?.target.label ?? environmentId;
}

function Face(props: { bot: ForkBot | null }) {
  return props.bot === null ? (
    <span className="agent-avatar br-face" aria-hidden>
      <ChatCircleIcon size={16} />
    </span>
  ) : (
    <AgentAvatar kind={botMascot(props.bot)} />
  );
}

function Who(props: { bot: ForkBot | null; name: string; machine: string; chip: string }) {
  return (
    <header>
      <Face bot={props.bot} />
      <span>
        <strong>{props.bot === null ? props.name : props.bot.name}</strong>
        <small>
          {props.chip} · {props.machine}
        </small>
      </span>
    </header>
  );
}

/** «Para ti»: the decisions panel's queue as cards, each answered here or opened. */
export function ForYou(props: { onOpenThread: (threadKey: string) => void }) {
  const { threads, snoozedKeys, setOpen } = useDecisionsPanel();
  const notices = useBotNotices();
  const machineOf = useMachineLabel();
  const botOf = useBotOf();
  const entries = forYouEntries(notices, buildPendingTrayItems(threads, machineOf), snoozedKeys);
  if (entries.length === 0) return null;
  const shown = entries.slice(0, FOR_YOU_SHOWN);

  return (
    <section aria-labelledby="ade-foryou-title">
      <header className="v2-app-section-label">
        <h2 id="ade-foryou-title" className="v2-h4">
          Para ti <span>{entries.length}</span>
        </h2>
        {entries.length > shown.length ? (
          <button type="button" className="br-link" onClick={() => setOpen(true)}>
            Ver las {entries.length}
          </button>
        ) : null}
      </header>
      <ul className="br-asks">
        {shown.map((entry) => {
          if ("notice" in entry) {
            const { notice } = entry;
            return (
              <li key={entry.key} className="v4-ask">
                <Who
                  bot={notice.from ?? null}
                  name={notice.type === "workflow" ? (notice.open.workflow ?? "Flujo") : "Bots"}
                  machine={machineOf(notice.environmentId)}
                  chip={notice.label}
                />
                <QuickBotNotice notice={notice} onOpen={() => setOpen(true)} />
              </li>
            );
          }
          const { item } = entry;
          const { thread } = item;
          const threadRef = scopeThreadRef(thread.environmentId, thread.id);
          const open = () => props.onOpenThread(item.key);
          return (
            <li key={entry.key} className="v4-ask">
              <Who
                bot={botOf(thread.environmentId, thread.id)}
                name={thread.title}
                machine={item.machineLabel}
                chip={KIND_LABELS[item.primaryKind]}
              />
              {thread.hasPendingApprovals || thread.hasPendingUserInput ? (
                <QuickRequest threadRef={threadRef} onOpen={open} />
              ) : (
                <>
                  <p className="ade-foryou-what">
                    {(thread.pendingGuestMessageCount ?? 0) > 0
                      ? "Un invitado quiere enviar un mensaje"
                      : "El plan está listo para revisar"}
                  </p>
                  <div className="ade-foryou-actions">
                    <button
                      type="button"
                      className="ade-button-quiet ade-foryou-open"
                      onClick={open}
                    >
                      Abrir
                      <ArrowRightIcon size={13} weight="bold" aria-hidden />
                    </button>
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ActivityRow(props: {
  thread: EnvironmentThreadShell;
  bot: ForkBot | null;
  machine: string | null;
  done: boolean;
  onOpen: () => void;
}) {
  const { thread } = props;
  return (
    <li>
      <button type="button" className="v2-small-mission" onClick={props.onOpen}>
        <Face bot={props.bot} />
        <span>
          {props.bot === null ? thread.title : props.bot.name}
          <small>
            {props.done && thread.latestRun?.completedAt != null ? (
              `Hecho · ${formatUpdatedShort(thread.latestRun.completedAt)}`
            ) : (
              <ProjectTitle environmentId={thread.environmentId} projectId={thread.projectId} />
            )}
            {props.machine === null ? null : ` · ${props.machine}`}
          </small>
        </span>
        {props.done ? (
          <CheckIcon size={14} weight="bold" aria-hidden className="br-done" />
        ) : (
          <i className="v4-typing" aria-hidden>
            <i />
            <i />
            <i />
          </i>
        )}
      </button>
    </li>
  );
}

function useActivityRow(multipleMachines: boolean) {
  const machineOf = useMachineLabel();
  const botOf = useBotOf();
  const openThread = useAtomSet(selectedThreadKeyAtom);
  return (thread: EnvironmentThreadShell, done: boolean) => (
    <ActivityRow
      key={`${thread.environmentId}:${thread.id}`}
      thread={thread}
      bot={botOf(thread.environmentId, thread.id)}
      machine={multipleMachines ? machineOf(thread.environmentId) : null}
      done={done}
      onOpen={() => openThread(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)))}
    />
  );
}

/** What works now, from the same thread list as the sidebar. */
export function HomeActivity(props: { multipleMachines: boolean }) {
  const { working, workingCount } = useAtomValue(activityAtom);
  const row = useActivityRow(props.multipleMachines);
  return (
    <section aria-labelledby="ade-activity-title">
      <header className="v2-app-section-label">
        <h2 id="ade-activity-title" className="v2-h4">
          En marcha <span>{workingCount}</span>
        </h2>
      </header>
      {working.length === 0 ? (
        <p className="br-empty">Nada trabajando ahora.</p>
      ) : (
        <ul className="v2-mission-group">{working.map((thread) => row(thread, false))}</ul>
      )}
    </section>
  );
}

/** The right rail: who coordinates, what finished last, the screens at hand and the night. */
export function HomeRail(props: { projectId: string | null; needsYouCount: number }) {
  const { finished, workingCount } = useAtomValue(activityAtom);
  const { byEnv } = useAtomValue(allBotsAtom);
  const setView = useAtomSet(viewAtom);
  const row = useActivityRow(false);
  const coordinators = [...byEnv.values()].flat().filter((bot) => bot.coordinator && !bot.archived);
  const coordinator =
    coordinators.find((bot) => bot.projectId === props.projectId) ?? coordinators[0] ?? null;
  return (
    <aside className="v2-app-rail" aria-label="Coordinación">
      <div className="v2-rail-piece">
        <div className="v2-rail-card">
          {coordinator === null ? null : (
            <div className="v2-rail-profile">
              <AgentAvatar kind="orbit" />
              <div className="v2-h4">{coordinator.name}</div>
              <p>Coordinación</p>
              <small>
                <i />
                {coordinator.role}
              </small>
            </div>
          )}
          <div className="v2-rail-stats">
            <span>
              <strong>{workingCount}</strong>
              En marcha
            </span>
            <span>
              <strong>{props.needsYouCount}</strong>
              Para ti
            </span>
          </div>
        </div>
        {finished.length === 0 ? null : (
          <div className="v2-rail-block">
            <div className="v2-h5">Lo último terminado</div>
            <ul className="br-rail-list">{finished.map((thread) => row(thread, true))}</ul>
          </div>
        )}
        <div className="v2-rail-block">
          <div className="v2-h5">A mano</div>
          <div className="v2-rail-tools">
            <button type="button" onClick={() => setView("misiones")}>
              <WorkTile kind="check" size="sm" />
              Misiones
            </button>
            <button type="button" onClick={() => setView("memoria")}>
              <WorkTile kind="book" size="sm" />
              Memoria
            </button>
          </div>
        </div>
        <Overnight needsYouCount={props.needsYouCount} />
      </div>
    </aside>
  );
}
