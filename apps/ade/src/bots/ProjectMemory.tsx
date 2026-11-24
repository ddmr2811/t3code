import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { PencilIcon } from "@phosphor-icons/react/dist/csr/Pencil";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import {
  FORK_MEMORY_ESSENTIAL_MAX_BYTES,
  FORK_MEMORY_NOTE_MAX_LENGTH,
  type EnvironmentId,
  type ForkBot,
  type ForkMemoryInclusion,
  type ForkMemoryNote,
  type ScheduledTask,
  forkMemoryEssentialBytes,
} from "@t3tools/contracts";
import { useContext, useState } from "react";

import { runCommand } from "../composer/Composer.tsx";
import { serverEnvironment } from "../state.ts";
import {
  type CoordinatorRoutine,
  NIGHTLY_CONSOLIDATION_PROMPT,
  coordinatorRoutineInput,
} from "./bots.logic.ts";
import {
  forkMemoryListQuery,
  forkMemoryRemoveCommand,
  forkMemoryUpsertCommand,
} from "./bots.state.ts";

const INCLUSION_LABEL: Record<ForkMemoryInclusion, string> = {
  essential: "Esencial",
  searchable: "Buscable",
};

/** Notes are one line; pasted line breaks become spaces, as the server requires. */
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

function kilobytes(bytes: number): string {
  return (bytes / 1024).toLocaleString("es", { maximumFractionDigits: 1 });
}

