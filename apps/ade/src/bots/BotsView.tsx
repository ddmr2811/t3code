import { RegistryContext, useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { ArchiveIcon } from "@phosphor-icons/react/dist/csr/Archive";
import { ArrowBendDownRightIcon } from "@phosphor-icons/react/dist/csr/ArrowBendDownRight";
import { ArrowBendUpRightIcon } from "@phosphor-icons/react/dist/csr/ArrowBendUpRight";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { CaretLeftIcon } from "@phosphor-icons/react/dist/csr/CaretLeft";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { FolderIcon } from "@phosphor-icons/react/dist/csr/Folder";
import { ListChecksIcon } from "@phosphor-icons/react/dist/csr/ListChecks";
import { MonitorIcon } from "@phosphor-icons/react/dist/csr/Monitor";
import { PaperPlaneTiltIcon } from "@phosphor-icons/react/dist/csr/PaperPlaneTilt";
import { PencilIcon } from "@phosphor-icons/react/dist/csr/Pencil";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { ShieldCheckIcon } from "@phosphor-icons/react/dist/csr/ShieldCheck";
import { SidebarSimpleIcon } from "@phosphor-icons/react/dist/csr/SidebarSimple";
import { SparkleIcon } from "@phosphor-icons/react/dist/csr/Sparkle";
import { TargetIcon } from "@phosphor-icons/react/dist/csr/Target";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ThreadStructureTurnItem } from "@t3tools/client-runtime/state/models";
import {
  FORK_BOTS_DRAFT_TEXT_MAX_LENGTH,
  FORK_BOTS_MESSAGE_MAX_LENGTH,
  type EnvironmentId,
  type ForkBot,
  type ForkBotDraft,
  type ForkBotHandoffStatus,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useContext, useEffect, useMemo, useRef, useState } from "react";

import { AgentAvatar, botMascot } from "../backroom/AgentAvatar.tsx";
import { RUNTIME_MODE_TEXT, runCommand } from "../composer/Composer.tsx";
import { allEnvironmentProjectsAtom } from "../coordination/coordination.state.ts";
import { environmentCatalog } from "../connection/runtime.ts";
import { BotNotices, useBotNotices } from "../decisions/BotNotices.tsx";
import { ApprovalCard, ThreadRequests } from "../decisions/Requests.tsx";
import { availableMachineModelOptions } from "../failover/failover.logic.ts";
import { missionSummary } from "../home/FeaturedMission.tsx";
import { homeProjectKey } from "../home/home.logic.ts";
import { ProjectMemoryCard } from "../memory/MemoryView.tsx";
import { MISSION_COLUMNS, missionCards, missionState } from "../missions/mission.logic.ts";
import {
  activeMissionsAtom,
  missionsLiveAtom,
  useOpenMission,
} from "../missions/missions.state.ts";
import { viewAtom } from "../overview/Overview.tsx";
import { BotSpend } from "../overview/Spend.tsx";
import { USAGE_PROVIDER_OF_DRIVER } from "../overview/spend.state.ts";
import {
  listedThreadsAtom,
  narrowViewportAtom,
  selectedThreadKeyAtom,
  wideViewportAtom,
} from "../sidebar/Sidebar.tsx";
import { threadState } from "../sidebar/sidebar.logic.ts";
import {
  environmentProjects,
  environmentThreadDetails,
  environmentThreadShells,
  serverEnvironment,
} from "../state.ts";
import { ThreadTimeline } from "../timeline/Timeline.tsx";
import { planStepChip } from "../timeline/timeline.logic.ts";
import { useConfirm } from "../ui/primitives/confirm.tsx";
import {
  botDestination,
  botState,
  type BotDraft,
  parseMention,
  recentHandoffs,
  routineThreadIds,
  RUNTIME_MODES,
  SENTENCE_RUNTIME_MODES,
  validateBotDraft,
} from "./bots.logic.ts";
import {
  allBotsAtom,
  forkBotsDraftCommand,
  forkBotsHandoffCommand,
  forkBotsRemoveCommand,
  forkBotsSendMessageCommand,
  forkBotsSetArchivedCommand,
  forkBotsUpsertCommand,
  refreshBots,
  selectedBotKeyAtom,
} from "./bots.state.ts";
import { IntegrationConnections, IntegrationLevels } from "./Integrations.tsx";
import { BotRoutines, ProjectMemory } from "./ProjectMemory.tsx";

