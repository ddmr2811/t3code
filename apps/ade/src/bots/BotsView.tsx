import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { UserCircleIcon } from "@phosphor-icons/react/dist/csr/UserCircle";
import { PaperPlaneTiltIcon } from "@phosphor-icons/react/dist/csr/PaperPlaneTilt";
import { PencilIcon } from "@phosphor-icons/react/dist/csr/Pencil";
import { ArchiveIcon } from "@phosphor-icons/react/dist/csr/Archive";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { FORK_BOTS_MESSAGE_MAX_LENGTH, type EnvironmentId, type ForkBot } from "@t3tools/contracts";
import { useContext, useMemo, useState } from "react";

import {
  allBotsAtom,
  forkBotsRemoveCommand,
  forkBotsSendMessageCommand,
  forkBotsSetArchivedCommand,
  forkBotsUpsertCommand,
  refreshBots,
} from "./bots.state.ts";
import { validateBotDraft, botThreadState } from "./bots.logic.ts";
import { allEnvironmentProjectsAtom } from "../coordination/coordination.state.ts";
import { availableMachineModelOptions } from "../failover/failover.logic.ts";
import { environmentCatalog } from "../connection/runtime.ts";
import { serverEnvironment } from "../state.ts";
import { listedThreadsAtom, selectedThreadKeyAtom } from "../sidebar/Sidebar.tsx";

const RUNTIME_MODES = ["approval-required", "auto-accept-edits", "auto", "full-access"] as const;

type BotDraftState = {
  handle: string;
  name: string;
  role: string;
  instructions: string;
  projectId: string;
  runtimeMode: (typeof RUNTIME_MODES)[number];
  instanceId: string;
  model: string;
  fallbackChainId: string | null;
  notifyOnNeedsYou: boolean;
};

const emptyDraft = (projectId = ""): BotDraftState => ({
  handle: "",
  name: "",
  role: "",
  instructions: "",
  projectId,
  runtimeMode: "approval-required",
  instanceId: "",
  model: "",
  fallbackChainId: null,
  notifyOnNeedsYou: true,
});

