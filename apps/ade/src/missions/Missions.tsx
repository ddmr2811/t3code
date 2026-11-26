import { RegistryContext, useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { ArrowUpRightIcon } from "@phosphor-icons/react/dist/csr/ArrowUpRight";
import { FlowArrowIcon } from "@phosphor-icons/react/dist/csr/FlowArrow";
import { TargetIcon } from "@phosphor-icons/react/dist/csr/Target";
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  groupWorkflowRuns,
  listedWorkflowRuns,
  type WorkflowRunNode,
  workflowRunLists,
} from "@t3tools/client-runtime/workflows";
import type { EnvironmentId, ForkBot, ThreadId, WorkflowRunDetail } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useContext, useState } from "react";

import { AgentAvatar, botMascot } from "../backroom/AgentAvatar.tsx";
import { Window } from "../backroom/Window.tsx";
import { WorkTile } from "../backroom/WorkTile.tsx";
import { botState } from "../bots/bots.logic.ts";
import { allBotsAtom } from "../bots/bots.state.ts";
import { Composer, runCommand } from "../composer/Composer.tsx";
import { environmentCatalog } from "../connection/runtime.ts";
import { BotNotices } from "../decisions/BotNotices.tsx";
import { ThreadRequests } from "../decisions/Requests.tsx";
import { workflowQuestionKey } from "../decisions/workflowQuestions.ts";
import {
  listedThreadsAtom,
  narrowViewportAtom,
  selectedThreadKeyAtom,
} from "../sidebar/Sidebar.tsx";
import { threadState } from "../sidebar/sidebar.logic.ts";
import {
  environmentThreadShells,
  operableEnvironmentIdsAtom,
  serverEnvironment,
} from "../state.ts";
import { ThreadTimeline } from "../timeline/Timeline.tsx";
import { useConfirm } from "../ui/primitives/confirm.tsx";
import { Tabs, TabsList, TabsPanel, TabsTab } from "../ui/primitives/tabs.tsx";
import {
  MISSION_COLUMNS,
  type MissionCard,
  missionCards,
  missionKey,
  missionState,
  parseMissionKey,
} from "./mission.logic.ts";

/** Backroom's stylesheet names the middle columns «running» and «review». */
const BACKROOM_COLUMN = { todo: "todo", doing: "running", you: "review", done: "done" } as const;

const readMission = () => new URLSearchParams(window.location.search).get("mision");

/** The open mission, in `?mision=` beside `?vista=misiones`, so Back closes it. */
const missionKeyAtom = Atom.writable(
  (get) => {
    const onPopState = () => get.setSelf(readMission());
    window.addEventListener("popstate", onPopState);
    get.addFinalizer(() => window.removeEventListener("popstate", onPopState));
    return readMission();
  },
  (ctx, key: string | null) => {
    const url = new URL(window.location.href);
    if (key === null) url.searchParams.delete("mision");
    else url.searchParams.set("mision", key);
    if (url.href === window.location.href) return;
    window.history.pushState(null, "", url);
    ctx.setSelf(key);
  },
).pipe(Atom.keepAlive);

// The same live lists the inbox reads its questions from: one subscription per machine.
const missionsLiveAtom = Atom.make((get) => {
  const environmentIds = [...get(operableEnvironmentIdsAtom)].toSorted();
  return get(serverEnvironment.workflowsLiveAcross(JSON.stringify(environmentIds)));
}).pipe(Atom.withLabel("ade-missions-live"));

const openQuestions = (node: WorkflowRunNode): number =>
  node.questions.length + node.children.reduce((sum, child) => sum + openQuestions(child), 0);

const DAY = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short" });
const CLOCK = new Intl.DateTimeFormat("es-ES", { hour: "2-digit", minute: "2-digit" });
const nowMillis = () => DateTime.toEpochMillis(DateTime.nowUnsafe());
/** The hour for today, the day before that. */
const when = (iso: string) => {
  const at = Date.parse(iso);
  return DAY.format(at) === DAY.format(nowMillis()) ? CLOCK.format(at) : DAY.format(at);
};