export function ProjectMemory(props: { environmentId: EnvironmentId; bot: ForkBot }) {
  const { environmentId, bot } = props;
  const registry = useContext(RegistryContext);
  const query = forkMemoryListQuery({ environmentId, input: { projectId: bot.projectId } });
  const result = useAtomValue(query);
  const canWrite = useAtomValue(forkMemoryUpsertCommand.permissionAtom(environmentId));
  const [draft, setDraft] = useState("");
  const [draftInclusion, setDraftInclusion] = useState<ForkMemoryInclusion>("searchable");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (
    note: Pick<ForkMemoryNote, "text" | "inclusion"> & { readonly id?: string },
  ) => {
    const text = oneLine(note.text);
    if (text === "") return setError("La nota no puede estar vacía.");
    setBusy(true);
    setError(null);
    const failure = await runCommand(
      registry,
      forkMemoryUpsertCommand,
      {
        environmentId,
        input: {
          ...(note.id === undefined ? {} : { id: note.id }),
          projectId: bot.projectId,
          text,
          inclusion: note.inclusion,
        },
      },
      "No se pudo guardar la nota",
    );
    setBusy(false);
    if (failure !== null) {
      setError(failure);
      return false;
    }
    registry.refresh(query);
    return true;
  };

  const remove = async (note: ForkMemoryNote) => {
    if (!window.confirm(`¿Borrar esta nota de la memoria del proyecto?\n\n${note.text}`)) return;
    setError(null);
    const failure = await runCommand(
      registry,
      forkMemoryRemoveCommand,
      { environmentId, input: { projectId: bot.projectId, id: note.id } },
      "No se pudo borrar la nota",
    );
    if (failure !== null) return setError(failure);
    registry.refresh(query);
  };

  if (result._tag !== "Success") {
    return (
      <p className={result._tag === "Failure" ? "ade-error" : "ade-bot-meta"}>
        {result._tag === "Failure"
          ? "No se pudo leer la memoria del proyecto."
          : "Cargando memoria…"}
      </p>
    );
  }
  const notes = result.value.notes;
  const essentialBytes = forkMemoryEssentialBytes(notes);
  const share = Math.min(1, essentialBytes / FORK_MEMORY_ESSENTIAL_MAX_BYTES);

  return (
    <div className="ade-memory">
      <p className="ade-bot-meta">
        Las esenciales llegan al coordinador cuando cambian; las buscables las consulta cuando le
        hacen falta.
      </p>
      <div className="ade-memory-usage">
        <span className="ade-memory-meter" data-level={share >= 0.9 ? "high" : undefined}>
          <span style={{ width: `${Math.round(share * 100)}%` }} />
        </span>
        <span>
          Esenciales: {kilobytes(essentialBytes)} de {kilobytes(FORK_MEMORY_ESSENTIAL_MAX_BYTES)} KB
        </span>
      </div>

      <form
        className="ade-memory-new"
        onSubmit={async (event) => {
          event.preventDefault();
          const submitted = draft;
          // Typing may go on while the save is in flight; only what was saved is cleared.
          if (await save({ text: submitted, inclusion: draftInclusion })) {
            setDraft((current) => (current === submitted ? "" : current));
          }
        }}
      >
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Nueva nota: una decisión, una convención, un dato que costó averiguar"
          aria-label="Nueva nota"
          rows={2}
          maxLength={FORK_MEMORY_NOTE_MAX_LENGTH}
          disabled={canWrite !== true}
        />
        <div className="ade-memory-new-actions">
          <select
            value={draftInclusion}
            onChange={(event) => setDraftInclusion(event.target.value as ForkMemoryInclusion)}
            aria-label="Tipo de nota"
            disabled={canWrite !== true}
          >
            <option value="searchable">Buscable</option>
            <option value="essential">Esencial</option>
          </select>
          <button
            type="submit"
            className="ade-button"
            disabled={busy || canWrite !== true || oneLine(draft) === ""}
          >
            Guardar nota
          </button>
        </div>
      </form>

      {error === null ? null : (
        <p className="ade-error" role="alert">
          {error}
        </p>
      )}

      {notes.length === 0 ? (
        <p className="ade-bot-meta">Aún no hay notas en este proyecto.</p>
      ) : (
        <ul className="ade-memory-list" aria-label="Notas del proyecto">
          {notes.map((note) => (
            <li key={note.id} className="ade-memory-note" data-inclusion={note.inclusion}>
              {editing?.id === note.id ? (
                <form
                  className="ade-memory-new"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    if (await save({ ...note, text: editing.text })) setEditing(null);
                  }}
                >
                  <textarea
                    value={editing.text}
                    onChange={(event) => setEditing({ id: note.id, text: event.target.value })}
                    aria-label="Texto de la nota"
                    rows={3}
                    maxLength={FORK_MEMORY_NOTE_MAX_LENGTH}
                  />
                  <div className="ade-memory-new-actions">
                    <button
                      type="button"
                      className="ade-button-quiet"
                      onClick={() => setEditing(null)}
                    >
                      Cancelar
                    </button>
                    <button type="submit" className="ade-button" disabled={busy}>
                      Guardar
                    </button>
                  </div>
                </form>
              ) : (
                <p className="ade-memory-text">{note.text}</p>
              )}
              <div className="ade-memory-note-meta">
                <span className="ade-chip">{note.origin === "agent" ? "Agente" : "Usuario"}</span>
                <button
                  type="button"
                  className="ade-button-quiet ade-alert-toggle"
                  aria-pressed={note.inclusion === "essential"}
                  onClick={() =>
                    void save({
                      ...note,
                      inclusion: note.inclusion === "essential" ? "searchable" : "essential",
                    })
                  }
                  disabled={busy || canWrite !== true}
                >
                  {INCLUSION_LABEL[note.inclusion]}
                </button>
                <span className="ade-memory-note-actions">
                  <button
                    type="button"
                    className="ade-icon-button"
                    onClick={() => setEditing({ id: note.id, text: note.text })}
                    disabled={canWrite !== true}
                    aria-label="Editar nota"
                  >
                    <PencilIcon size={16} aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="ade-icon-button"
                    onClick={() => void remove(note)}
                    disabled={canWrite !== true}
                    aria-label="Borrar nota"
                  >
                    <TrashIcon size={16} aria-hidden />
                  </button>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      <CoordinatorRoutines environmentId={environmentId} bot={bot} />
    </div>
  );
}

function scheduleLabel(task: ScheduledTask): string {
  switch (task.schedule.type) {
    case "fixed_time":
      return `Cada día a las ${task.schedule.timeOfDay}`;
    case "webhook":
      return `Webhook${task.webhook === undefined ? "" : ` · ${task.webhook.url ?? task.webhook.path}`}`;
    default:
      return "Programada";
  }
}

function CoordinatorRoutines(props: { environmentId: EnvironmentId; bot: ForkBot }) {
  const { environmentId, bot } = props;
  const registry = useContext(RegistryContext);
  const tasksResult = useAtomValue(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const canSchedule = useAtomValue(
    serverEnvironment.upsertScheduledTask.permissionAtom(environmentId),
  );
  const [form, setForm] = useState<Extract<
    CoordinatorRoutine,
    { kind: "daily" | "webhook" }
  > | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const threadId = bot.threadId;
  const tasks =
    tasksResult._tag === "Success" && threadId !== null
      ? tasksResult.value.tasks.filter((task) => task.threadId === threadId)
      : [];
  const hasNightly = tasks.some((task) => task.prompt === NIGHTLY_CONSOLIDATION_PROMPT);
  const disabled = busy || canSchedule !== true || threadId === null;

  const create = async (routine: CoordinatorRoutine) => {
    if (threadId === null) return;
    if (
      routine.kind !== "nightly" &&
      (routine.title.trim() === "" || routine.prompt.trim() === "")
    ) {
      return setError("La rutina necesita título y encargo.");
    }
    setBusy(true);
    setError(null);
    const failure = await runCommand(
      registry,
      serverEnvironment.upsertScheduledTask,
      { environmentId, input: coordinatorRoutineInput(bot, threadId, routine) },
      "No se pudo programar la rutina",
    );
    setBusy(false);
    if (failure !== null) return setError(failure);
    setForm(null);
  };

  const remove = async (task: ScheduledTask) => {
    if (!window.confirm(`¿Quitar la rutina «${task.title}»?`)) return;
    setError(null);
    const failure = await runCommand(
      registry,
      serverEnvironment.deleteScheduledTask,
      { environmentId, input: { id: task.id } },
      "No se pudo quitar la rutina",
    );
    if (failure !== null) setError(failure);
  };

  return (
    <section className="ade-memory-routines" aria-label="Rutinas del coordinador">
      <h3>Rutinas</h3>
      <p className="ade-bot-meta">
        {threadId === null
          ? "Escríbele primero al coordinador: las rutinas continúan su hilo."
          : "Las rutinas continúan su hilo. La consolidación nocturna, a las 03:00, fusiona duplicados y propone qué bajar de esenciales."}
      </p>
      {tasks.length === 0 ? null : (
        <ul className="ade-memory-list">
          {tasks.map((task) => (
            <li key={task.id} className="ade-memory-note">
              <p className="ade-memory-text">{task.title}</p>
              <div className="ade-memory-note-meta">
                <span className="ade-bot-meta">{scheduleLabel(task)}</span>
                <span className="ade-memory-note-actions">
                  <button
                    type="button"
                    className="ade-icon-button"
                    onClick={() => void remove(task)}
                    disabled={canSchedule !== true}
                    aria-label={`Quitar ${task.title}`}
                  >
                    <TrashIcon size={16} aria-hidden />
                  </button>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {form === null ? (
        <div className="ade-memory-new-actions">
          <button
            type="button"
            className="ade-button-quiet"
            onClick={() => setForm({ kind: "daily", title: "", prompt: "", timeOfDay: "09:00" })}
            disabled={disabled}
          >
            Añadir rutina
          </button>
          <button
            type="button"
            className="ade-button-quiet"
            onClick={() => void create({ kind: "nightly" })}
            disabled={disabled || hasNightly}
          >
            {hasNightly ? "Consolidación nocturna activa" : "Consolidación nocturna"}
          </button>
        </div>
      ) : (
        <form
          className="ade-memory-new"
          onSubmit={(event) => {
            event.preventDefault();
            void create(form);
          }}
        >
          <input
            value={form.title}
            onChange={(event) => setForm({ ...form, title: event.target.value })}
            placeholder="Título"
            aria-label="Título de la rutina"
          />
          <textarea
            value={form.prompt}
            onChange={(event) => setForm({ ...form, prompt: event.target.value })}
            placeholder="Qué tiene que hacer el coordinador"
            aria-label="Encargo de la rutina"
            rows={3}
          />
          <div className="ade-memory-new-actions">
            <select
              value={form.kind}
              onChange={(event) =>
                setForm(
                  event.target.value === "webhook"
                    ? { kind: "webhook", title: form.title, prompt: form.prompt }
                    : { kind: "daily", title: form.title, prompt: form.prompt, timeOfDay: "09:00" },
                )
              }
              aria-label="Cuándo"
            >
              <option value="daily">Cada día a una hora</option>
              <option value="webhook">Al recibir un webhook</option>
            </select>
            {form.kind === "daily" ? (
              <input
                type="time"
                value={form.timeOfDay}
                onChange={(event) => setForm({ ...form, timeOfDay: event.target.value })}
                aria-label="Hora"
                required
              />
            ) : null}
            <button type="button" className="ade-button-quiet" onClick={() => setForm(null)}>
              Cancelar
            </button>
            <button type="submit" className="ade-button" disabled={disabled}>
              Programar
            </button>
          </div>
        </form>
      )}
      {error === null ? null : (
        <p className="ade-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
