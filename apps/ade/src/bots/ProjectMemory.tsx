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
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import * as Cause from "effect/Cause";
import { useContext, useState } from "react";

import { runCommand } from "../composer/Composer.tsx";
import { serverEnvironment } from "../state.ts";
import { useConfirm } from "../ui/primitives/confirm.tsx";
import { Meter } from "../ui/primitives/meter.tsx";
import { Switch } from "../ui/primitives/switch.tsx";
import { cn } from "../ui/utils.ts";
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

// Touch targets grow to 44 px on phones.
const TOUCH = "max-[720px]:min-h-11";
const FIELD =
  "box-border w-full min-w-0 max-[720px]:min-h-11 resize-y rounded-sm border border-border bg-background px-2.5 py-2 text-[13px] leading-snug text-foreground";
const CARD = "grid gap-1.5 rounded-md border border-border bg-background p-2.5";
const HINT = "m-0 text-xs text-muted-foreground";

/** Notes are one line; pasted line breaks become spaces, as the server requires. */
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

const kilobytes = (bytes: number) =>
  `${(bytes / 1024).toLocaleString("es", { maximumFractionDigits: 1 })} KB`;

export function ProjectMemory(props: { environmentId: EnvironmentId; bot: ForkBot }) {
  const { environmentId, bot } = props;
  const registry = useContext(RegistryContext);
  const query = forkMemoryListQuery({ environmentId, input: { projectId: bot.projectId } });
  const result = useAtomValue(query);
  const canWrite = useAtomValue(forkMemoryUpsertCommand.permissionAtom(environmentId)) === true;
  const confirm = useConfirm();
  const [draft, setDraft] = useState("");
  const [draftEssential, setDraftEssential] = useState(false);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (note: {
    readonly id?: string;
    readonly text: string;
    readonly inclusion: ForkMemoryInclusion;
  }) => {
    const text = oneLine(note.text);
    if (text === "") {
      setError("La nota no puede estar vacía.");
      return false;
    }
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

  const addNote = async () => {
    const submitted = draft;
    const saved = await save({
      text: submitted,
      inclusion: draftEssential ? "essential" : "searchable",
    });
    // Typing may go on while the save is in flight; only what was saved is cleared.
    if (saved) setDraft((current) => (current === submitted ? "" : current));
  };

  const removeNote = async (note: ForkMemoryNote) => {
    const agreed = await confirm.ask({
      title: "¿Borrar esta nota?",
      description: note.text,
      confirmLabel: "Borrar",
    });
    if (!agreed) return;
    setBusy(true);
    setError(null);
    const failure = await runCommand(
      registry,
      forkMemoryRemoveCommand,
      { environmentId, input: { projectId: bot.projectId, id: note.id } },
      "No se pudo borrar la nota",
    );
    setBusy(false);
    if (failure !== null) return setError(failure);
    registry.refresh(query);
  };

  if (result._tag !== "Success") {
    return result._tag === "Failure" ? (
      <p className="ade-error" role="alert">
        No se pudo leer la memoria del proyecto
        {`: ${errorDisplayMessage(Cause.squash(result.cause)) ?? "error desconocido"}`}
      </p>
    ) : (
      <p className={HINT}>Cargando memoria…</p>
    );
  }
  const notes = result.value.notes;
  const essentialBytes = forkMemoryEssentialBytes(notes);

  return (
    <div className="grid min-w-0 gap-2.5">
      <p className={HINT}>
        Las esenciales llegan al coordinador cuando cambian; las buscables las consulta cuando le
        hacen falta.
      </p>
      <Meter
        label="Esenciales"
        value={essentialBytes}
        max={FORK_MEMORY_ESSENTIAL_MAX_BYTES}
        format={(bytes) => `${kilobytes(bytes)} de ${kilobytes(FORK_MEMORY_ESSENTIAL_MAX_BYTES)}`}
      />

      <form
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void addNote();
        }}
      >
        <textarea
          className={FIELD}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Nueva nota: una decisión, una convención, un dato que costó averiguar"
          aria-label="Nueva nota"
          rows={2}
          maxLength={FORK_MEMORY_NOTE_MAX_LENGTH}
          disabled={!canWrite}
        />
        <div className="flex flex-wrap items-center justify-end gap-3">
          <label
            className={cn(
              "mr-auto flex items-center gap-2 text-[13px] text-muted-foreground",
              TOUCH,
            )}
          >
            <Switch
              checked={draftEssential}
              onCheckedChange={setDraftEssential}
              disabled={!canWrite}
            />
            Esencial
          </label>
          <button
            type="submit"
            className="ade-button"
            disabled={busy || !canWrite || oneLine(draft) === ""}
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
        <p className={HINT}>Aún no hay notas en este proyecto.</p>
      ) : (
        <ul className="m-0 grid list-none gap-2 p-0" aria-label="Notas del proyecto">
          {notes.map((note) => (
            <li
              key={note.id}
              className={cn(CARD, note.inclusion === "essential" && "border-primary/50")}
            >
              {editing?.id === note.id ? (
                <form
                  className="grid gap-2"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    if (await save({ ...note, text: editing.text })) setEditing(null);
                  }}
                >
                  <textarea
                    className={FIELD}
                    value={editing.text}
                    onChange={(event) => setEditing({ id: note.id, text: event.target.value })}
                    aria-label="Texto de la nota"
                    rows={3}
                    maxLength={FORK_MEMORY_NOTE_MAX_LENGTH}
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      className="ade-button-quiet m-0!"
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
                <p className="m-0 text-[13px] leading-snug break-words">{note.text}</p>
              )}
              <div className="flex flex-wrap items-center gap-3">
                <span className="ade-chip">{note.origin === "agent" ? "Agente" : "Usuario"}</span>
                <label
                  className={cn("flex items-center gap-2 text-xs text-muted-foreground", TOUCH)}
                >
                  <Switch
                    checked={note.inclusion === "essential"}
                    onCheckedChange={(essential) =>
                      void save({ ...note, inclusion: essential ? "essential" : "searchable" })
                    }
                    disabled={busy || !canWrite || editing?.id === note.id}
                  />
                  Esencial
                </label>
                <span className="ml-auto flex gap-1">
                  <button
                    type="button"
                    className="ade-icon-button"
                    onClick={() => setEditing({ id: note.id, text: note.text })}
                    disabled={!canWrite}
                    aria-label="Editar nota"
                  >
                    <PencilIcon size={16} aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="ade-icon-button"
                    onClick={() => void removeNote(note)}
                    disabled={busy || !canWrite}
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

      <CoordinatorRoutines environmentId={environmentId} bot={bot} confirm={confirm.ask} />
      {confirm.dialog}
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

type RoutineForm = Extract<CoordinatorRoutine, { kind: "daily" | "webhook" }>;

function CoordinatorRoutines(props: {
  environmentId: EnvironmentId;
  bot: ForkBot;
  confirm: ReturnType<typeof useConfirm>["ask"];
}) {
  const { environmentId, bot, confirm } = props;
  const registry = useContext(RegistryContext);
  const tasksResult = useAtomValue(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const canSchedule =
    useAtomValue(serverEnvironment.upsertScheduledTask.permissionAtom(environmentId)) === true;
  const [form, setForm] = useState<RoutineForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const threadId = bot.threadId;
  // Until the list arrives, a second nightly routine could not be told apart from the first.
  const loaded = tasksResult._tag === "Success";
  const tasks =
    loaded && threadId !== null
      ? tasksResult.value.tasks.filter((task) => task.threadId === threadId)
      : [];
  const hasNightly = tasks.some((task) => task.prompt === NIGHTLY_CONSOLIDATION_PROMPT);
  const disabled = busy || !loaded || !canSchedule || threadId === null;

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
    const agreed = await confirm({
      title: "¿Quitar esta rutina?",
      description: task.title,
      confirmLabel: "Quitar",
    });
    if (!agreed) return;
    setBusy(true);
    setError(null);
    const failure = await runCommand(
      registry,
      serverEnvironment.deleteScheduledTask,
      { environmentId, input: { id: task.id } },
      "No se pudo quitar la rutina",
    );
    setBusy(false);
    if (failure !== null) setError(failure);
  };

  return (
    <section
      className="grid gap-2 border-t border-border pt-2.5"
      aria-label="Rutinas del coordinador"
    >
      <h3 className="m-0 text-[13px] font-semibold">Rutinas</h3>
      <p className={HINT}>
        {threadId === null
          ? "Escríbele primero al coordinador: las rutinas continúan su hilo."
          : "Las rutinas continúan su hilo. La consolidación nocturna, a las 03:00, fusiona duplicados y propone qué bajar de esenciales."}
      </p>
      {tasksResult._tag === "Failure" ? (
        <p className="ade-error" role="alert">
          No se pudieron leer las rutinas
          {`: ${errorDisplayMessage(Cause.squash(tasksResult.cause)) ?? "error desconocido"}`}
        </p>
      ) : loaded ? null : (
        <p className={HINT}>Cargando rutinas…</p>
      )}
      {tasks.length === 0 ? null : (
        <ul className="m-0 grid list-none gap-2 p-0">
          {tasks.map((task) => (
            <li key={task.id} className={CARD}>
              <p className="m-0 text-[13px] break-words">{task.title}</p>
              <div className="flex items-center gap-2">
                <span className={cn(HINT, "min-w-0 break-all")}>{scheduleLabel(task)}</span>
                <button
                  type="button"
                  className="ade-icon-button ml-auto"
                  onClick={() => void remove(task)}
                  disabled={busy || !canSchedule}
                  aria-label={`Quitar ${task.title}`}
                >
                  <TrashIcon size={16} aria-hidden />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {form === null ? (
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            className="ade-button-quiet m-0!"
            onClick={() => setForm({ kind: "daily", title: "", prompt: "", timeOfDay: "09:00" })}
            disabled={disabled}
          >
            Añadir rutina
          </button>
          <button
            type="button"
            className="ade-button-quiet m-0!"
            onClick={() => void create({ kind: "nightly" })}
            disabled={disabled || hasNightly}
          >
            {hasNightly ? "Consolidación nocturna activa" : "Consolidación nocturna"}
          </button>
        </div>
      ) : (
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void create(form);
          }}
        >
          <input
            className={FIELD}
            value={form.title}
            onChange={(event) => setForm({ ...form, title: event.target.value })}
            placeholder="Título"
            aria-label="Título de la rutina"
          />
          <textarea
            className={FIELD}
            value={form.prompt}
            onChange={(event) => setForm({ ...form, prompt: event.target.value })}
            placeholder="Qué tiene que hacer el coordinador"
            aria-label="Encargo de la rutina"
            rows={3}
          />
          <div className="flex flex-wrap items-center justify-end gap-2">
            <select
              className={cn(FIELD, "w-auto flex-[1_1_100%] sm:flex-[1_1_200px]")}
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
                className={cn(FIELD, "w-auto flex-[1_1_100px]")}
                type="time"
                value={form.timeOfDay}
                onChange={(event) => setForm({ ...form, timeOfDay: event.target.value })}
                aria-label="Hora"
                required
              />
            ) : null}
            <button type="button" className="ade-button-quiet m-0!" onClick={() => setForm(null)}>
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