const MODEL_SEPARATOR = "\u0000";
const CLOCK = new Intl.DateTimeFormat("es-ES", { hour: "2-digit", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short" });

const HANDOFF_STATUS_LABELS: Record<ForkBotHandoffStatus, string> = {
  pending: "Enviando",
  delivered: "Entregado",
  cut: "Cortado",
  failed: "Falló",
  dismissed: "Descartado",
};

const botKey = (environmentId: EnvironmentId, bot: ForkBot) => `${environmentId}~${bot.handle}`;

const shortTime = (iso: string) => {
  const at = Date.parse(iso);
  const today = DAY.format(DateTime.toEpochMillis(DateTime.nowUnsafe()));
  return DAY.format(at) === today ? CLOCK.format(at) : DAY.format(at);
};

interface BotEntry {
  readonly environmentId: EnvironmentId;
  readonly bot: ForkBot;
}

/** The bot's listed thread and its state, as every surface that paints a bot reads them. */
function useBotState(environmentId: EnvironmentId, bot: ForkBot) {
  const thread = useAtomValue(listedThreadsAtom, (threads) =>
    threads.find(
      (candidate) => candidate.environmentId === environmentId && candidate.id === bot.threadId,
    ),
  );
  const tasks = useAtomValue(serverEnvironment.scheduledTasksLive({ environmentId, input: {} }));
  const routine =
    bot.threadId !== null &&
    tasks._tag === "Success" &&
    routineThreadIds(tasks.value.tasks).has(bot.threadId);
  return { thread, state: botState(bot, thread, routine) };
}

/** Grok Bot's face for the bots: the list, the chat, and the bot's card; T3's thread sits behind. */
export function BotsView() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const { byEnv, errors } = useAtomValue(allBotsAtom);
  const machines = [...enabledEnvironmentIds(catalog)];
  const machineLabel = (id: EnvironmentId) => catalog.entries.get(id)?.target.label ?? id;
  const entries: BotEntry[] = machines.flatMap((environmentId) =>
    (byEnv.get(environmentId) ?? []).map((bot) => ({ environmentId, bot })),
  );
  const narrow = useAtomValue(narrowViewportAtom);
  const wide = useAtomValue(wideViewportAtom);
  const [selectedKey, setSelectedKey] = useAtom(selectedBotKeyAtom);
  // Null follows the window: open from 1440 px, folded below; a click overrides it.
  const [fichaChoice, setFichaChoice] = useState<boolean | null>(null);
  const [creating, setCreating] = useState(false);
  const picked = entries.find((entry) => botKey(entry.environmentId, entry.bot) === selectedKey);
  // On a phone the list is a screen of its own; on a desktop one chat is always open.
  const selected =
    picked ?? (narrow ? undefined : (entries.find((entry) => !entry.bot.archived) ?? entries[0]));
  const fichaOpen = fichaChoice ?? wide;
  const loading = machines.some(
    (id) => !byEnv.has(id) && !errors.some((failure) => failure.environmentId === id),
  );

  return (
    <div
      className="gb"
      data-screen={narrow ? (selected === undefined ? "list" : "chat") : undefined}
      data-ficha={!narrow && fichaOpen && selected !== undefined ? "open" : undefined}
    >
      <section className="gb-list" aria-labelledby="gb-bots-title">
        <h1 id="gb-bots-title">Bots</h1>
        {errors.map((failure) => (
          <p key={failure.environmentId} className="ade-error gb-list-error" role="status">
            {machineLabel(failure.environmentId)}: {failure.message}
          </p>
        ))}
        <ul className="gb-rows" aria-label="Directorio de bots">
          {entries.map((entry) => (
            <li key={botKey(entry.environmentId, entry.bot)}>
              <BotRow
                environmentId={entry.environmentId}
                bot={entry.bot}
                selected={entry === selected}
                machine={machines.length > 1 ? machineLabel(entry.environmentId) : null}
                onPick={() => setSelectedKey(botKey(entry.environmentId, entry.bot))}
              />
            </li>
          ))}
          <li>
            <button
              type="button"
              className="gb-row"
              onClick={() => setCreating(true)}
              disabled={machines.length === 0}
            >
              <span className="gb-plusav" aria-hidden>
                <PlusIcon size={20} />
              </span>
              <span className="gb-tx">
                <span className="gb-nm">Nuevo bot</span>
                <span className="gb-ln">Nombre, modelo, máquina y proyecto.</span>
              </span>
            </button>
          </li>
        </ul>
        {entries.length === 0 ? (
          <p className="gb-empty">
            {machines.length === 0
              ? "No hay máquinas habilitadas en este momento."
              : loading
                ? "Cargando bots…"
                : "Aún no hay bots. Crea el primero y escríbele como en un chat."}
          </p>
        ) : null}
        <MachinesFoot labels={machines.map(machineLabel)} />
      </section>

      {selected === undefined ? (
        narrow ? null : (
          <main className="gb-chat">
            <p className="gb-empty gb-chat-empty">Elige un bot para escribirle.</p>
          </main>
        )
      ) : (
        <BotRoom
          key={botKey(selected.environmentId, selected.bot)}
          environmentId={selected.environmentId}
          bot={selected.bot}
          bots={byEnv.get(selected.environmentId) ?? []}
          machineLabel={machineLabel(selected.environmentId)}
          narrow={narrow}
          fichaOpen={fichaOpen}
          onToggleFicha={() => setFichaChoice(!fichaOpen)}
          onBack={() => setSelectedKey(null)}
        />
      )}

      {creating ? (
        <BotEditor
          bot={null}
          environmentId={null}
          machines={machines}
          pairedCount={catalog.entries.size}
          machineLabel={machineLabel}
          onSaved={(environmentId, handle) => setSelectedKey(`${environmentId}~${handle}`)}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </div>
  );
}

function MachinesFoot(props: { labels: ReadonlyArray<string> }) {
  const setView = useAtomSet(viewAtom);
  return (
    <footer className="gb-list-foot">
      <span className="gb-dot" aria-hidden />
      <span className="gb-foot-text">
        {new Intl.ListFormat("es-ES", { type: "conjunction" }).format(props.labels)}
      </span>
      <button type="button" className="gb-pill" onClick={() => setView("inicio")}>
        <MonitorIcon size={16} aria-hidden />
        T3 Code
      </button>
    </footer>
  );
}

function BotRow(props: {
  environmentId: EnvironmentId;
  bot: ForkBot;
  selected: boolean;
  machine: string | null;
  onPick: () => void;
}) {
  const { bot } = props;
  const { thread, state } = useBotState(props.environmentId, bot);
  const busy = state.status === "working" || state.status === "needs-you";
  return (
    <button
      type="button"
      className="gb-row"
      aria-current={props.selected ? "true" : undefined}
      data-archived={bot.archived ? "" : undefined}
      onClick={props.onPick}
    >
      {state.status === "needs-you" || state.status === "done" ? (
        <span className="gb-unread" aria-hidden />
      ) : null}
      <AgentAvatar kind={botMascot(bot)} className="gb-av" />
      <span className="gb-tx">
        <span className="gb-nm">
          {bot.name}
          {props.machine === null ? null : <small>{props.machine}</small>}
        </span>
        <span className="gb-ln">
          {busy && thread !== undefined && thread.title !== bot.name
            ? `${state.label}: ${thread.title}`
            : `${state.label === "Dormido" ? "" : `${state.label} · `}${bot.role}`}
        </span>
      </span>
      {thread === undefined ? null : (
        <time dateTime={thread.updatedAt}>{shortTime(thread.updatedAt)}</time>
      )}
    </button>
  );
}

/** One bot open: its chat and its card, which share the editor and the confirmations. */
function BotRoom(props: {
  environmentId: EnvironmentId;
  bot: ForkBot;
  bots: ReadonlyArray<ForkBot>;
  machineLabel: string;
  narrow: boolean;
  fichaOpen: boolean;
  onToggleFicha: () => void;
  onBack: () => void;
}) {
  const [fichaSheet, setFichaSheet] = useState(false);
  const showFicha = props.narrow ? fichaSheet : props.fichaOpen;
  return (
    <>
      <BotChat
        environmentId={props.environmentId}
        bot={props.bot}
        bots={props.bots}
        narrow={props.narrow}
        fichaOpen={showFicha}
        onToggleFicha={props.narrow ? () => setFichaSheet(true) : props.onToggleFicha}
        onBack={props.onBack}
      />
      {showFicha ? (
        <BotFicha
          environmentId={props.environmentId}
          bot={props.bot}
          bots={props.bots}
          machineLabel={props.machineLabel}
          sheet={props.narrow}
          onClose={() => setFichaSheet(false)}
        />
      ) : null}
    </>
  );
}

const NO_REQUESTS = Atom.make(null);

function BotChat(props: {
  environmentId: EnvironmentId;
  bot: ForkBot;
  bots: ReadonlyArray<ForkBot>;
  narrow: boolean;
  fichaOpen: boolean;
  onToggleFicha: () => void;
  onBack: () => void;
}) {
  const { environmentId, bot } = props;
  const registry = useContext(RegistryContext);
  const setThreadKey = useAtomSet(selectedThreadKeyAtom);
  const canSend = useAtomValue(forkBotsSendMessageCommand.permissionAtom(environmentId));
  const ref = bot.threadId === null ? null : scopeThreadRef(environmentId, bot.threadId);
  const requests = useAtomValue(
    ref === null ? NO_REQUESTS : environmentThreadDetails.pendingRequestsAtom(ref),
  );
  const approvals = requests?.approvals ?? [];
  const children = useAtomValue(
    environmentThreadShells.quietThreadShellsAtom,
    (threads) =>
      threads.filter(
        (thread) =>
          thread.environmentId === environmentId &&
          bot.threadId !== null &&
          thread.lineage.parentThreadId === bot.threadId,
      ).length,
  );
  const [text, setTextState] = useState("");
  // Kept until the handoff goes through, so a retry after an error is recognised as the same one.
  const [handoffId, setHandoffId] = useState<string | null>(null);
  const setText = (next: string) => {
    setTextState(next);
    setHandoffId(null);
  };
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const others = props.bots.filter((other) => other.id !== bot.id && !other.archived);
  const openThread = () => ref !== null && setThreadKey(scopedThreadKey(ref));

  const send = async () => {
    const message = text.trim();
    if (message === "" || sending) return;
    setSending(true);
    setError(null);
    setNote(null);
    const mention = parseMention(
      message,
      props.bots.filter((other) => other.id !== bot.id).map((other) => other.handle),
    );
    const failure =
      mention === null
        ? await runCommand(
            registry,
            forkBotsSendMessageCommand,
            { environmentId, input: { id: bot.id, text: message } },
            "No se pudo enviar el mensaje al bot",
          )
        : await (async () => {
            const id = handoffId ?? `handoff:${SecureRandom.uuidV4Unsafe()}`;
            setHandoffId(id);
            return runCommand(
              registry,
              forkBotsHandoffCommand,
              {
                environmentId,
                input: { id, fromId: bot.id, toHandle: mention.handle, text: mention.text },
              },
              `No se pudo pasar el trabajo a @${mention.handle}`,
              // From the ADE the user hands it over, so the chain starts at hop 1, never cut here.
              (result) =>
                setNote(
                  `Pasado a @${mention.handle}${result.duplicate ? " (ya se había enviado)" : ""}.`,
                ),
            );
          })();
    setSending(false);
    if (failure !== null) return setError(failure);
    setText("");
    refreshBots(registry, environmentId);
  };

  return (
    <main className="gb-chat" aria-label={`Chat con ${bot.name}`}>
      <header className="gb-chat-h">
        {props.narrow ? (
          <button
            type="button"
            className="gb-circ"
            aria-label="Volver a los bots"
            onClick={props.onBack}
          >
            <CaretLeftIcon size={18} aria-hidden />
          </button>
        ) : (
          <span />
        )}
        <button
          type="button"
          className="gb-who"
          aria-expanded={props.fichaOpen}
          aria-label={`${bot.name}: ${props.fichaOpen && !props.narrow ? "plegar" : "ver"} su ficha`}
          onClick={props.onToggleFicha}
        >
          <AgentAvatar kind={botMascot(bot)} className="gb-av-sm" />
          {bot.name}
        </button>
        <div className="gb-counts">
          {approvals.length === 0 ? null : (
            <button
              type="button"
              className="gb-cnt gb-cnt-ap"
              aria-label={`${approvals.length} por aprobar`}
              onClick={() => setSheet(true)}
            >
              <ShieldCheckIcon size={16} aria-hidden />
              {approvals.length}
              <span className="gb-cnt-word">&nbsp;por aprobar</span>
            </button>
          )}
          {ref === null || props.narrow ? null : (
            <button
              type="button"
              className="gb-cnt"
              aria-label="Abrir su hilo de trabajo en T3 Code"
              onClick={openThread}
            >
              <ListChecksIcon size={16} aria-hidden />
              {1 + children}
              <span className="gb-cnt-word">&nbsp;{children === 0 ? "hilo" : "hilos"}</span>
            </button>
          )}
          {props.narrow ? null : (
            <button
              type="button"
              className="gb-circ"
              aria-pressed={props.fichaOpen}
              aria-label={props.fichaOpen ? "Plegar la ficha" : "Abrir la ficha"}
              onClick={props.onToggleFicha}
            >
              <SidebarSimpleIcon size={18} mirrored aria-hidden />
            </button>
          )}
        </div>
      </header>

      <div className="gb-log">
        {ref === null ? (
          <p className="gb-empty gb-chat-empty">
            {bot.archived
              ? "Restaura el bot para escribirle."
              : "Tu primer mensaje abre su hilo real en el proyecto."}
          </p>
        ) : (
          <ThreadTimeline
            key={scopedThreadKey(ref)}
            threadRef={ref}
            chat
            onOpenChanges={openThread}
            onOpenThread={setThreadKey}
            requests={
              <ThreadRequests threadRef={ref} onOpenThread={setThreadKey} ownApprovals={false} />
            }
          />
        )}
      </div>

      <form
        className="gb-comp"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <div className="gb-cbox">
          <label className="gb-field">
            <span className="ade-sr-only">Mensaje para {bot.name}</span>
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void send();
                }
              }}
              placeholder={
                others.length === 0 || props.narrow
                  ? `Mensaje a ${bot.name}`
                  : `Mensaje a ${bot.name} · @ para pasárselo a otro`
              }
              rows={1}
              maxLength={FORK_BOTS_MESSAGE_MAX_LENGTH}
              disabled={bot.archived}
            />
          </label>
          <button
            type="submit"
            className="gb-send"
            aria-label="Enviar"
            disabled={sending || canSend !== true || bot.archived || text.trim() === ""}
          >
            <PaperPlaneTiltIcon size={18} weight="fill" aria-hidden />
          </button>
        </div>
        {text.startsWith("@") && others.length > 0 ? (
          <div className="gb-mentions" role="group" aria-label="Pasárselo a">
            {others.map((other) => (
              <button
                key={other.handle}
                type="button"
                className="gb-opt"
                onClick={() => setText(`@${other.handle} ${text.replace(/^@\S*\s*/, "")}`)}
              >
                @{other.handle}
              </button>
            ))}
          </div>
        ) : null}
        {note === null ? null : (
          <p className="gb-note" role="status">
            {note}
          </p>
        )}
        {error === null ? null : (
          <p className="ade-error" role="alert">
            {error}
          </p>
        )}
      </form>

      {sheet && ref !== null ? (
        <>
          <div className="gb-dim" aria-hidden onClick={() => setSheet(false)} />
          <div
            className="gb-sheet"
            role="dialog"
            aria-label="Aprobación pendiente"
            onKeyDown={(event) => event.key === "Escape" && setSheet(false)}
          >
            <div className="gb-grab" aria-hidden />
            <div className="gb-sh-top">
              <b>{approvals.length === 0 ? "Hecho" : `1 de ${approvals.length}`}</b>
              <button type="button" className="gb-later" autoFocus onClick={() => setSheet(false)}>
                Luego
              </button>
            </div>
            {approvals[0] === undefined ? (
              <p className="gb-resolved">
                <CheckCircleIcon size={20} weight="fill" aria-hidden />
                Eso es todo por ahora.
              </p>
            ) : (
              <>
                <div className="gb-src">
                  <AgentAvatar kind={botMascot(bot)} className="gb-av-xs" />
                  <button type="button" onClick={openThread}>
                    Hilo de trabajo de {bot.name}
                  </button>
                </div>
                <ApprovalCard
                  key={approvals[0].requestId}
                  threadRef={ref}
                  approval={approvals[0]}
                />
              </>
            )}
          </div>
        </>
      ) : null}
    </main>
  );
}