export function BotsView() {
  const registry = useContext(RegistryContext);
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const operableEnvs = [...catalog.entries.keys()];
  const { byEnv, errors } = useAtomValue(allBotsAtom);
  const allThreads = useAtomValue(listedThreadsAtom);
  const allProjects = useAtomValue(allEnvironmentProjectsAtom);
  const setSelectedKey = useAtomSet(selectedThreadKeyAtom);
  const [selectedEnv, setSelectedEnv] = useState<EnvironmentId>(
    operableEnvs[0] ?? [...catalog.entries.keys()][0]!,
  );
  const [editing, setEditing] = useState<ForkBot | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<BotDraftState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messageText, setMessageText] = useState("");
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);

  const bots = byEnv.get(selectedEnv) ?? [];
  const projects = [...(allProjects.get(selectedEnv)?.values() ?? [])];
  const configForEnv = useAtomValue(serverEnvironment.configValueAtom(selectedEnv));
  const machineModels = useMemo(() => availableMachineModelOptions(configForEnv), [configForEnv]);

  const selectedBot = bots.find((bot) => bot.id === selectedBotId) ?? null;
  const selectedBotThread =
    selectedBot === null
      ? null
      : (allThreads.find((thread) => thread.id === selectedBot.threadId) ?? null);

  const openEditor = (bot: ForkBot | null) => {
    setError(null);
    if (bot === null) {
      setCreating(true);
      setEditing(null);
      setDraft(emptyDraft(projects[0]?.id ?? ""));
      return;
    }
    setCreating(false);
    setEditing(bot);
    setDraft({
      handle: bot.handle,
      name: bot.name,
      role: bot.role,
      instructions: bot.instructions,
      projectId: bot.projectId,
      runtimeMode: bot.runtimeMode,
      instanceId: bot.modelSelection.instanceId,
      model: bot.modelSelection.model,
      fallbackChainId: bot.fallbackChainId,
      notifyOnNeedsYou: bot.notifyOnNeedsYou,
    });
  };

  const closeEditor = () => {
    setCreating(false);
    setEditing(null);
    setDraft(null);
    setError(null);
  };

  const saveDraft = async () => {
    if (draft === null) return;
    const validated = validateBotDraft({
      handle: draft.handle,
      name: draft.name,
      role: draft.role,
      instructions: draft.instructions,
      projectId: draft.projectId,
      runtimeMode: draft.runtimeMode,
      instanceId: draft.instanceId as never,
      model: draft.model,
      fallbackChainId: draft.fallbackChainId,
      notifyOnNeedsYou: draft.notifyOnNeedsYou,
    });
    if (!validated.ok) {
      setError(validated.error);
      return;
    }
    setBusy(true);
    setError(null);
    const failure = await runAtomCommand(
      registry,
      forkBotsUpsertCommand,
      {
        environmentId: selectedEnv,
        input: {
          ...(editing !== null ? { id: editing.id } : {}),
          handle: validated.value.handle,
          name: validated.value.name,
          role: validated.value.role,
          instructions: validated.value.instructions,
          projectId: validated.value.projectId,
          runtimeMode: validated.value.runtimeMode,
          modelSelection: {
            instanceId: validated.value.instanceId,
            model: validated.value.model,
          },
          fallbackChainId: validated.value.fallbackChainId,
          notifyOnNeedsYou: validated.value.notifyOnNeedsYou,
        },
      },
      { reportFailure: false },
    );
    setBusy(false);
    if (failure._tag === "Failure") {
      setError("No se pudo guardar el bot.");
      return;
    }
    refreshBots(registry, selectedEnv);
    closeEditor();
  };

  const toggleArchive = async (bot: ForkBot) => {
    setBusy(true);
    const failure = await runAtomCommand(
      registry,
      forkBotsSetArchivedCommand,
      { environmentId: selectedEnv, input: { id: bot.id, archived: !bot.archived } },
      { reportFailure: false },
    );
    setBusy(false);
    if (failure._tag !== "Failure") refreshBots(registry, selectedEnv);
  };

  const removeBot = async (bot: ForkBot) => {
    setBusy(true);
    const failure = await runAtomCommand(
      registry,
      forkBotsRemoveCommand,
      { environmentId: selectedEnv, input: { id: bot.id } },
      { reportFailure: false },
    );
    setBusy(false);
    if (failure._tag !== "Failure") refreshBots(registry, selectedEnv);
  };

  const sendMessage = async () => {
    if (selectedBot === null || messageText.trim() === "") return;
    setBusy(true);
    setError(null);
    const result = await runAtomCommand(
      registry,
      forkBotsSendMessageCommand,
      { environmentId: selectedEnv, input: { id: selectedBot.id, text: messageText.trim() } },
      { reportFailure: false },
    );
    setBusy(false);
    if (result._tag === "Failure") {
      setError("No se pudo enviar el mensaje al bot.");
      return;
    }
    const value = (result as { value?: { threadId?: string } }).value;
    if (value?.threadId !== undefined) {
      setSelectedKey(scopedThreadKey(scopeThreadRef(selectedEnv, value.threadId as never)));
    }
    setMessageText("");
    refreshBots(registry, selectedEnv);
  };

  return (
    <div className="ade-bots">
      <header className="ade-bots-header">
        <h1>Bots</h1>
        <button
          type="button"
          className="ade-button"
          onClick={() => openEditor(null)}
          disabled={busy}
        >
          <UserCircleIcon size={16} aria-hidden /> Nuevo bot
        </button>
      </header>

      {errors.length > 0 ? (
        <p className="ade-error" role="alert">
          {errors.map((item) => item.message).join(" · ")}
        </p>
      ) : null}

      <div className="ade-bots-layout">
        <section className="ade-bots-list" aria-label="Directorio de bots">
          {bots.length === 0 ? <p className="ade-session-more">Aún no hay bots.</p> : null}
          {bots.map((bot) => {
            return (
              <article
                key={bot.id}
                className="ade-bot-card"
                data-archived={bot.archived ? "" : undefined}
              >
                <div className="ade-bot-card-head">
                  <span className="ade-bot-monogram" aria-hidden>
                    {bot.name.slice(0, 2).toUpperCase()}
                  </span>
                  <div>
                    <h2>{bot.name}</h2>
                    <p className="ade-bot-handle">@{bot.handle}</p>
                  </div>
                  <span className="ade-bot-status">{botThreadState(bot, allThreads)}</span>
                </div>
                <p className="ade-bot-role">{bot.role}</p>
                <p className="ade-bot-model">
                  {bot.modelSelection.instanceId} · {bot.modelSelection.model}
                </p>
                <div className="ade-bot-actions">
                  <button
                    type="button"
                    className="ade-button-quiet"
                    onClick={() => setSelectedBotId(bot.id)}
                  >
                    Chat
                  </button>
                  <button
                    type="button"
                    className="ade-button-quiet"
                    onClick={() => {
                      if (bot.threadId !== null)
                        setSelectedKey(
                          scopedThreadKey(scopeThreadRef(selectedEnv, bot.threadId as never)),
                        );
                    }}
                    disabled={bot.threadId === null}
                  >
                    Ver hilo real
                  </button>
                  <button
                    type="button"
                    className="ade-icon-button"
                    onClick={() => openEditor(bot)}
                    aria-label="Editar bot"
                  >
                    <PencilIcon size={16} aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="ade-icon-button"
                    onClick={() => void toggleArchive(bot)}
                    aria-label={bot.archived ? "Restaurar bot" : "Archivar bot"}
                  >
                    <ArchiveIcon size={16} aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="ade-icon-button"
                    onClick={() => void removeBot(bot)}
                    aria-label="Eliminar bot"
                  >
                    <TrashIcon size={16} aria-hidden />
                  </button>
                </div>
              </article>
            );
          })}
        </section>

        <section className="ade-bots-chat" aria-label="Chat del bot seleccionado">
          {selectedBot === null ? (
            <p className="ade-session-more">Selecciona un bot para chatear.</p>
          ) : (
            <>
              <h2>{selectedBot.name}</h2>
              <p className="ade-bot-handle">
                @{selectedBot.handle} · {selectedBot.role}
              </p>
              {selectedBotThread === null ? (
                <p className="ade-session-more">
                  Aún no hay hilo real. Envía un mensaje para crearlo.
                </p>
              ) : (
                <p className="ade-session-more">Hilo real disponible en la capa trasera.</p>
              )}
              <textarea
                className="ade-bots-composer"
                value={messageText}
                onChange={(event) => setMessageText(event.target.value)}
                placeholder="Mensaje para el bot"
                rows={3}
                maxLength={FORK_BOTS_MESSAGE_MAX_LENGTH}
              />
              <button
                type="button"
                className="ade-button"
                onClick={() => void sendMessage()}
                disabled={busy}
              >
                <PaperPlaneTiltIcon size={16} aria-hidden /> Enviar
              </button>
              {error !== null ? (
                <p className="ade-error" role="alert">
                  {error}
                </p>
              ) : null}
            </>
          )}
        </section>
      </div>

      {(creating || editing !== null) && draft !== null ? (
        <div className="ade-bots-editor" role="dialog" aria-label="Editor de bot">
          <h2>{creating ? "Nuevo bot" : "Editar bot"}</h2>
          <label>
            Máquina
            <select
              value={selectedEnv}
              onChange={(event) => setSelectedEnv(event.target.value as EnvironmentId)}
            >
              {[...catalog.entries.keys()].map((environmentId) => (
                <option key={environmentId} value={environmentId}>
                  {catalog.entries.get(environmentId)?.target.label ?? environmentId}
                </option>
              ))}
            </select>
          </label>
          <label>
            Handle
            <input
              value={draft.handle}
              onChange={(event) => setDraft({ ...draft, handle: event.target.value })}
            />
          </label>
          <label>
            Nombre
            <input
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <label>
            Rol
            <input
              value={draft.role}
              onChange={(event) => setDraft({ ...draft, role: event.target.value })}
            />
          </label>
          <label>
            Proyecto
            <select
              value={draft.projectId}
              onChange={(event) => setDraft({ ...draft, projectId: event.target.value })}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            Permisos
            <select
              value={draft.runtimeMode}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  runtimeMode: event.target.value as BotDraftState["runtimeMode"],
                })
              }
            >
              {RUNTIME_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {mode}
                </option>
              ))}
            </select>
          </label>
          <label>
            Modelo
            <select
              value={`${draft.instanceId}\u0000${draft.model}`}
              onChange={(event) => {
                const [instanceId, model] = event.target.value.split("\u0000");
                setDraft({ ...draft, instanceId: instanceId ?? "", model: model ?? "" });
              }}
            >
              {machineModels.map(
                (option: {
                  instanceId: string;
                  model: string;
                  providerLabel: string;
                  modelName: string;
                }) => (
                  <option
                    key={`${option.instanceId}\u0000${option.model}`}
                    value={`${option.instanceId}\u0000${option.model}`}
                  >
                    {option.providerLabel} · {option.modelName}
                  </option>
                ),
              )}
            </select>
          </label>
          <label>
            Instrucciones
            <textarea
              value={draft.instructions}
              onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
              rows={6}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={draft.notifyOnNeedsYou}
              onChange={(event) => setDraft({ ...draft, notifyOnNeedsYou: event.target.checked })}
            />
            Avisar si me necesita
          </label>
          {error !== null ? (
            <p className="ade-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="ade-bots-editor-actions">
            <button
              type="button"
              className="ade-button"
              onClick={() => void saveDraft()}
              disabled={busy}
            >
              Guardar
            </button>
            <button
              type="button"
              className="ade-button-quiet"
              onClick={closeEditor}
              disabled={busy}
            >
              Cancelar
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
