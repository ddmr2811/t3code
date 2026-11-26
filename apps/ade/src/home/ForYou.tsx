import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { PulseIcon } from "@phosphor-icons/react/dist/csr/Pulse";
import { RobotIcon } from "@phosphor-icons/react/dist/csr/Robot";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { allBotsAtom } from "../bots/bots.state.ts";
import { environmentCatalog } from "../connection/runtime.ts";
import { formatUpdatedShort } from "../coordination/ProjectBoard.tsx";
import { QuickBotNotice, useBotNotices } from "../decisions/BotNotices.tsx";
import { KIND_LABELS } from "../decisions/DecisionsPanel.tsx";
import { QuickRequest } from "../decisions/Requests.tsx";
import { buildPendingTrayItems } from "../decisions/tray.logic.ts";
import {
  listedThreadsAtom,
  ProjectTitle,
  selectedThreadKeyAtom,
  useDecisionsPanel,
} from "../sidebar/Sidebar.tsx";
import { forYouEntries, homeActivity, workingThreadCount } from "./home.logic.ts";

const FOR_YOU_SHOWN = 4;

const activityAtom = Atom.make((get) => {
  const threads = get(listedThreadsAtom);
  return { ...homeActivity(threads), workingCount: workingThreadCount(threads) };
}).pipe(Atom.withLabel("ade-home-activity"));

/** A bot's own thread reads as the bot: «@handle» instead of its title. */
function useBotHandleOf() {
  const { byEnv } = useAtomValue(allBotsAtom);
  return (environmentId: EnvironmentId, threadId: string) =>
    byEnv.get(environmentId)?.find((bot) => bot.threadId === threadId)?.handle ?? null;
}

function useMachineLabel() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  return (environmentId: EnvironmentId) =>
    catalog.entries.get(environmentId)?.target.label ?? environmentId;
}

function Who(props: {
  bot: string | null;
  name: string;
  machine: string;
  chip: string;
  kind: string;
}) {
  const Glyph = props.bot === null ? ChatCircleIcon : RobotIcon;
  return (
    <p className="ade-foryou-who">
      <Glyph size={15} aria-hidden />
      <span className="ade-foryou-name">{props.bot === null ? props.name : `@${props.bot}`}</span>
      <span className="ade-foryou-machine">{props.machine}</span>
      <span className="ade-chip" data-kind={props.kind}>
        {props.chip}
      </span>
    </p>
  );
}

/** «Para ti»: the decisions panel's queue as cards, each answered here or opened. */
export function ForYou(props: { onOpenThread: (threadKey: string) => void }) {
  const { threads, snoozedKeys, setOpen } = useDecisionsPanel();
  const notices = useBotNotices();
  const machineOf = useMachineLabel();
  const botOf = useBotHandleOf();
  const entries = forYouEntries(notices, buildPendingTrayItems(threads, machineOf), snoozedKeys);
  if (entries.length === 0) return null;
  const shown = entries.slice(0, FOR_YOU_SHOWN);

  return (
    <section className="ade-foryou" aria-labelledby="ade-foryou-title">
      <header className="ade-foryou-head">
        <h2 id="ade-foryou-title">Para ti</h2>
        <span className="ade-foryou-count">{entries.length}</span>
        {entries.length > shown.length ? (
          <button
            type="button"
            className="ade-button-quiet ade-foryou-open"
            onClick={() => setOpen(true)}
          >
            Ver las {entries.length}
          </button>
        ) : null}
      </header>
      <ul className="ade-foryou-grid">
        {shown.map((entry) => {
          if ("notice" in entry) {
            const { notice } = entry;
            return (
              <li key={entry.key} className="ade-foryou-card">
                <Who
                  bot={notice.from?.handle ?? null}
                  name="Bots"
                  machine={machineOf(notice.environmentId)}
                  chip={notice.label}
                  kind="approval"
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
            <li key={entry.key} className="ade-foryou-card">
              <Who
                bot={botOf(thread.environmentId, thread.id)}
                name={thread.title}
                machine={item.machineLabel}
                chip={KIND_LABELS[item.primaryKind]}
                kind={item.primaryKind}
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
  bot: string | null;
  machine: string | null;
  done: boolean;
  onOpen: () => void;
}) {
  const { thread } = props;
  const Glyph = props.done ? CheckCircleIcon : PulseIcon;
  return (
    <li>
      <button type="button" className="ade-activity-row" onClick={props.onOpen}>
        <Glyph size={14} weight="bold" aria-hidden className="ade-activity-mark" />
        <span className="ade-activity-title">
          {props.bot === null ? thread.title : `@${props.bot}`}
        </span>
        <span className="ade-activity-meta">
          {props.done && thread.latestRun?.completedAt != null ? (
            formatUpdatedShort(thread.latestRun.completedAt)
          ) : (
            <ProjectTitle environmentId={thread.environmentId} projectId={thread.projectId} />
          )}
          {props.machine === null ? null : ` · ${props.machine}`}
        </span>
      </button>
    </li>
  );
}

/** What works now and what finished last, from the same thread list as the sidebar. */
export function HomeActivity(props: { multipleMachines: boolean }) {
  const { working, finished, workingCount } = useAtomValue(activityAtom);
  const machineOf = useMachineLabel();
  const botOf = useBotHandleOf();
  const openThread = useAtomSet(selectedThreadKeyAtom);
  const row = (thread: EnvironmentThreadShell, done: boolean) => (
    <ActivityRow
      key={`${thread.environmentId}:${thread.id}`}
      thread={thread}
      bot={botOf(thread.environmentId, thread.id)}
      machine={props.multipleMachines ? machineOf(thread.environmentId) : null}
      done={done}
      onOpen={() => openThread(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)))}
    />
  );
  return (
    <aside className="ade-activity" aria-label="En marcha">
      <div className="ade-activity-head">
        <h2>En marcha</h2>
        <span className="ade-foryou-count">{workingCount}</span>
      </div>
      {working.length === 0 ? (
        <p className="ade-activity-empty">Nada trabajando ahora.</p>
      ) : (
        <ul>{working.map((thread) => row(thread, false))}</ul>
      )}
      {finished.length === 0 ? null : (
        <>
          <h2>Lo último terminado</h2>
          <ul>{finished.map((thread) => row(thread, true))}</ul>
        </>
      )}
    </aside>
  );
}