type FichaTab = "detalles" | "memoria" | "mision";

/** The bot's active mission, if it has a step in one. */
function useBotMission(environmentId: EnvironmentId, bot: ForkBot, bots: ReadonlyArray<ForkBot>) {
  const missions = useAtomValue(activeMissionsAtom);
  return (
    missions.find(
      (mission) =>
        mission.environmentId === environmentId &&
        missionSummary(mission.detail, bots).crew.some((member) => member.id === bot.id),
    ) ?? null
  );
}

function BotFicha(props: {
  environmentId: EnvironmentId;
  bot: ForkBot;
  bots: ReadonlyArray<ForkBot>;
  machineLabel: string;
  sheet: boolean;
  onClose: () => void;
}) {
  const { environmentId, bot } = props;
  const [tab, setTab] = useState<FichaTab>("detalles");
  const mission = useBotMission(environmentId, bot, props.bots);
  const summary = mission === null ? null : missionSummary(mission.detail, props.bots);
  const tabs: ReadonlyArray<{ id: FichaTab; label: string; count: string | null }> = [
    { id: "detalles", label: "Detalles", count: null },
    { id: "memoria", label: "Memoria", count: null },
    {
      id: "mision",
      label: "Misión",
      count: summary === null || summary.total === 0 ? null : `${summary.done}/${summary.total}`,
    },
  ];
  const body = (
    <aside
      className="gb-ficha"
      data-sheet={props.sheet ? "" : undefined}
      aria-label={`Ficha de ${bot.name}`}
      role={props.sheet ? "dialog" : undefined}
      onKeyDown={(event) => props.sheet && event.key === "Escape" && props.onClose()}
    >
      {props.sheet ? (
        <>
          <div className="gb-grab" aria-hidden />
          <div className="gb-hdr">
            <b>{bot.name}</b>
            <button type="button" className="gb-txtbtn gb-b" autoFocus onClick={props.onClose}>
              Listo
            </button>
          </div>
        </>
      ) : null}
      <div className="gb-idn">
        <AgentAvatar kind={botMascot(bot)} className="gb-av-lg" />
        <h2>{bot.name}</h2>
        <p>
          {bot.role} · {props.machineLabel}
        </p>
      </div>
      <div className="gb-seg" role="group" aria-label={`Ficha de ${bot.name}`}>
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={tab === item.id}
            onClick={() => setTab(item.id)}
          >
            {item.label}
            {item.count === null ? null : <span className="gb-n">{item.count}</span>}
          </button>
        ))}
      </div>
      {tab === "detalles" ? (
        <BotDetails
          environmentId={environmentId}
          bot={bot}
          bots={props.bots}
          machineLabel={props.machineLabel}
        />
      ) : tab === "memoria" ? (
        <BotMemory environmentId={environmentId} bot={bot} machineLabel={props.machineLabel} />
      ) : (
        <BotMission environmentId={environmentId} bot={bot} bots={props.bots} />
      )}
    </aside>
  );
  if (!props.sheet) return body;
  return (
    <>
      <div className="gb-dim gb-dim-fixed" aria-hidden onClick={props.onClose} />
      {body}
    </>
  );
}

