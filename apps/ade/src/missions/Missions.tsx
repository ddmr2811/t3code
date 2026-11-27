import { RegistryContext, useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { ArrowUpRightIcon } from "@phosphor-icons/react/dist/csr/ArrowUpRight";
import { FlowArrowIcon } from "@phosphor-icons/react/dist/csr/FlowArrow";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { ChatCircleIcon } from "@phosphor-icons/react/dist/csr/ChatCircle";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { GithubLogoIcon } from "@phosphor-icons/react/dist/csr/GithubLogo";
import { LinkIcon } from "@phosphor-icons/react/dist/csr/Link";
import { PaperclipIcon } from "@phosphor-icons/react/dist/csr/Paperclip";
import { TargetIcon } from "@phosphor-icons/react/dist/csr/Target";
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
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
  type MissionAnswer,
  type MissionCard,
  missionAnswers,
  missionCards,
  type MissionDeliverable,
  missionDeliverables,
  missionKey,
  missionState,
  parseMissionKey,
  triggerLabel,
} from "./mission.logic.ts";
import {
  missionKeyAtom,
  missionRowsAtom,
  missionsLiveAtom,
  openQuestions,
} from "./missions.state.ts";

/** Backroom's stylesheet names the middle columns «running» and «review». */
const BACKROOM_COLUMN = { todo: "todo", doing: "running", you: "review", done: "done" } as const;

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
  const { rows, loaded } = useAtomValue(missionRowsAtom);
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const open = useAtomSet(missionKeyAtom);
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
  const { rows } = useAtomValue(missionRowsAtom);
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
      created={{ title: run.title || run.workflow, at: run.startedAt }}
      answers={missionAnswers(detail.steps)}
    />
  );
  const deliverables = missionDeliverables(detail.references);
  const triggers =
    rows.find((row) => row.environmentId === environmentId && row.node.run.runId === runId)
      ?.triggers ?? [];
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
          {triggers.length === 0 ? null : (
            <span className="v4-chip">
              <ArrowsClockwiseIcon size={13} aria-hidden />
              {triggers.map(triggerLabel).join(" · ")}
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
              <span>Objetivo</span>
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
          {deliverables.length === 0 ? null : (
            <section className="br-pieces" aria-labelledby="ade-mission-deliverables">
              <h4 id="ade-mission-deliverables" className="br-label">
                Entregables <span>{deliverables.length}</span>
              </h4>
              <div className="v4-pieces">
                {deliverables.map((piece) => (
                  <Deliverable key={piece.key} piece={piece} />
                ))}
              </div>
            </section>
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

/** Backroom's channels stand for the kinds a run can touch: GitHub, a thread or a web page. */
const CHANNEL: Readonly<Record<string, "x" | "instagram" | "youtube">> = {
  issue: "x",
  pullRequest: "x",
  thread: "instagram",
  url: "youtube",
};
const CHANNEL_ICON = {
  x: GithubLogoIcon,
  instagram: ChatCircleIcon,
  youtube: LinkIcon,
} as const;

/** One deliverable as Backroom's channel piece: where it lives, its state, and the steps on it. */
function Deliverable(props: { piece: MissionDeliverable }) {
  const { piece } = props;
  const channel = CHANNEL[piece.kind] ?? "youtube";
  const Icon = CHANNEL_ICON[channel];
  return (
    <article className="v4-piece" data-channel={channel}>
      <header className="v4-piece-head">
        <span className="v4-channel-dot" data-channel={channel} aria-hidden>
          <Icon size={15} weight="fill" />
        </span>
        <span className="v4-piece-name">
          <strong>{piece.label}</strong>
          {piece.where === null ? null : <small>{piece.where}</small>}
        </span>
        {piece.state === null ? null : (
          <span className="v4-state" data-state={piece.state}>
            <i aria-hidden />
            {piece.stateWord}
          </span>
        )}
      </header>
      <div className="v4-preview v4-x">
        <p>
          {piece.url === null ? (
            piece.title
          ) : (
            <a href={piece.url} target="_blank" rel="noreferrer">
              {piece.title}
            </a>
          )}
        </p>
      </div>
      <p className="v4-used">
        <PaperclipIcon size={13} aria-hidden />
        {piece.steps.length === 1 ? "Lo tocó" : "Lo tocaron"}: {piece.steps.join(", ")}
      </p>
    </article>
  );
}

const CREATED = new Intl.DateTimeFormat("es-ES", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

function MissionChat(props: {
  environmentId: EnvironmentId;
  threadId: string | null;
  bot: ForkBot | null;
  botStatus: ReturnType<typeof botState>["status"] | null;
  onOpenThread: (threadKey: string) => void;
  created: { readonly title: string; readonly at: string };
  answers: ReadonlyArray<MissionAnswer>;
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
      <div className="br-thread-facts">
        {props.answers.map((answer) => (
          <div key={answer.key} className="v4-question">
            <span>{answer.title}</span>
            <strong>
              <CheckIcon size={13} weight="bold" aria-hidden />
              {answer.choice}
            </strong>
          </div>
        ))}
        <span className="v4-created">
          <TargetIcon size={14} aria-hidden />
          <span>
            <small>Misión creada · {CREATED.format(Date.parse(props.created.at))}</small>
            {props.created.title}
          </span>
        </span>
      </div>
      {ref === null ? null : (
        <>
          <ThreadTimeline
            key={scopedThreadKey(ref)}
            threadRef={ref}
            onOpenChanges={() => setSelectedThread(scopedThreadKey(ref))}
            onOpenThread={props.onOpenThread}
            requests={<ThreadRequests threadRef={ref} onOpenThread={props.onOpenThread} />}
            foldWork
          />
          {thread === null ? null : (
            <Composer key={`composer:${scopedThreadKey(ref)}`} threadRef={ref} thread={thread} />
          )}
        </>
      )}
    </aside>
  );
}
