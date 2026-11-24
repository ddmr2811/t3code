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
import {
  FORK_BOTS_MESSAGE_MAX_LENGTH,
  type EnvironmentId,
  type ForkBot,
  type ForkBotHandoff,
  type ForkBotHandoffStatus,
  type ThreadId,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { useContext, useEffect, useMemo, useRef, useState } from "react";

import { runCommand } from "../composer/Composer.tsx";
import { allEnvironmentProjectsAtom } from "../coordination/coordination.state.ts";
import { environmentCatalog } from "../connection/runtime.ts";
import { availableMachineModelOptions } from "../failover/failover.logic.ts";
import { listedThreadsAtom, selectedThreadKeyAtom } from "../sidebar/Sidebar.tsx";
import { serverEnvironment } from "../state.ts";
import {
  botThreadState,
  type BotDraft,
  parseMention,
  recentHandoffs,
  validateBotDraft,
} from "./bots.logic.ts";
import { useConfirm } from "../ui/primitives/confirm.tsx";
import { Tabs, TabsList, TabsPanel, TabsTab } from "../ui/primitives/tabs.tsx";
import { ProjectMemory } from "./ProjectMemory.tsx";
import {
  allBotsAtom,
  forkBotsHandoffCommand,
  forkBotsRemoveCommand,
  forkBotsSendMessageCommand,
  forkBotsSetArchivedCommand,
  forkBotsUpsertCommand,
  refreshBots,
} from "./bots.state.ts";

const RUNTIME_MODES = ["approval-required", "auto-accept-edits", "auto", "full-access"] as const;
const MODEL_SEPARATOR = "\u0000";

export const HANDOFF_STATUS_LABELS: Record<ForkBotHandoffStatus, string> = {
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
  const [editing, setEditing] = useState<ForkBot | "new" | null>(null);
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
        (result) =>
          setChatNote(
            result.handoff.status === "cut"
              ? `Traspaso cortado: la cadena entre bots pasó de ${result.handoff.hops - 1} saltos. Míralo en la bandeja.`
              : `Pasado a @${mention.handle}${result.duplicate ? " (ya se había enviado)" : ""}.`,
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
      <div className="ade-projects-toolbar">
        <span />
        <button
          type="button"
          className="ade-button"
          onClick={() => setEditing("new")}
          disabled={canWrite !== true}
        >
          <UserCircleIcon size={16} aria-hidden /> Nuevo bot
        </button>
      </div>

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
          {bots.map((bot) => (
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
                <span className="ade-bot-monogram" aria-hidden>
                  {bot.name.slice(0, 2).toUpperCase()}
                </span>
                <span className="ade-bot-card-text">
                  <strong>{bot.name}</strong>
                  <span className="ade-bot-meta">
                    @{bot.handle} · {bot.role}
                    {bot.coordinator ? " · Coordinador" : ""}
                  </span>
                  <span className="ade-bot-meta">
                    {bot.modelSelection.instanceId} · {bot.modelSelection.model}
                  </span>
                </span>
                <span className="ade-bot-status">
                  {bot.archived ? "Archivado" : botThreadState(bot, allThreads)}
                </span>
              </button>
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
          ))}
        </section>

        <section className="ade-bots-chat" aria-label="Panel del bot seleccionado">
          {selectedBot === null ? (
            <p className="ade-bot-meta">Elige un bot para escribirle.</p>
          ) : (
            <>
              <h2>{selectedBot.name}</h2>
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
        <BotEditor
          environmentId={environmentId}
          bot={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </>
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
  onClose: () => void;
}) {
  const { environmentId, bot, onClose } = props;
  const registry = useContext(RegistryContext);
  const dialog = useRef<HTMLDialogElement>(null);
  const allProjects = useAtomValue(allEnvironmentProjectsAtom);
  const projects = [...(allProjects.get(environmentId)?.values() ?? [])];
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const models = useMemo(() => availableMachineModelOptions(serverConfig), [serverConfig]);
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

  const save = async () => {
    const [instanceId = "", model = ""] = modelKey.split(MODEL_SEPARATOR);
    const validated = validateBotDraft({ ...draft, projectId, instanceId, model });
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
              {RUNTIME_MODES.map((mode) => (
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
