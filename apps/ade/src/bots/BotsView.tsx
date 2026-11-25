import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { ArchiveIcon } from "@phosphor-icons/react/dist/csr/Archive";
import { ArrowBendDownRightIcon } from "@phosphor-icons/react/dist/csr/ArrowBendDownRight";
import { ArrowBendUpRightIcon } from "@phosphor-icons/react/dist/csr/ArrowBendUpRight";
import { PaperPlaneTiltIcon } from "@phosphor-icons/react/dist/csr/PaperPlaneTilt";
import { PencilIcon } from "@phosphor-icons/react/dist/csr/Pencil";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import { UserCircleIcon } from "@phosphor-icons/react/dist/csr/UserCircle";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ThreadStructureTurnItem } from "@t3tools/client-runtime/state/models";
import {
  FORK_BOTS_DRAFT_TEXT_MAX_LENGTH,
  FORK_BOTS_MESSAGE_MAX_LENGTH,
  type EnvironmentId,
  type ForkBot,
  type ForkBotDraft,
  type ProjectId,
  type ForkBotHandoff,
  type ForkBotHandoffStatus,
  type ThreadId,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { useContext, useEffect, useMemo, useRef, useState } from "react";

import { RUNTIME_MODE_TEXT, runCommand } from "../composer/Composer.tsx";
import { allEnvironmentProjectsAtom } from "../coordination/coordination.state.ts";
import { environmentCatalog } from "../connection/runtime.ts";
import { availableMachineModelOptions } from "../failover/failover.logic.ts";
import { listedThreadsAtom, selectedThreadKeyAtom } from "../sidebar/Sidebar.tsx";
import { environmentThreadDetails, serverEnvironment } from "../state.ts";
import { planStepChip } from "../timeline/timeline.logic.ts";
import {
  botState,
  type BotDraft,
  parseMention,
  type BotMachine,
  type BotProjectChoice,
  botDestination,
  suggestBotProject,
  recentHandoffs,
  RUNTIME_MODES,
  SENTENCE_RUNTIME_MODES,
  routineThreadIds,
  validateBotDraft,
} from "./bots.logic.ts";
import { BotAvatar } from "./BotAvatar.tsx";
import { useConfirm } from "../ui/primitives/confirm.tsx";
import { Tabs, TabsList, TabsPanel, TabsTab } from "../ui/primitives/tabs.tsx";
import { ProjectMemory } from "./ProjectMemory.tsx";
import { BotSpend } from "../overview/Spend.tsx";
import { USAGE_PROVIDER_OF_DRIVER } from "../overview/spend.state.ts";
import {
  allBotsAtom,
  forkBotsDraftCommand,
  forkBotsHandoffCommand,
  forkBotsRemoveCommand,
  forkBotsSendMessageCommand,
  forkBotsSetArchivedCommand,
  forkBotsUpsertCommand,
  refreshBots,
} from "./bots.state.ts";

const MODEL_SEPARATOR = "\u0000";

export const HANDOFF_STATUS_LABELS: Record<ForkBotHandoffStatus, string> = {
  pending: "Enviando",
  delivered: "Entregado",
  cut: "Cortado",
  failed: "Falló",
  dismissed: "Descartado",
};

export function BotsView() {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const { byEnv, handoffsByEnv, errors } = useAtomValue(allBotsAtom);
  const enabledEnvs = useMemo(() => [...enabledEnvironmentIds(catalog)], [catalog]);
  const [selectedEnvState, setSelectedEnv] = useState<EnvironmentId | null>(null);
  const selectedEnv =
    selectedEnvState !== null && enabledEnvs.includes(selectedEnvState)
      ? selectedEnvState
      : (enabledEnvs[0] ?? null);
  const machineLabel = (id: EnvironmentId) => catalog.entries.get(id)?.target.label ?? id;
  const bots = selectedEnv === null ? undefined : byEnv.get(selectedEnv);

  return (
    <div className="ade-projects ade-bots">
      <header className="ade-projects-header">
        <div>
          <p className="ade-label">Capa frontal</p>
          <h1>Bots</h1>
          <p className="ade-projects-subtitle">
            Cada bot conversa en un hilo real del proyecto que elijas.
          </p>
        </div>
        {enabledEnvs.length > 1 && selectedEnv !== null ? (
          <label className="ade-failover-machine-picker">
            <span className="ade-sr-only">Máquina</span>
            <select
              value={selectedEnv}
              onChange={(event) => setSelectedEnv(event.currentTarget.value as EnvironmentId)}
            >
              {enabledEnvs.map((id) => (
                <option key={id} value={id}>
                  {machineLabel(id)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </header>

      {errors.length === 0 ? null : (
        <div className="ade-error" role="status">
          {errors.map((failure) => (
            <p key={failure.environmentId} className="ade-coord-load-error">
              {machineLabel(failure.environmentId)}: {failure.message}
            </p>
          ))}
        </div>
      )}

      {selectedEnv === null ? null : (
        <QuickCreate
          fallbackEnv={selectedEnv}
          machines={enabledEnvs}
          pairedCount={catalog.entries.size}
          machineLabel={machineLabel}
          onCreated={setSelectedEnv}
        />
      )}

      {selectedEnv === null || bots === undefined ? (
        <section className="ade-projects-empty">
          <p>
            {selectedEnv === null
              ? "No hay máquinas habilitadas en este momento."
              : errors.some((failure) => failure.environmentId === selectedEnv)
                ? "No se pudo leer el directorio de bots de esta máquina."
                : "Cargando bots…"}
          </p>
        </section>
      ) : (
        <MachineBots
          key={selectedEnv}
          environmentId={selectedEnv}
          bots={bots}
          handoffs={handoffsByEnv.get(selectedEnv) ?? []}
        />
      )}
    </div>
  );
}

function MachineBots(props: {
  environmentId: EnvironmentId;
  bots: ReadonlyArray<ForkBot>;
  handoffs: ReadonlyArray<ForkBotHandoff>;
}) {
  const { environmentId, bots, handoffs } = props;
  const registry = useContext(RegistryContext);
  const allThreads = useAtomValue(listedThreadsAtom);
  const setSelectedKey = useAtomSet(selectedThreadKeyAtom);
  const canWrite = useAtomValue(forkBotsUpsertCommand.permissionAtom(environmentId));
  const canSend = useAtomValue(forkBotsSendMessageCommand.permissionAtom(environmentId));
  const tasksResult = useAtomValue(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const routines = useMemo(
    () => routineThreadIds(tasksResult._tag === "Success" ? tasksResult.value.tasks : []),
    [tasksResult],
  );
  const threadOf = (bot: ForkBot) =>
    allThreads.find(
      (candidate) => candidate.environmentId === environmentId && candidate.id === bot.threadId,
    );
  const providers = useAtomValue(serverEnvironment.configValueAtom(environmentId))?.providers;
  const providerOf = (bot: ForkBot) => {
    const driver = providers?.find(
      (provider) => provider.instanceId === bot.modelSelection.instanceId,
    )?.driver;
    return driver === undefined ? null : (USAGE_PROVIDER_OF_DRIVER[String(driver)] ?? null);
  };
  const stateOf = (bot: ForkBot) =>
    botState(bot, threadOf(bot), bot.threadId !== null && routines.has(bot.threadId));
  const [editing, setEditing] = useState<ForkBot | null>(null);
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const [messageText, setMessageTextState] = useState("");
  const [chatNote, setChatNote] = useState<string | null>(null);
  // Kept until the handoff goes through, so a retry after an error is recognised as the same one.
  const [handoffId, setHandoffId] = useState<string | null>(null);
  const setMessageText = (text: string) => {
    setMessageTextState(text);
    setHandoffId(null);
  };
  const [sending, setSending] = useState(false);
  const [panel, setPanel] = useState<"chat" | "memory">("chat");
  const confirm = useConfirm();

  const selectedBot = bots.find((bot) => bot.id === selectedBotId) ?? null;
  const openThread = (threadId: ThreadId) =>
    setSelectedKey(scopedThreadKey(scopeThreadRef(environmentId, threadId)));

  const toggleArchive = async (bot: ForkBot) => {
    setListError(null);
    const failure = await runCommand(
      registry,
      forkBotsSetArchivedCommand,
      { environmentId, input: { id: bot.id, archived: !bot.archived } },
      bot.archived ? "No se pudo restaurar el bot" : "No se pudo archivar el bot",
    );
    if (failure !== null) return setListError(failure);
    refreshBots(registry, environmentId);
  };

  const removeBot = async (bot: ForkBot) => {
    const agreed = await confirm.ask({
      title: `¿Eliminar el bot «${bot.name}»?`,
      description: "Su hilo y su historial se conservan.",
      confirmLabel: "Eliminar",
    });
    if (!agreed) return;
    setListError(null);
    const failure = await runCommand(
      registry,
      forkBotsRemoveCommand,
      { environmentId, input: { id: bot.id } },
      "No se pudo eliminar el bot",
    );
    if (failure !== null) return setListError(failure);
    if (selectedBotId === bot.id) setSelectedBotId(null);
    refreshBots(registry, environmentId);
  };

  const sendMessage = async () => {
    const text = messageText.trim();
    if (selectedBot === null || text === "") return;
    setSending(true);
    setChatError(null);
    setChatNote(null);
    const mention = parseMention(
      text,
      bots.filter((bot) => bot.id !== selectedBot.id).map((bot) => bot.handle),
    );
    if (mention !== null) {
      const id = handoffId ?? `handoff:${SecureRandom.uuidV4Unsafe()}`;
      setHandoffId(id);
      const failure = await runCommand(
        registry,
        forkBotsHandoffCommand,
        {
          environmentId,
          input: { id, fromId: selectedBot.id, toHandle: mention.handle, text: mention.text },
        },
        `No se pudo pasar el trabajo a @${mention.handle}`,
        // From the ADE the user hands it over, so the chain starts at hop 1 and is never cut here.
        (result) =>
          setChatNote(
            `Pasado a @${mention.handle}${result.duplicate ? " (ya se había enviado)" : ""}.`,
          ),
      );
      setSending(false);
      if (failure !== null) return setChatError(failure);
      setMessageText("");
      refreshBots(registry, environmentId);
      return;
    }
    const failure = await runCommand(
      registry,
      forkBotsSendMessageCommand,
      { environmentId, input: { id: selectedBot.id, text } },
      "No se pudo enviar el mensaje al bot",
      (result) => openThread(result.threadId),
    );
    setSending(false);
    if (failure !== null) return setChatError(failure);
    setMessageText("");
    refreshBots(registry, environmentId);
  };

  const chatPanel = (selectedBot: ForkBot) => (
    <>
      <p className="ade-bot-meta">
        {selectedBot.threadId === null
          ? "Tu primer mensaje abre su hilo real en el proyecto."
          : "Los mensajes van a su hilo real; ahí ves la respuesta."}
      </p>
      <textarea
        value={messageText}
        onChange={(event) => setMessageText(event.target.value)}
        placeholder={`Mensaje para @${selectedBot.handle}`}
        aria-describedby="ade-bot-mention-hint"
        rows={3}
        maxLength={FORK_BOTS_MESSAGE_MAX_LENGTH}
        disabled={selectedBot.archived}
      />
      <button
        type="button"
        className="ade-button"
        onClick={() => void sendMessage()}
        disabled={sending || canSend !== true || selectedBot.archived || messageText.trim() === ""}
      >
        <PaperPlaneTiltIcon size={16} aria-hidden /> Enviar
      </button>
      <MentionHint
        handles={bots
          .filter((bot) => bot.id !== selectedBot.id && !bot.archived)
          .map((bot) => bot.handle)}
        onPick={(handle) => setMessageText(`@${handle} ${messageText.replace(/^@\S*\s*/, "")}`)}
      />
      {chatNote === null ? null : (
        <p className="ade-bot-meta" role="status">
          {chatNote}
        </p>
      )}
      {selectedBot.archived ? (
        <p className="ade-bot-meta">Restaura el bot para escribirle.</p>
      ) : null}
      {chatError === null ? null : (
        <p className="ade-error" role="alert">
          {chatError}
        </p>
      )}
    </>
  );

  return (
    <>
      {listError === null ? null : (
        <p className="ade-error" role="alert">
          {listError}
        </p>
      )}

      <div className="ade-bots-layout">
        <section className="ade-bots-list" aria-label="Directorio de bots">
          {bots.length === 0 ? (
            <div className="ade-projects-empty">
              <p>Aún no hay bots en esta máquina.</p>
            </div>
          ) : null}
          {bots.map((bot) => {
            const state = stateOf(bot);
            return (
              <article
                key={bot.id}
                className="ade-bot-card"
                data-selected={bot.id === selectedBotId ? "" : undefined}
                data-archived={bot.archived ? "" : undefined}
              >
                <button
                  type="button"
                  className="ade-bot-card-main"
                  onClick={() => {
                    if (bot.id === selectedBotId) return;
                    setSelectedBotId(bot.id);
                    setMessageText("");
                    setChatError(null);
                    setChatNote(null);
                    setPanel("chat");
                  }}
                  aria-pressed={bot.id === selectedBotId}
                >
                  <BotAvatar status={state.status} />
                  <span className="ade-bot-card-text">
                    <strong>{bot.name}</strong>
                    <span className="ade-bot-meta">
                      @{bot.handle} · {bot.role}
                      {bot.coordinator ? " · Coordinador" : ""}
                    </span>
                    <span className="ade-bot-meta">
                      {bot.modelSelection.instanceId} · {bot.modelSelection.model}
                    </span>
                    {/* Same condition as BotProgress: only a thread the card already follows. */}
                    {bot.threadId !== null &&
                    (state.status === "working" || state.status === "needs-you") ? (
                      <BotSpend
                        environmentId={environmentId}
                        threadId={bot.threadId}
                        model={bot.modelSelection.model}
                        provider={providerOf(bot)}
                      />
                    ) : null}
                  </span>
                  <span className="ade-bot-status" data-status={state.status}>
                    {state.label}
                  </span>
                </button>
                {bot.threadId !== null &&
                (state.status === "working" || state.status === "needs-you") ? (
                  <BotProgress
                    environmentId={environmentId}
                    threadId={bot.threadId}
                    runId={threadOf(bot)?.latestRun?.runId ?? null}
                  />
                ) : null}
                <BotHandoffs entries={recentHandoffs(handoffs, bots, bot.id, 3)} />
                <div className="ade-bot-actions">
                  <button
                    type="button"
                    className="ade-button-quiet"
                    onClick={() => bot.threadId !== null && openThread(bot.threadId)}
                    disabled={bot.threadId === null}
                  >
                    Ver hilo
                  </button>
                  <button
                    type="button"
                    className="ade-icon-button"
                    onClick={() => setEditing(bot)}
                    disabled={canWrite !== true}
                    aria-label={`Editar ${bot.name}`}
                  >
                    <PencilIcon size={16} aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="ade-icon-button"
                    onClick={() => void toggleArchive(bot)}
                    disabled={canWrite !== true}
                    aria-label={bot.archived ? `Restaurar ${bot.name}` : `Archivar ${bot.name}`}
                  >
                    <ArchiveIcon size={16} aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="ade-icon-button"
                    onClick={() => void removeBot(bot)}
                    disabled={canWrite !== true}
                    aria-label={`Eliminar ${bot.name}`}
                  >
                    <TrashIcon size={16} aria-hidden />
                  </button>
                </div>
              </article>
            );
          })}
        </section>

        <section className="ade-bots-chat" aria-label="Panel del bot seleccionado">
          {selectedBot === null ? (
            <p className="ade-bot-meta">Elige un bot para escribirle.</p>
          ) : (
            <>
              <div className="ade-bot-chat-header">
                <BotAvatar status={stateOf(selectedBot).status} size="sm" />
                <h2>{selectedBot.name}</h2>
                <span className="ade-bot-status" data-status={stateOf(selectedBot).status}>
                  {stateOf(selectedBot).label}
                </span>
              </div>
              {selectedBot.coordinator ? (
                <Tabs value={panel} onValueChange={(value) => setPanel(value as typeof panel)}>
                  <TabsList aria-label="Panel del coordinador">
                    <TabsTab value="chat">Chat</TabsTab>
                    <TabsTab value="memory">Memoria</TabsTab>
                  </TabsList>
                  <TabsPanel value="chat">{chatPanel(selectedBot)}</TabsPanel>
                  <TabsPanel value="memory">
                    <ProjectMemory
                      key={`${selectedBot.id}:${selectedBot.projectId}`}
                      environmentId={environmentId}
                      bot={selectedBot}
                    />
                  </TabsPanel>
                </Tabs>
              ) : (
                chatPanel(selectedBot)
              )}
            </>
          )}
        </section>
      </div>

      {confirm.dialog}
      {editing === null ? null : (
        <BotEditor environmentId={environmentId} bot={editing} onClose={() => setEditing(null)} />
      )}
    </>
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

function MentionHint(props: { handles: ReadonlyArray<string>; onPick: (handle: string) => void }) {
  if (props.handles.length === 0) return null;
  return (
    <div id="ade-bot-mention-hint" className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-muted-foreground">Empieza con @ para pasárselo a:</span>
      {props.handles.map((handle) => (
        <button
          key={handle}
          type="button"
          className="ade-filter-chip max-[720px]:min-h-11"
          onClick={() => props.onPick(handle)}
        >
          @{handle}
        </button>
      ))}
    </div>
  );
}

function BotHandoffs(props: { entries: ReturnType<typeof recentHandoffs> }) {
  if (props.entries.length === 0) return null;
  return (
    <ul
      className="m-0 grid min-w-0 list-none gap-1 px-2.5 pb-1 text-xs"
      aria-label="Traspasos recientes"
    >
      {props.entries.map(({ handoff, direction, peer }) => (
        <li key={handoff.id} className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
          {direction === "in" ? (
            <ArrowBendDownRightIcon size={14} aria-hidden className="shrink-0" />
          ) : (
            <ArrowBendUpRightIcon size={14} aria-hidden className="shrink-0" />
          )}
          <span className="shrink-0">{direction === "in" ? `De ${peer}` : `A ${peer}`}</span>
          <span className="min-w-0 truncate">· {handoff.preview}</span>
          {handoff.status === "delivered" ? null : (
            <span
              className="ade-chip ml-auto shrink-0"
              data-kind={handoff.status === "cut" ? "approval" : undefined}
            >
              {HANDOFF_STATUS_LABELS[handoff.status]}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function BotEditor(props: {
  environmentId: EnvironmentId;
  bot: ForkBot | null;
  /** A new bot's starting values, as a sentence's draft proposes them. */
  initial?: BotDraft;
  onSaved?: () => void;
  onClose: () => void;
}) {
  const { environmentId, bot, onClose } = props;
  const registry = useContext(RegistryContext);
  const dialog = useRef<HTMLDialogElement>(null);
  const allProjects = useAtomValue(allEnvironmentProjectsAtom);
  const projects = [...(allProjects.get(environmentId)?.values() ?? [])];
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const models = useMemo(() => availableMachineModelOptions(serverConfig), [serverConfig]);
  const [draft, setDraft] = useState<BotDraft>(
    () =>
      props.initial ?? {
        handle: bot?.handle ?? "",
        name: bot?.name ?? "",
        role: bot?.role ?? "",
        instructions: bot?.instructions ?? "",
        projectId: bot?.projectId ?? "",
        runtimeMode: bot?.runtimeMode ?? "approval-required",
        instanceId: bot?.modelSelection.instanceId ?? "",
        model: bot?.modelSelection.model ?? "",
        coordinator: bot?.coordinator ?? false,
      },
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The native modal dialog traps focus, handles Escape, and returns focus to the opener.
  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  // Until the user picks one, the first listed project and model stand in, as the selects show.
  const projectId = draft.projectId === "" ? (projects[0]?.id ?? "") : draft.projectId;
  const firstModel = models[0];
  const modelKey =
    draft.model === ""
      ? firstModel === undefined
        ? ""
        : `${firstModel.instanceId}${MODEL_SEPARATOR}${firstModel.model}`
      : `${draft.instanceId}${MODEL_SEPARATOR}${draft.model}`;
  const set = (patch: Partial<BotDraft>) => setDraft((current) => ({ ...current, ...patch }));
  // From a sentence the mode stays low; an existing bot's editor keeps every mode, as before.
  const modes =
    bot === null && props.initial !== undefined ? SENTENCE_RUNTIME_MODES : RUNTIME_MODES;

  const save = async () => {
    const [instanceId = "", model = ""] = modelKey.split(MODEL_SEPARATOR);
    const validated = validateBotDraft({ ...draft, projectId, instanceId, model }, modes);
    if (!validated.ok) return setError(validated.error);
    setBusy(true);
    setError(null);
    const failure = await runCommand(
      registry,
      forkBotsUpsertCommand,
      {
        environmentId,
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
        },
      },
      "No se pudo guardar el bot",
    );
    setBusy(false);
    if (failure !== null) return setError(failure);
    refreshBots(registry, environmentId);
    props.onSaved?.();
    dialog.current?.close();
  };

  return (
    <dialog ref={dialog} className="ade-bots-editor" onClose={onClose}>
      <form
        className="ade-coord-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <header className="ade-coord-form-header">
          <h2>{bot === null ? "Nuevo bot" : `Editar ${bot.name}`}</h2>
          <button
            type="button"
            className="ade-button-quiet"
            onClick={() => dialog.current?.close()}
          >
            Cancelar
          </button>
        </header>
        <div className="ade-coord-form-grid">
          <label>
            Nombre
            <input value={draft.name} onChange={(event) => set({ name: event.target.value })} />
          </label>
          <label>
            Handle
            <input
              value={draft.handle}
              onChange={(event) => set({ handle: event.target.value })}
              placeholder="ej. general-manager"
              autoCapitalize="none"
              spellCheck={false}
            />
          </label>
          <label>
            Rol
            <input value={draft.role} onChange={(event) => set({ role: event.target.value })} />
          </label>
          <label>
            Proyecto
            <select value={projectId} onChange={(event) => set({ projectId: event.target.value })}>
              {projects.length === 0 ? <option value="">Sin proyectos</option> : null}
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
          <label>
            Modelo
            <select
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
          <label>
            Permisos
            <select
              value={draft.runtimeMode}
              onChange={(event) =>
                set({ runtimeMode: event.target.value as BotDraft["runtimeMode"] })
              }
            >
              {modes.map((mode) => (
                <option key={mode} value={mode}>
                  {mode}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="ade-failover-toggle">
          <input
            type="checkbox"
            checked={draft.coordinator}
            onChange={(event) => set({ coordinator: event.target.checked })}
          />
          <span>
            Coordinador del proyecto
            <small>
              Lee y actualiza la memoria del proyecto y reparte el trabajo en hilos hijos. Solo uno
              por proyecto.
            </small>
          </span>
        </label>
        <label>
          Instrucciones
          <textarea
            value={draft.instructions}
            onChange={(event) => set({ instructions: event.target.value })}
            rows={6}
          />
        </label>
        {bot?.threadId == null ? null : (
          <p className="ade-bot-meta">
            Si cambias nombre, rol, instrucciones, proyecto, modelo, permisos o coordinador, el
            siguiente mensaje abre un hilo nuevo. El anterior se conserva.
          </p>
        )}
        {error === null ? null : (
          <p className="ade-error" role="alert">
            {error}
          </p>
        )}
        <div className="ade-coord-form-actions">
          <button type="submit" className="ade-button" disabled={busy}>
            Guardar
          </button>
        </div>
      </form>
    </dialog>
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

/** One sentence in, a proposed bot out; «Crear» saves it as proposed, «Ajustar» opens the form. */
function QuickCreate(props: {
  fallbackEnv: EnvironmentId;
  machines: ReadonlyArray<EnvironmentId>;
  pairedCount: number;
  machineLabel: (id: EnvironmentId) => string;
  onCreated: (environmentId: EnvironmentId) => void;
}) {
  const registry = useContext(RegistryContext);
  const allProjects = useAtomValue(allEnvironmentProjectsAtom);
  const [text, setText] = useState("");
  const [proposal, setProposal] = useState<{
    readonly environmentId: EnvironmentId;
    readonly draft: ForkBotDraft;
  } | null>(null);
  const [adjusting, setAdjusting] = useState<{
    readonly environmentId: EnvironmentId;
    readonly initial: BotDraft;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const target = proposal?.environmentId ?? props.fallbackEnv;
  const canCreate = useAtomValue(forkBotsUpsertCommand.permissionAtom(target));
  const config = useAtomValue(serverEnvironment.configValueAtom(target));

  const machines: ReadonlyArray<BotMachine> = props.machines.map((environmentId) => ({
    environmentId,
    projects: [...(allProjects.get(environmentId)?.values() ?? [])],
  }));
  const [asking, setAsking] = useState(false);
  const [pickKey, setPickKey] = useState("");
  // Where the last sentence went, so «Rellenar a mano» opens there after a failure.
  const [sent, setSent] = useState<BotProjectChoice | null>(null);

  const reset = () => {
    setAsking(false);
    setSent(null);
    setProposal(null);
    setText("");
    setError(null);
  };

  /** `pick` is the selector's answer for this send only; a new «Proponer» asks again. */
  const propose = async (pick: BotProjectChoice | null) => {
    const sentence = text.trim();
    if (sentence === "" || busy) return;
    const destination = botDestination(sentence, machines, pick, props.pairedCount);
    if (destination.kind === "ask") {
      setPickKey("");
      setError(null);
      return setAsking(true);
    }
    if (destination.kind === "wait") {
      return setError(
        machines.every((machine) => machine.projects.length === 0)
          ? "Aún no hay proyectos cargados en ninguna máquina."
          : "Los proyectos de esa máquina aún se están cargando. Prueba en un momento.",
      );
    }
    const where = destination.target;
    setSent(where);
    setAsking(false);
    setBusy(true);
    setError(null);
    setProposal(null);
    const failure = await runCommand(
      registry,
      forkBotsDraftCommand,
      {
        environmentId: where.environmentId,
        input: { text: sentence, projectId: where.projectId },
      },
      "No se pudo proponer el bot",
      (draft) => setProposal({ environmentId: where.environmentId, draft }),
    );
    setBusy(false);
    if (failure !== null) setError(failure);
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

  const create = async () => {
    if (proposal === null) return;
    const { environmentId, draft } = proposal;
    setBusy(true);
    setError(null);
    const failure = await runCommand(
      registry,
      forkBotsUpsertCommand,
      {
        environmentId,
        input: {
          handle: draft.handle,
          name: draft.name,
          role: draft.role,
          instructions: draft.instructions,
          projectId: draft.projectId,
          runtimeMode: draft.runtimeMode,
          modelSelection: draft.modelSelection,
        },
      },
      "No se pudo crear el bot",
    );
    setBusy(false);
    if (failure !== null) return setError(failure);
    refreshBots(registry, environmentId);
    props.onCreated(environmentId);
    reset();
  };

  const draft = proposal?.draft;
  const projectTitle =
    proposal === null
      ? null
      : (allProjects.get(proposal.environmentId)?.get(proposal.draft.projectId)?.title ??
        "Proyecto sin nombre");
  const model =
    draft === undefined
      ? undefined
      : availableMachineModelOptions(config).find(
          (option) =>
            option.instanceId === draft.modelSelection.instanceId &&
            option.model === draft.modelSelection.model,
        );

  return (
    <section className="ade-bot-quick" aria-label="Crear un bot con una frase">
      <form
        className="ade-bot-quick-row"
        onSubmit={(event) => {
          event.preventDefault();
          void propose(null);
        }}
      >
        <label className="ade-sr-only" htmlFor="ade-bot-quick-text">
          Describe el bot que quieres
        </label>
        <textarea
          id="ade-bot-quick-text"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setAsking(false);
            // A new sentence has not been sent anywhere yet: «Rellenar a mano» must not reuse it.
            setSent(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void propose(null);
            }
          }}
          placeholder="Un bot que revise mis PR de Hubra cada mañana"
          rows={2}
          maxLength={FORK_BOTS_DRAFT_TEXT_MAX_LENGTH}
        />
        <button type="submit" className="ade-button" disabled={busy || text.trim() === ""}>
          <UserCircleIcon size={16} aria-hidden />{" "}
          {busy && proposal === null ? "Pensando…" : "Proponer"}
        </button>
      </form>

      {asking ? (
        <div className="ade-bot-quick-error" role="group" aria-label="¿En qué máquina y proyecto?">
          <label className="ade-bot-meta" htmlFor="ade-bot-quick-where">
            ¿En qué máquina y proyecto?
          </label>
          <select
            id="ade-bot-quick-where"
            className="ade-bot-quick-where"
            value={pickKey}
            onChange={(event) => setPickKey(event.target.value)}
          >
            <option value="">Elige…</option>
            {machines.map((machine) => {
              const suggested = suggestBotProject(text, machine.projects);
              return (
                <optgroup
                  key={machine.environmentId}
                  label={props.machineLabel(machine.environmentId)}
                >
                  {machine.projects.length === 0 ? (
                    <option disabled>Cargando proyectos…</option>
                  ) : (
                    machine.projects
                      .toSorted(
                        (left, right) =>
                          Number(right.id === suggested) - Number(left.id === suggested),
                      )
                      .map((project) => (
                        <option
                          key={project.id}
                          value={`${machine.environmentId}${MODEL_SEPARATOR}${project.id}`}
                        >
                          {project.title}
                        </option>
                      ))
                  )}
                </optgroup>
              );
            })}
          </select>
          <button
            type="button"
            className="ade-button"
            disabled={pickKey === "" || busy}
            onClick={() => {
              const [environmentId = "", projectId = ""] = pickKey.split(MODEL_SEPARATOR);
              void propose({
                environmentId: environmentId as EnvironmentId,
                projectId: projectId as ProjectId,
              });
            }}
          >
            Proponer aquí
          </button>
        </div>
      ) : null}

      {error === null ? null : (
        <div className="ade-bot-quick-error" role="alert">
          <p className="ade-error">{error}</p>
          {sent === null || text.trim() === "" ? null : (
            <button
              type="button"
              className="ade-button-quiet"
              onClick={() =>
                setAdjusting({
                  environmentId: sent.environmentId,
                  initial: {
                    handle: "",
                    name: "",
                    role: "",
                    instructions: text.trim(),
                    projectId: sent.projectId,
                    runtimeMode: "approval-required",
                    instanceId: "",
                    model: "",
                    coordinator: false,
                  },
                })
              }
            >
              Rellenar a mano
            </button>
          )}
        </div>
      )}

      {proposal === null || draft === undefined ? null : (
        <article className="ade-bot-card ade-bot-proposal" aria-label={`Propuesta: ${draft.name}`}>
          <div className="ade-bot-proposal-head">
            <BotAvatar status="asleep" />
            <span className="ade-bot-card-text">
              <strong>{draft.name}</strong>
              <span className="ade-bot-meta">
                <span className="ade-nowrap">@{draft.handle}</span> · {draft.role}
              </span>
            </span>
          </div>
          <dl className="ade-proposal-facts">
            <dt>Proyecto</dt>
            <dd>
              {projectTitle}
              {props.machines.length > 1 ? ` · ${props.machineLabel(proposal.environmentId)}` : ""}
            </dd>
            <dt>Modelo</dt>
            <dd>
              {model === undefined
                ? draft.modelSelection.model
                : `${model.providerLabel} · ${model.modelName}`}
            </dd>
            <dt>Permisos</dt>
            <dd>{RUNTIME_MODE_TEXT[draft.runtimeMode]}</dd>
            {draft.routine === "" ? null : (
              <>
                <dt>Rutina</dt>
                <dd>{draft.routine} (la añades desde el bot cuando exista)</dd>
              </>
            )}
          </dl>
          <details className="ade-proposal-instructions">
            <summary>Instrucciones</summary>
            <pre>{draft.instructions}</pre>
          </details>
          <p className="ade-bot-meta" role="status">
            {draft.fallbackReason === null
              ? `Redactado por ${draft.draftedBy?.model ?? "el modelo"}.`
              : FALLBACK_TEXT[draft.fallbackReason]}
          </p>
          <div className="ade-coord-form-actions">
            <button type="button" className="ade-button-quiet" onClick={reset} disabled={busy}>
              Descartar
            </button>
            <button
              type="button"
              className="ade-button-quiet"
              onClick={() =>
                setAdjusting({ environmentId: proposal.environmentId, initial: formFrom(draft) })
              }
              disabled={busy || canCreate !== true}
            >
              Ajustar
            </button>
            <button
              type="button"
              className="ade-button"
              onClick={() => void create()}
              disabled={busy || canCreate !== true}
            >
              {busy ? "Creando…" : "Crear"}
            </button>
          </div>
        </article>
      )}

      {adjusting === null ? null : (
        <BotEditor
          environmentId={adjusting.environmentId}
          bot={null}
          initial={adjusting.initial}
          onSaved={() => {
            props.onCreated(adjusting.environmentId);
            reset();
          }}
          onClose={() => setAdjusting(null)}
        />
      )}
    </section>
  );
}