function BotDetails(props: {
  environmentId: EnvironmentId;
  bot: ForkBot;
  bots: ReadonlyArray<ForkBot>;
  machineLabel: string;
}) {
  const { environmentId, bot } = props;
  const registry = useContext(RegistryContext);
  const setThreadKey = useAtomSet(selectedThreadKeyAtom);
  const setSelectedKey = useAtomSet(selectedBotKeyAtom);
  const { thread, state } = useBotState(environmentId, bot);
  const canWrite = useAtomValue(forkBotsUpsertCommand.permissionAtom(environmentId));
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const model = availableMachineModelOptions(config).find(
    (option) =>
      option.instanceId === bot.modelSelection.instanceId &&
      option.model === bot.modelSelection.model,
  );
  const driver = config?.providers.find(
    (provider) => provider.instanceId === bot.modelSelection.instanceId,
  )?.driver;
  const provider = driver === undefined ? null : (USAGE_PROVIDER_OF_DRIVER[String(driver)] ?? null);
  const children = useAtomValue(environmentThreadShells.quietThreadShellsAtom, (threads) =>
    threads.filter(
      (child) =>
        child.environmentId === environmentId &&
        bot.threadId !== null &&
        child.lineage.parentThreadId === bot.threadId,
    ),
  );
  const handoffs = useAtomValue(allBotsAtom).handoffsByEnv.get(environmentId) ?? [];
  const recent = recentHandoffs(handoffs, props.bots, bot.id, 3);
  const notices = useBotNotices().filter(
    (notice) => notice.environmentId === environmentId && notice.from?.id === bot.id,
  );
  const folder = useAtomValue(
    environmentProjects.environmentProjectIndexAtom(environmentId),
    (index) => index.get(bot.projectId)?.workspaceRoot ?? null,
  );
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = state.status === "working" || state.status === "needs-you";
  const open = (threadId: string) =>
    setThreadKey(scopedThreadKey(scopeThreadRef(environmentId, threadId as ThreadId)));

  const toggleArchive = async () => {
    setError(null);
    const failure = await runCommand(
      registry,
      forkBotsSetArchivedCommand,
      { environmentId, input: { id: bot.id, archived: !bot.archived } },
      bot.archived ? "No se pudo restaurar el bot" : "No se pudo archivar el bot",
    );
    if (failure !== null) return setError(failure);
    refreshBots(registry, environmentId);
  };

  const remove = async () => {
    const agreed = await confirm.ask({
      title: `¿Eliminar el bot «${bot.name}»?`,
      description: "Su hilo y su historial se conservan.",
      confirmLabel: "Eliminar",
    });
    if (!agreed) return;
    setError(null);
    const failure = await runCommand(
      registry,
      forkBotsRemoveCommand,
      { environmentId, input: { id: bot.id } },
      "No se pudo eliminar el bot",
    );
    if (failure !== null) return setError(failure);
    setSelectedKey(null);
    refreshBots(registry, environmentId);
  };

  return (
    <div className="gb-pane">
      <div className="gb-glabel">Por detrás</div>
      <div className="gb-grpl">
        <button
          type="button"
          className="gb-it"
          disabled={bot.threadId === null}
          onClick={() => bot.threadId !== null && open(bot.threadId)}
        >
          <span className="gb-ic gb-ic-sky" aria-hidden>
            <MonitorIcon size={17} />
          </span>
          Hilo de trabajo en T3 Code
          <span className="gb-r">
            {bot.threadId === null
              ? "Aún sin hilo"
              : `${1 + children.length} ${children.length === 0 ? "hilo" : "hilos"}`}
            <ArrowSquareOutIcon size={15} aria-hidden />
          </span>
        </button>
        {bot.threadId !== null && busy ? (
          <BotProgress
            environmentId={environmentId}
            threadId={bot.threadId}
            runId={thread?.latestRun?.runId ?? null}
          />
        ) : null}
      </div>
      {bot.handoffToolsMissing ? (
        <p className="gb-warn">
          <span className="ade-chip" data-kind="approval">
            Sin traspasos
          </span>
          En su último turno, su proveedor no cargó las herramientas de T3: no puede pasar trabajo a
          otros bots.
        </p>
      ) : null}

      <div className="gb-glabel">Modelo</div>
      <div className="gb-grpl">
        <button
          type="button"
          className="gb-it"
          disabled={canWrite !== true}
          onClick={() => setEditing(true)}
        >
          <span className="gb-ic gb-ic-model" aria-hidden>
            <SparkleIcon size={17} />
          </span>
          {model === undefined
            ? bot.modelSelection.model
            : `${model.providerLabel} · ${model.modelName}`}
          <span className="gb-r">
            {RUNTIME_MODE_TEXT[bot.runtimeMode]}
            <CaretRightIcon size={15} aria-hidden />
          </span>
        </button>
      </div>
      {bot.threadId !== null && busy ? (
        <div className="gb-spend">
          <BotSpend
            environmentId={environmentId}
            threadId={bot.threadId}
            model={bot.modelSelection.model}
            provider={provider}
          />
        </div>
      ) : null}

      <div className="gb-glabel">Linaje</div>
      <div className="gb-grpl">
        <div className="gb-it">
          <AgentAvatar kind={botMascot(bot)} className="gb-av-sm" />
          {bot.name}
          <span className="gb-r">
            <span className="gb-chip gb-chip-sky">Esta conversación</span>
          </span>
        </div>
        {children.length === 0 ? null : (
          <>
            <div className="gb-sublab">Subagentes</div>
            {children.map((child) => {
              const childState = threadState(child);
              return (
                <button
                  key={child.id}
                  type="button"
                  className="gb-it gb-child"
                  onClick={() => open(child.id)}
                >
                  <span className="gb-tx">{child.title}</span>
                  <span className="gb-r">
                    <span className="gb-chip" data-state={childState}>
                      {CHILD_STATE[childState]}
                    </span>
                  </span>
                </button>
              );
            })}
          </>
        )}
        {recent.length === 0 ? null : (
          <>
            <div className="gb-sublab">Traspasos</div>
            {recent.map(({ handoff, direction, peer }) => (
              <div key={handoff.id} className="gb-it gb-child">
                {direction === "in" ? (
                  <ArrowBendDownRightIcon size={15} aria-hidden />
                ) : (
                  <ArrowBendUpRightIcon size={15} aria-hidden />
                )}
                <span className="gb-tx">
                  {direction === "in" ? `De ${peer}` : `A ${peer}`}
                  <span className="gb-sub">{handoff.preview}</span>
                </span>
                {handoff.status === "delivered" ? null : (
                  <span className="gb-r">
                    <span
                      className="gb-chip"
                      data-state={handoff.status === "cut" ? "needs-you" : undefined}
                    >
                      {HANDOFF_STATUS_LABELS[handoff.status]}
                    </span>
                  </span>
                )}
              </div>
            ))}
          </>
        )}
      </div>

      <div className="gb-glabel">Rutinas</div>
      <div className="gb-grpl gb-box">
        <BotRoutines environmentId={environmentId} bot={bot} confirm={confirm.ask} />
      </div>

      <div className="gb-glabel">Avisos</div>
      {notices.length === 0 ? (
        <div className="gb-grpl">
          <p className="gb-it gb-quiet">Nada pendiente de {bot.name}.</p>
        </div>
      ) : (
        <div className="gb-notices">
          <BotNotices
            include={(key) => notices.some((notice) => notice.key === key)}
            onOpenBackLayer={setThreadKey}
          />
        </div>
      )}

      <div className="gb-glabel">Conexiones</div>
      <div className="gb-grpl gb-box">
        <IntegrationConnections environmentId={environmentId} />
      </div>

      <div className="gb-glabel">Carpeta</div>
      <div className="gb-grpl">
        <div className="gb-it">
          <span className="gb-ic" aria-hidden>
            <FolderIcon size={17} />
          </span>
          <span className="gb-mono">
            {props.machineLabel} · {folder ?? "proyecto no disponible"}
          </span>
        </div>
      </div>

      <div className="gb-glabel">Bot</div>
      <div className="gb-grpl">
        <button
          type="button"
          className="gb-it"
          disabled={canWrite !== true}
          onClick={() => setEditing(true)}
        >
          <PencilIcon size={16} aria-hidden />
          Editar
        </button>
        <button
          type="button"
          className="gb-it"
          disabled={canWrite !== true}
          onClick={() => void toggleArchive()}
        >
          <ArchiveIcon size={16} aria-hidden />
          {bot.archived ? "Restaurar" : "Archivar"}
        </button>
        <button
          type="button"
          className="gb-it gb-danger"
          disabled={canWrite !== true}
          onClick={() => void remove()}
        >
          <TrashIcon size={16} aria-hidden />
          Eliminar
        </button>
      </div>
      {error === null ? null : (
        <p className="ade-error" role="alert">
          {error}
        </p>
      )}
      {confirm.dialog}
      {editing ? (
        <BotEditor
          bot={bot}
          environmentId={environmentId}
          machines={[environmentId]}
          pairedCount={1}
          machineLabel={() => props.machineLabel}
          onSaved={() => undefined}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </div>
  );
}

const CHILD_STATE: Record<ReturnType<typeof threadState>, string> = {
  "needs-you": "Espera",
  working: "Trabajando",
  error: "Falló",
  done: "Hecho",
};

function BotMemory(props: { environmentId: EnvironmentId; bot: ForkBot; machineLabel: string }) {
  const { environmentId, bot } = props;
  const project = useAtomValue(
    environmentProjects.environmentProjectIndexAtom(environmentId),
    (index) => index.get(bot.projectId) ?? null,
  );
  if (project === null) {
    return <p className="gb-empty">El proyecto de {bot.name} no está en esta máquina.</p>;
  }
  return (
    <div className="gb-pane gb-memory">
      <ProjectMemoryCard
        target={{
          key: homeProjectKey(environmentId, project.id),
          environmentId,
          machineLabel: props.machineLabel,
          project,
        }}
      />
      <details className="gb-fold">
        <summary>Editar las notas a mano</summary>
        <ProjectMemory environmentId={environmentId} bot={bot} />
      </details>
    </div>
  );
}

function BotMission(props: {
  environmentId: EnvironmentId;
  bot: ForkBot;
  bots: ReadonlyArray<ForkBot>;
}) {
  const { environmentId, bot } = props;
  const mission = useBotMission(environmentId, bot, props.bots);
  const openMission = useOpenMission();
  const setView = useAtomSet(viewAtom);
  const across = useAtomValue(missionsLiveAtom);
  const threads = useAtomValue(listedThreadsAtom);
  if (mission === null || mission.detail === undefined) {
    return (
      <div className="gb-pane">
        <p className="gb-empty">
          {mission === null
            ? `${bot.name} no lleva ningún paso de una misión en marcha.`
            : "Cargando la misión…"}
        </p>
        <button type="button" className="gb-jump" onClick={() => setView("misiones")}>
          <TargetIcon size={18} aria-hidden />
          Ver las misiones
        </button>
      </div>
    );
  }
  const { run } = mission.node;
  const snapshot = Option.getOrUndefined(
    AsyncResult.value(
      across.find((entry) => entry.environmentId === environmentId)?.result ??
        AsyncResult.initial(),
    ),
  );
  const questions = (snapshot?.questions ?? []).filter((question) => question.runId === run.runId);
  const cards = missionCards({
    detail: mission.detail,
    questions,
    bots: props.bots,
    threadNeedsYou: (threadId) => {
      const thread = threads.find(
        (candidate) => candidate.environmentId === environmentId && candidate.id === threadId,
      );
      return thread !== undefined && threadState(thread) === "needs-you";
    },
    now: DateTime.toEpochMillis(DateTime.nowUnsafe()),
  });
  const state = missionState(run, questions.length);
  const done = cards.filter((card) => card.column === "done").length;
  const open = () => openMission(environmentId, run.runId);
  return (
    <div className="gb-pane">
      <div className="gb-mhead">
        <span className="gb-ic gb-ic-mission" aria-hidden>
          <TargetIcon size={18} />
        </span>
        <span className="gb-tx">
          <b>{run.title || run.workflow}</b>
          <small>{run.subject?.title ? run.subject.title : `Flujo ${run.workflow}`}</small>
        </span>
        <span className="gb-chip" data-tone={state.tone}>
          {state.word}
        </span>
      </div>
      {cards.length === 0 ? null : (
        <>
          <div className="gb-bar" aria-hidden>
            <i style={{ width: `${Math.round((done / cards.length) * 100)}%` }} />
          </div>
          <p className="gb-prog">
            <span>
              <b>
                {done} de {cards.length}
              </b>{" "}
              pasos
            </span>
          </p>
        </>
      )}
      <div className="gb-board" aria-label="Tablero de la misión">
        {MISSION_COLUMNS.map((column) => {
          const list = cards.filter((card) => card.column === column.id);
          return (
            <section
              key={column.id}
              className="gb-lane"
              data-column={column.id}
              aria-label={column.title}
            >
              <h3 className="gb-lh">
                <i aria-hidden />
                {column.title}
                <span>{list.length}</span>
              </h3>
              {list.map((card) => (
                <button key={card.key} type="button" className="gb-card" onClick={open}>
                  {card.title}
                  <small>
                    {card.bot === null ? null : (
                      <AgentAvatar kind={botMascot(card.bot)} className="gb-av-xs" />
                    )}
                    {card.bot === null ? "flujo" : card.bot.name} · {card.status}
                  </small>
                </button>
              ))}
            </section>
          );
        })}
      </div>
      <button type="button" className="gb-jump" onClick={open}>
        <MonitorIcon size={18} aria-hidden />
        Abrir la misión
      </button>
    </div>
  );
}

const NO_TURN_ITEMS: ReadonlyArray<ThreadStructureTurnItem> = [];

/** A thin line for the latest run's plan; with no plan there is no real progress, so no line. */
function BotProgress(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  runId: string | null;
}) {
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  // The quiet thread keeps its value while replies stream, so tokens re-render nothing here.
  const turnItems =
    useAtomValue(environmentThreadDetails.quietThreadAtom(threadRef))?.projection.turnItems ??
    NO_TURN_ITEMS;
  const chip = planStepChip(turnItems, props.runId);
  if (chip === null) return null;
  const done = chip.steps.filter((step) => step.status === "completed").length;
  return (
    <div
      className="ade-bot-progress"
      role="progressbar"
      aria-label={`Paso ${chip.number} de ${chip.total}`}
      aria-valuemin={0}
      aria-valuemax={chip.total}
      aria-valuenow={done}
    >
      <span style={{ width: `${(done / chip.total) * 100}%` }} />
    </div>
  );
}

const FALLBACK_TEXT: Record<NonNullable<ForkBotDraft["fallbackReason"]>, string> = {
  noModel:
    "Propuesta sin IA: el modelo que redacta no está disponible en esta máquina. Se elige en Ajustes → General de T3.",
  modelNotAllowed:
    "Propuesta sin IA: el modelo elegido para redactar no está en la lista permitida (Gemini Flash o Kimi). Cámbialo en Ajustes → General de T3.",
  modelFailed: "Propuesta sin IA: el modelo que redacta no respondió.",
  invalidReply: "Propuesta sin IA: el modelo devolvió un borrador que no sirve.",
};

const formFrom = (draft: ForkBotDraft): BotDraft => ({
  handle: draft.handle,
  name: draft.name,
  role: draft.role,
  instructions: draft.instructions,
  projectId: draft.projectId,
  runtimeMode: draft.runtimeMode,
  instanceId: draft.modelSelection.instanceId,
  model: draft.modelSelection.model,
  coordinator: false,
});

/**
 * «Nuevo bot» and «Editar»: one sheet. A new bot can start from a sentence, which proposes the
 * fields; with several machines the user picks machine and project before it goes anywhere.
 */
function BotEditor(props: {
  bot: ForkBot | null;
  /** The bot's machine; null for a new bot, which picks one. */
  environmentId: EnvironmentId | null;
  machines: ReadonlyArray<EnvironmentId>;
  // Every paired machine, usable or not: with more than one, a sentence never picks for the user.
  pairedCount: number;
  machineLabel: (id: EnvironmentId) => string;
  onSaved: (environmentId: EnvironmentId, handle: string) => void;
  onClose: () => void;
}) {
  const { bot, onClose } = props;
  const registry = useContext(RegistryContext);
  const dialog = useRef<HTMLDialogElement>(null);
  const allProjects = useAtomValue(allEnvironmentProjectsAtom);
  const [machine, setMachine] = useState<EnvironmentId | null>(
    () => props.environmentId ?? (props.pairedCount > 1 ? null : (props.machines[0] ?? null)),
  );
  // Creating is offered only with a machine enabled; until one is picked, the first lends its models.
  const environmentId = machine ?? props.machines[0]!;
  const projects = machine === null ? [] : [...(allProjects.get(machine)?.values() ?? [])];
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const models = useMemo(() => availableMachineModelOptions(serverConfig), [serverConfig]);
  const canDraft = useAtomValue(forkBotsDraftCommand.permissionAtom(environmentId));
  const [draft, setDraft] = useState<BotDraft>(() => ({
    handle: bot?.handle ?? "",
    name: bot?.name ?? "",
    role: bot?.role ?? "",
    instructions: bot?.instructions ?? "",
    projectId: bot?.projectId ?? "",
    runtimeMode: bot?.runtimeMode ?? "approval-required",
    instanceId: bot?.modelSelection.instanceId ?? "",
    model: bot?.modelSelection.model ?? "",
    coordinator: bot?.coordinator ?? false,
  }));
  const [integrations, setIntegrations] = useState(bot?.integrations ?? {});
  const [sentence, setSentence] = useState("");
  const [proposal, setProposal] = useState<ForkBotDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The native modal dialog traps focus, handles Escape, and returns focus to the opener.
  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  // With one machine, the first listed project and model stand in until the user picks, as the
  // selects show; with several, the project waits for a pick.
  const pickProject = props.pairedCount > 1 && bot === null;
  const projectId =
    draft.projectId === "" && !pickProject ? (projects[0]?.id ?? "") : draft.projectId;
  const firstModel = models[0];
  const modelKey =
    draft.model === ""
      ? firstModel === undefined
        ? ""
        : `${firstModel.instanceId}${MODEL_SEPARATOR}${firstModel.model}`
      : `${draft.instanceId}${MODEL_SEPARATOR}${draft.model}`;
  const set = (patch: Partial<BotDraft>) => setDraft((current) => ({ ...current, ...patch }));
  // From a sentence the mode stays low; an existing bot's editor keeps every mode, as before.
  const modes = proposal !== null ? SENTENCE_RUNTIME_MODES : RUNTIME_MODES;

  const propose = async () => {
    const text = sentence.trim();
    if (text === "" || busy) return;
    const machines = props.machines.map((id) => ({
      environmentId: id,
      projects: [...(allProjects.get(id)?.values() ?? [])],
    }));
    const picked =
      machine !== null && draft.projectId !== ""
        ? { environmentId: machine, projectId: draft.projectId as ProjectId }
        : null;
    const destination = botDestination(text, machines, picked, props.pairedCount);
    if (destination.kind === "ask") {
      return setError("Elige la máquina y el proyecto antes de proponer.");
    }
    if (destination.kind === "wait") {
      return setError("Los proyectos de esa máquina aún se están cargando. Prueba en un momento.");
    }
    const where = destination.target;
    setBusy(true);
    setError(null);
    const failure = await runCommand(
      registry,
      forkBotsDraftCommand,
      { environmentId: where.environmentId, input: { text, projectId: where.projectId } },
      "No se pudo proponer el bot",
      (next) => {
        setMachine(where.environmentId);
        setDraft(formFrom(next));
        setProposal(next);
      },
    );
    setBusy(false);
    if (failure !== null) setError(failure);
  };

  const save = async () => {
    if (machine === null) return setError("Elige la máquina.");
    const [instanceId = "", model = ""] = modelKey.split(MODEL_SEPARATOR);
    const validated = validateBotDraft({ ...draft, projectId, instanceId, model }, modes);
    if (!validated.ok) return setError(validated.error);
    setBusy(true);
    setError(null);
    const failure = await runCommand(
      registry,
      forkBotsUpsertCommand,
      {
        environmentId: machine,
        input: {
          ...(bot === null ? {} : { id: bot.id }),
          handle: validated.value.handle,
          name: validated.value.name,
          role: validated.value.role,
          instructions: validated.value.instructions,
          projectId: validated.value.projectId,
          runtimeMode: validated.value.runtimeMode,
          modelSelection: { instanceId: validated.value.instanceId, model: validated.value.model },
          coordinator: validated.value.coordinator,
          integrations,
        },
      },
      "No se pudo guardar el bot",
    );
    setBusy(false);
    if (failure !== null) return setError(failure);
    refreshBots(registry, machine);
    props.onSaved(machine, validated.value.handle);
    dialog.current?.close();
  };

  return (
    <dialog ref={dialog} className="gb-new" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <header className="gb-hdr">
          <button type="button" className="gb-txtbtn" onClick={() => dialog.current?.close()}>
            Cancelar
          </button>
          <b>{bot === null ? "Nuevo bot" : `Editar ${bot.name}`}</b>
          <button type="submit" className="gb-txtbtn gb-b" disabled={busy}>
            {bot === null ? "Crear" : "Guardar"}
          </button>
        </header>
        <div className="gb-idn">
          <AgentAvatar
            kind={botMascot({ handle: draft.handle, coordinator: draft.coordinator })}
            className="gb-av-lg"
          />
        </div>
        <label>
          <span className="ade-sr-only">Nombre</span>
          <input
            className="gb-name"
            value={draft.name}
            onChange={(event) => set({ name: event.target.value })}
            placeholder="Nombre"
          />
        </label>

        {bot === null ? (
          <>
            <div className="gb-glabel">O descríbelo en una frase</div>
            <div className="gb-propose">
              <label className="gb-field">
                <span className="ade-sr-only">Describe el bot que quieres</span>
                <textarea
                  value={sentence}
                  onChange={(event) => setSentence(event.target.value)}
                  placeholder="Un bot que revise mis PR cada mañana"
                  rows={2}
                  maxLength={FORK_BOTS_DRAFT_TEXT_MAX_LENGTH}
                />
              </label>
              <button
                type="button"
                className="gb-pill"
                disabled={busy || canDraft !== true || sentence.trim() === ""}
                onClick={() => void propose()}
              >
                {busy && proposal === null ? "Pensando…" : "Proponer"}
              </button>
            </div>
            {proposal === null ? null : (
              <p className="gb-note" role="status">
                {proposal.fallbackReason === null
                  ? `Redactado por ${proposal.draftedBy?.model ?? "el modelo"}. Revísalo y pulsa Crear.`
                  : FALLBACK_TEXT[proposal.fallbackReason]}
                {proposal.routine === ""
                  ? ""
                  : ` Rutina propuesta: ${proposal.routine} (la añades en su ficha cuando exista).`}
              </p>
            )}
          </>
        ) : null}

        <div className="gb-glabel">Quién es</div>
        <div className="gb-grpl">
          <label className="gb-it">
            Handle
            <input
              className="gb-r"
              value={draft.handle}
              onChange={(event) => set({ handle: event.target.value })}
              placeholder="ej. general-manager"
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          <label className="gb-it">
            Rol
            <input
              className="gb-r"
              value={draft.role}
              onChange={(event) => set({ role: event.target.value })}
            />
          </label>
        </div>

        <div className="gb-glabel">Dónde trabaja</div>
        <div className="gb-grpl">
          <label className="gb-it">
            <span className="gb-ic gb-ic-model" aria-hidden>
              <SparkleIcon size={17} />
            </span>
            Modelo
            <select
              className="gb-r"
              value={modelKey}
              onChange={(event) => {
                const [instanceId = "", model = ""] = event.target.value.split(MODEL_SEPARATOR);
                set({ instanceId, model });
              }}
            >
              {models.length === 0 ? <option value="">Sin modelos disponibles</option> : null}
              {modelKey !== "" &&
              !models.some(
                (option) => `${option.instanceId}${MODEL_SEPARATOR}${option.model}` === modelKey,
              ) ? (
                <option value={modelKey}>{draft.model} (no disponible)</option>
              ) : null}
              {models.map((option) => {
                const key = `${option.instanceId}${MODEL_SEPARATOR}${option.model}`;
                return (
                  <option key={key} value={key}>
                    {option.providerLabel} · {option.modelName}
                  </option>
                );
              })}
            </select>
          </label>
          {bot === null && props.machines.length > 1 ? (
            <div className="gb-it">
              Máquina
              <div className="gb-mseg" role="group" aria-label="Máquina">
                {props.machines.map((id) => (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={machine === id}
                    onClick={() => {
                      setMachine(id);
                      set({ projectId: "", instanceId: "", model: "" });
                    }}
                  >
                    {props.machineLabel(id)}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <label className="gb-it">
            <span className="gb-ic" aria-hidden>
              <FolderIcon size={17} />
            </span>
            Proyecto
            <select
              className="gb-r"
              value={projectId}
              onChange={(event) => set({ projectId: event.target.value })}
            >
              {projectId === "" ? (
                <option value="">
                  {machine === null
                    ? "Elige antes la máquina"
                    : projects.length === 0
                      ? "Sin proyectos"
                      : "Elige…"}
                </option>
              ) : null}
              {projectId !== "" && !projects.some((project) => project.id === projectId) ? (
                <option value={projectId}>(proyecto no disponible)</option>
              ) : null}
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.title}
                </option>
              ))}
            </select>
          </label>
          <label className="gb-it">
            Permisos
            <select
              className="gb-r"
              value={draft.runtimeMode}
              onChange={(event) =>
                set({ runtimeMode: event.target.value as BotDraft["runtimeMode"] })
              }
            >
              {modes.map((mode) => (
                <option key={mode} value={mode}>
                  {RUNTIME_MODE_TEXT[mode]}
                </option>
              ))}
            </select>
          </label>
          <label className="gb-it">
            <span className="gb-tx">
              Coordinador del proyecto
              <span className="gb-sub">
                Lee y actualiza la memoria del proyecto y reparte el trabajo en hilos hijos. Solo
                uno por proyecto.
              </span>
            </span>
            <input
              type="checkbox"
              className="gb-check"
              checked={draft.coordinator}
              onChange={(event) => set({ coordinator: event.target.checked })}
            />
          </label>
        </div>

        <div className="gb-box gb-levels">
          <IntegrationLevels value={integrations} onChange={setIntegrations} />
        </div>

        <div className="gb-glabel">Instrucciones</div>
        <label className="gb-field gb-area">
          <span className="ade-sr-only">Instrucciones</span>
          <textarea
            value={draft.instructions}
            onChange={(event) => set({ instructions: event.target.value })}
            rows={5}
          />
        </label>
        {bot?.threadId == null ? null : (
          <p className="gb-note">
            Si cambias nombre, rol, instrucciones, proyecto, modelo, permisos o coordinador, el
            siguiente mensaje abre un hilo nuevo. El anterior se conserva.
          </p>
        )}
        {error === null ? null : (
          <p className="ade-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </dialog>
  );
}