export function Missions() {
  const key = parseMissionKey(useAtomValue(missionKeyAtom));
  return key === null ? (
    <MissionList />
  ) : (
    <Mission environmentId={key.environmentId as EnvironmentId} runId={key.runId} />
  );
}

function MissionList() {
  const across = useAtomValue(missionsLiveAtom);
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const open = useAtomSet(missionKeyAtom);
  const loaded = across.filter(({ result }) => Option.isSome(AsyncResult.value(result))).length;
  const rows = across
    .flatMap(({ environmentId, result }) => {
      const snapshot = Option.getOrUndefined(AsyncResult.value(result));
      if (snapshot === undefined) return [];
      const { runs } = listedWorkflowRuns(snapshot.runs, false);
      const lists = workflowRunLists(
        groupWorkflowRuns(snapshot.workflows, runs, snapshot.questions),
      );
      const needsYou = new Set(lists["needs-you"].map((node) => node.run.runId));
      return lists.all.map((node) => ({
        environmentId,
        node,
        rank: needsYou.has(node.run.runId) ? 0 : node.run.endedAt === null ? 1 : 2,
      }));
    })
    .sort(
      (left, right) =>
        left.rank - right.rank || right.node.run.updatedAt.localeCompare(left.node.run.updatedAt),
    );
  return (
    <Window crumb="Misiones" labelledBy="ade-missions-title" className="ade-missions">
      <header className="br-heading">
        <h1 id="ade-missions-title">Misiones</h1>
        <p>
          Cada misión es una ejecución de un flujo: quién lleva cada paso y qué espera tu decisión.
        </p>
      </header>
      {rows.length === 0 ? (
        <p className="br-empty">
          {loaded === 0
            ? "Ninguna máquina tiene los flujos encendidos. Se activan en T3 Code: Ajustes → Labs → Workflows."
            : "Aún no hay misiones. Cuando un flujo arranque, aparecerá aquí."}
        </p>
      ) : (
        <ul className="v2-mission-list">
          {rows.map(({ environmentId, node }) => {
            const state = missionState(node.run, openQuestions(node));
            return (
              <li key={`${environmentId}:${node.run.runId}`}>
                <button
                  type="button"
                  className="ade-mission-row"
                  onClick={() => open(missionKey(environmentId, node.run.runId))}
                >
                  <WorkTile kind="check" className="v2-mission-tile" />
                  <span>
                    <span className="v2-h4">{node.run.title || node.run.workflow}</span>
                    <span className="v2-mission-state" data-tone={state.tone}>
                      {state.word}
                    </span>
                    <small>
                      {catalog.entries.get(environmentId)?.target.label ?? environmentId}
                      <span>·</span>
                      {node.run.workflow}
                    </small>
                  </span>
                  <span className="v2-mission-code">{when(node.run.updatedAt)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Window>
  );
}

const NO_DETAIL = Atom.make(AsyncResult.initial<WorkflowRunDetail, never>());

function Mission(props: { environmentId: EnvironmentId; runId: string }) {
  const { environmentId, runId } = props;
  const registry = useContext(RegistryContext);
  const setMission = useAtomSet(missionKeyAtom);
  const narrow = useAtomValue(narrowViewportAtom);
  const operable = useAtomValue(operableEnvironmentIdsAtom).has(environmentId);
  const detailResult = useAtomValue(
    operable ? serverEnvironment.workflowRun({ environmentId, input: { runId } }) : NO_DETAIL,
  );
  const across = useAtomValue(missionsLiveAtom);
  const snapshot = Option.getOrUndefined(
    AsyncResult.value(
      across.find((entry) => entry.environmentId === environmentId)?.result ??
        AsyncResult.initial(),
    ),
  );
  const questions = (snapshot?.questions ?? []).filter((question) => question.runId === runId);
  const bots = useAtomValue(allBotsAtom).byEnv.get(environmentId) ?? [];
  const threads = useAtomValue(listedThreadsAtom);
  const machine = useAtomValue(environmentCatalog.catalogValueAtom).entries.get(environmentId);
  const canResume = useAtomValue(serverEnvironment.resumeWorkflowRun.permissionAtom(environmentId));
  const canCancel = useAtomValue(serverEnvironment.cancelWorkflowRun.permissionAtom(environmentId));
  const confirm = useConfirm();
  const [picked, setPicked] = useState<string | null>(null);
  const [tab, setTab] = useState<"board" | "chat">("board");
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const detail = Option.getOrUndefined(AsyncResult.value(detailResult));
  if (detail === undefined) {
    return (
      <Window crumb="Misiones" onBack={() => setMission(null)} className="ade-missions">
        <p className="br-empty" role={detailResult._tag === "Failure" ? "alert" : "status"}>
          {!operable
            ? "Esta sesión no puede operar en esa máquina, o ya no está emparejada."
            : detailResult._tag === "Failure"
              ? "No se pudo leer esta misión."
              : "Cargando la misión…"}
        </p>
      </Window>
    );
  }

  const threadOf = (threadId: string) =>
    threads.find((thread) => thread.environmentId === environmentId && thread.id === threadId);
  const cards = missionCards({
    detail,
    questions,
    bots,
    threadNeedsYou: (threadId) => {
      const thread = threadOf(threadId);
      return thread !== undefined && threadState(thread) === "needs-you";
    },
    now: nowMillis(),
  });
  const { run } = detail;
  const state = missionState(run, questions.length);
  const crew = [
    ...new Map(cards.flatMap((card) => (card.bot ? [[card.bot.id, card.bot]] : []))).values(),
  ];
  // The coordinator speaks for the mission; else the thread a question points at, else the newest.
  const asked = questions.find((question) => question.thread?.environmentId === null)?.thread
    ?.threadId;
  const chatThreadId =
    picked ??
    crew.find((bot) => bot.coordinator && bot.threadId !== null)?.threadId ??
    asked ??
    cards.findLast((card) => card.threadId !== null)?.threadId ??
    null;
  const chatBot = bots.find((bot) => bot.threadId === chatThreadId) ?? null;

  const act = async (kind: "resume" | "cancel") => {
    if (kind === "cancel") {
      const agreed = await confirm.ask({
        title: "¿Cancelar la misión?",
        description: `«${run.title || run.workflow}» se para donde está y no se puede reanudar después.`,
        confirmLabel: "Cancelar la misión",
      });
      if (!agreed) return;
    }
    setActing(true);
    setError(null);
    const failure = await runCommand(
      registry,
      kind === "resume" ? serverEnvironment.resumeWorkflowRun : serverEnvironment.cancelWorkflowRun,
      { environmentId, input: { runId } },
      kind === "resume" ? "No se pudo reanudar" : "No se pudo cancelar",
    );
    setActing(false);
    setError(failure);
  };

  const pick = (threadId: string) => {
    setPicked(threadId);
    setTab("chat");
  };
  const chat = (
    <MissionChat
      environmentId={environmentId}
      threadId={chatThreadId}
      bot={chatBot}
      botStatus={
        chatBot === null ? null : botState(chatBot, threadOf(chatBot.threadId ?? ""), false).status
      }
      onOpenThread={(key) => {
        const ref = parseScopedThreadKey(key);
        if (ref !== null && ref.environmentId === environmentId) pick(ref.threadId);
      }}
    />
  );
  const board = (
    <div className="v4-board" aria-label="Tablero de la misión">
      {MISSION_COLUMNS.map((column) => {
        const list = cards.filter((card) => card.column === column.id);
        return (
          <section
            key={column.id}
            className="v4-column"
            data-column={BACKROOM_COLUMN[column.id]}
            aria-labelledby={`ade-mission-col-${column.id}`}
          >
            <h4 id={`ade-mission-col-${column.id}`}>
              <i aria-hidden />
              {column.title}
              <span>{list.length}</span>
            </h4>
            <ul className="br-cards">
              {list.map((card) => (
                <li key={card.key}>
                  <MissionCardView
                    card={card}
                    environmentId={environmentId}
                    selected={card.threadId !== null && card.threadId === chatThreadId}
                    onPick={card.threadId === null ? null : () => pick(card.threadId!)}
                    onOpenThread={(key) => {
                      const ref = parseScopedThreadKey(key);
                      if (ref !== null && ref.environmentId === environmentId) pick(ref.threadId);
                    }}
                  />
                </li>
              ))}
            </ul>
            {list.length === 0 && column.id === "todo" && cards.length === 0 ? (
              <p className="br-empty">Aún no ha empezado ningún paso.</p>
            ) : null}
          </section>
        );
      })}
    </div>
  );

  const done = cards.filter((card) => card.column === "done").length;
  return (
    <Window
      crumb="Misiones"
      current={run.title || run.workflow}
      onBack={() => setMission(null)}
      labelledBy="ade-mission-title"
      className="ade-mission"
      flush
      actions={
        <>
          {crew.length === 0 ? null : (
            <span
              className="v4-stack"
              aria-label={`Equipo: ${crew.map((bot) => bot.name).join(", ")}`}
            >
              {crew.map((bot) => (
                <AgentAvatar key={bot.id} kind={botMascot(bot)} />
              ))}
            </span>
          )}
          <span className="v4-chip ade-mission-state" data-tone={state.tone}>
            {state.word}
          </span>
          {run.status === "paused" ? (
            <button
              type="button"
              className="v4-primary"
              disabled={canResume !== true || acting}
              onClick={() => void act("resume")}
            >
              Reanudar
            </button>
          ) : null}
          {run.endedAt === null ? (
            <button
              type="button"
              className="v4-secondary"
              disabled={canCancel !== true || acting}
              onClick={() => void act("cancel")}
            >
              Cancelar
            </button>
          ) : null}
        </>
      }
    >
      {confirm.dialog}
      <div className="v4-team">
        {narrow ? null : chat}
        <div className="v4-board-area">
          <header className="v4-board-head">
            <h3 id="ade-mission-title">{run.title || run.workflow}</h3>
            <p className="v4-goal">
              <TargetIcon size={15} aria-hidden />
              <strong>{run.subject?.title ? run.subject.title : `Flujo ${run.workflow}`}</strong>
              <span>· {machine?.target.label ?? environmentId}</span>
            </p>
            {cards.length === 0 ? null : (
              <p className="v4-goal-meter">
                <span className="v4-goal-bar" aria-hidden>
                  <i style={{ width: `${Math.round((done / cards.length) * 100)}%` }} />
                </span>
                <span className="v4-goal-count">
                  {done} de {cards.length} pasos
                </span>
              </p>
            )}
            {run.detail !== null && (run.status === "paused" || run.endedAt !== null) ? (
              <p className="br-detail" data-tone={state.tone}>
                {run.detail.split("\n", 1)[0]}
              </p>
            ) : null}
            {error === null ? null : (
              <p className="ade-error" role="alert">
                {error}
              </p>
            )}
          </header>
          {narrow ? (
            <Tabs
              className="br-tabs"
              value={tab}
              onValueChange={(value) => setTab(value as typeof tab)}
            >
              <TabsList aria-label="Vista de la misión">
                <TabsTab value="board">Tablero</TabsTab>
                <TabsTab value="chat">Conversación</TabsTab>
              </TabsList>
              <TabsPanel value="board">{board}</TabsPanel>
              <TabsPanel value="chat">{chat}</TabsPanel>
            </Tabs>
          ) : (
            board
          )}
        </div>
      </div>
    </Window>
  );
}

function MissionCardView(props: {
  card: MissionCard;
  environmentId: EnvironmentId;
  selected: boolean;
  onPick: (() => void) | null;
  onOpenThread: (threadKey: string) => void;
}) {
  const { card } = props;
  const body = (
    <>
      <strong>{card.title}</strong>
      <span className="v4-card-foot">
        {card.bot === null ? (
          <FlowArrowIcon size={16} aria-hidden className="br-flow" />
        ) : (
          <AgentAvatar kind={botMascot(card.bot)} />
        )}
        <small data-face={card.face}>
          {card.bot === null ? "flujo" : card.bot.name} · {card.status}
        </small>
        {card.face === "working" ? (
          <span className="v4-typing" aria-hidden>
            <i />
            <i />
            <i />
          </span>
        ) : props.onPick === null ? null : (
          <ArrowUpRightIcon size={14} className="v4-card-open" aria-hidden />
        )}
      </span>
    </>
  );
  const question = card.question;
  return (
    <article className="ade-mission-card" data-selected={props.selected ? "" : undefined}>
      {props.onPick === null ? (
        <div className="v4-card">{body}</div>
      ) : (
        <button
          type="button"
          className="v4-card"
          aria-pressed={props.selected}
          aria-label={`${card.title}: ver la conversación`}
          onClick={props.onPick}
        >
          {body}
        </button>
      )}
      {question === null ? null : (
        <BotNotices
          include={(key) =>
            key ===
            workflowQuestionKey({ environmentId: props.environmentId, question, workflow: null })
          }
          onOpenBackLayer={props.onOpenThread}
        />
      )}
    </article>
  );
}

const NO_THREAD = Atom.make(null);

function MissionChat(props: {
  environmentId: EnvironmentId;
  threadId: string | null;
  bot: ForkBot | null;
  botStatus: ReturnType<typeof botState>["status"] | null;
  onOpenThread: (threadKey: string) => void;
}) {
  const ref =
    props.threadId === null
      ? null
      : scopeThreadRef(props.environmentId, props.threadId as ThreadId);
  const thread = useAtomValue(
    ref === null ? NO_THREAD : environmentThreadShells.quietThreadShellAtom(ref),
  );
  const [, setSelectedThread] = useAtom(selectedThreadKeyAtom);
  return (
    <aside className="v4-thread" aria-label="Conversación">
      <header className="v4-thread-head">
        {props.bot === null ? (
          <span className="agent-avatar br-face" aria-hidden>
            <FlowArrowIcon size={18} />
          </span>
        ) : (
          <AgentAvatar kind={botMascot(props.bot)} />
        )}
        <span>
          <strong>
            {props.bot?.name ?? (thread === null ? "Sin conversación" : thread.title)}
          </strong>
          <small>
            {props.bot?.coordinator
              ? "Coordinación"
              : (props.bot?.role ??
                (ref === null
                  ? "El flujo aún no ha hablado con ningún agente."
                  : "Hilo del flujo"))}
            {props.botStatus === "working" ? " · trabajando" : ""}
          </small>
        </span>
        {ref === null ? null : (
          <button
            type="button"
            className="br-link"
            onClick={() => setSelectedThread(scopedThreadKey(ref))}
          >
            Abrir el hilo
          </button>
        )}
      </header>
      {ref === null ? null : (
        <>
          <ThreadTimeline
            key={scopedThreadKey(ref)}
            threadRef={ref}
            onOpenChanges={() => setSelectedThread(scopedThreadKey(ref))}
            onOpenThread={props.onOpenThread}
            requests={<ThreadRequests threadRef={ref} onOpenThread={props.onOpenThread} />}
          />
          {thread === null ? null : (
            <Composer key={`composer:${scopedThreadKey(ref)}`} threadRef={ref} thread={thread} />
          )}
        </>
      )}
    </aside>
  );
}
