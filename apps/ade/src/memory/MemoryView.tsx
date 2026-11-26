import { RegistryContext, useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import { BookOpenTextIcon } from "@phosphor-icons/react/dist/csr/BookOpenText";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ClockCounterClockwise";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import {
  type EnvironmentId,
  FORK_MEMORY_NOTE_MAX_LENGTH,
  type ForkBot,
  type ForkMemoryListResult,
  type ForkMemoryNote,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import { useContext, useState } from "react";

import { BotAvatar } from "../bots/BotAvatar.tsx";
import { botState } from "../bots/bots.logic.ts";
import {
  allBotsAtom,
  forkMemoryCorrectCommand,
  forkMemoryListQuery,
  forkMemoryRestoreCommand,
} from "../bots/bots.state.ts";
import { runCommand } from "../composer/Composer.tsx";
import { homeProjectsAtom, selectedHomeProjectKeyAtom } from "../home/Home.tsx";
import type { HomeProjectTarget } from "../home/home.logic.ts";
import { listedThreadsAtom, selectedThreadKeyAtom } from "../sidebar/Sidebar.tsx";
import {
  memoryAge,
  memoryChanges,
  memoryReaders,
  memorySections,
  previousLabel,
} from "./memory.logic.ts";

/** Notes are one line; pasted line breaks become spaces, as the server requires. */
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

export function MemoryView() {
  const { projects, machineCount, loading } = useAtomValue(homeProjectsAtom);
  const [selectedKey, setSelectedKey] = useAtom(selectedHomeProjectKeyAtom);
  const selected =
    (selectedKey === null ? undefined : projects.find((target) => target.key === selectedKey)) ??
    projects[0] ??
    null;

  return (
    <section className="ade-memory" aria-label="Memoria">
      <header className="ade-memory-head">
        <h1>Memoria</h1>
        {projects.length > 1 ? (
          <label className="ade-memory-field">
            Proyecto
            <select
              className="ade-memory-project"
              value={selected?.key ?? ""}
              onChange={(event) => setSelectedKey(event.target.value)}
            >
              {projects.map((target) => (
                <option key={target.key} value={target.key}>
                  {machineCount > 1
                    ? `${target.project.title} · ${target.machineLabel}`
                    : target.project.title}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </header>
      {selected === null ? (
        <p className="ade-memory-hint">
          {loading
            ? "Cargando proyectos…"
            : "Añade un proyecto para ver lo que el equipo sabe de él."}
        </p>
      ) : (
        <ProjectMemoryCard key={selected.key} target={selected} />
      )}
    </section>
  );
}

function ProjectMemoryCard(props: { target: HomeProjectTarget }) {
  const { environmentId, project } = props.target;
  const query = forkMemoryListQuery({
    environmentId,
    input: { projectId: project.id, includePrevious: true },
  });
  const result = useAtomValue(query);
  const bots = useAtomValue(allBotsAtom).byEnv.get(environmentId) ?? [];

  if (result._tag !== "Success") {
    return result._tag === "Failure" ? (
      <p className="ade-error" role="alert">
        No se pudo leer la memoria del proyecto
        {`: ${errorDisplayMessage(Cause.squash(result.cause)) ?? "error desconocido"}`}
      </p>
    ) : (
      <p className="ade-memory-hint">Cargando memoria…</p>
    );
  }
  const memory = result.value;
  const sections = memorySections(memory.notes);
  const readers = memoryReaders(bots, project.id, sections.essential.length);
  const coordinator = readers.find((reader) => reader.bot.coordinator)?.bot ?? null;
  const now = DateTime.toEpochMillis(DateTime.nowUnsafe());

  return (
    <div className="ade-memory-card">
      <div className="ade-memory-main">
        <div className="ade-memory-title">
          <span className="ade-memory-mark" aria-hidden>
            <BookOpenTextIcon size={18} weight="duotone" />
          </span>
          <div>
            <h2>Lo que el equipo sabe de {project.title}</h2>
            <p>
              <ClockCounterClockwiseIcon size={13} aria-hidden />
              {memory.revision === undefined
                ? memory.notes.length === 0
                  ? "Aún sin notas"
                  : `${memory.notes.length} notas`
                : `Revisión ${memory.revision}${memory.updatedAt === undefined ? "" : `, ${memoryAge(memory.updatedAt, now)}`}`}
            </p>
          </div>
        </div>

        {memory.notes.length === 0 ? (
          <p className="ade-memory-hint">
            Aún no hay notas. Los agentes guardan aquí decisiones, convenciones y datos que costó
            averiguar; tú puedes empezar con una frase.
          </p>
        ) : (
          <>
            <NoteSection
              title="Esenciales"
              hint="Llegan al coordinador en cada tarea"
              notes={sections.essential}
              now={now}
            />
            <NoteSection
              title="Buscables"
              hint="Se consultan cuando hacen falta"
              notes={sections.searchable}
              now={now}
            />
          </>
        )}

        <Correction
          environmentId={environmentId}
          memory={memory}
          projectId={project.id}
          coordinatorHandle={coordinator?.handle ?? null}
          coordinatorThreadId={coordinator?.threadId ?? null}
          now={now}
        />
      </div>

      <aside className="ade-memory-aside" aria-label="Quién la lee">
        <h3 className="ade-memory-label">En su próxima tarea</h3>
        {readers.length === 0 ? (
          <p className="ade-memory-hint">
            Ningún bot trabaja en este proyecto. Sus hilos pueden buscar en ella igualmente.
          </p>
        ) : (
          <ul className="ade-memory-readers">
            {readers.map(({ bot, reads }) => (
              <Reader key={bot.id} environmentId={environmentId} bot={bot} reads={reads} />
            ))}
          </ul>
        )}
      </aside>
    </div>
  );
}

function NoteSection(props: {
  title: string;
  hint: string;
  notes: ReadonlyArray<ForkMemoryNote>;
  now: number;
}) {
  if (props.notes.length === 0) return null;
  return (
    <section className="ade-memory-section" aria-label={props.title}>
      <h3 className="ade-memory-label">
        {props.title} · {props.notes.length}
        <span>{props.hint}</span>
      </h3>
      <ul className="ade-memory-rows">
        {props.notes.map((note) => (
          <li key={note.id}>
            <span className="ade-memory-who">
              {note.origin === "user" ? "Tú" : "Agente"}
              <span>{memoryAge(note.updatedAt, props.now)}</span>
            </span>
            <p>{note.text}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Reader(props: { environmentId: EnvironmentId; bot: ForkBot; reads: string }) {
  const threads = useAtomValue(listedThreadsAtom);
  const thread = threads.find(
    (candidate) =>
      candidate.environmentId === props.environmentId && candidate.id === props.bot.threadId,
  );
  const state = botState(props.bot, thread, false);
  return (
    <li>
      <BotAvatar status={state.status} size="sm" />
      <div>
        <strong>
          {props.bot.name}
          {props.bot.coordinator ? <span className="ade-chip">Coordinador</span> : null}
        </strong>
        <p>{props.reads}</p>
      </div>
    </li>
  );
}

function Correction(props: {
  environmentId: EnvironmentId;
  memory: ForkMemoryListResult;
  projectId: HomeProjectTarget["project"]["id"];
  coordinatorHandle: string | null;
  coordinatorThreadId: ForkBot["threadId"];
  now: number;
}) {
  const { environmentId, memory, projectId, coordinatorThreadId } = props;
  // What this screen shows; the server refuses a change made against an older one.
  const revision = memory.revision ?? 0;
  const registry = useContext(RegistryContext);
  const canCorrect = useAtomValue(forkMemoryCorrectCommand.permissionAtom(environmentId)) === true;
  const canRestore = useAtomValue(forkMemoryRestoreCommand.permissionAtom(environmentId)) === true;
  const setSelectedThread = useAtomSet(selectedThreadKeyAtom);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const refresh = () =>
    registry.refresh(
      forkMemoryListQuery({ environmentId, input: { projectId, includePrevious: true } }),
    );

  const apply = async () => {
    const text = oneLine(draft);
    // The busy check stops a second Enter; the revision stops one from another screen.
    if (text === "" || busy || blocked !== null) return;
    setBusy(true);
    setError(null);
    const failure = await runCommand(
      registry,
      forkMemoryCorrectCommand,
      { environmentId, input: { projectId, text, revision } },
      "No se pudo enviar la corrección",
      (result) =>
        setSent(
          result.queued
            ? `En cola para @${result.handle}: la aplica en cuanto acabe lo que hace.`
            : `@${result.handle} la está aplicando.`,
        ),
    );
    setBusy(false);
    if (failure !== null) return setError(failure);
    setDraft((current) => (oneLine(current) === text ? "" : current));
    refresh();
  };

  const restore = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const failure = await runCommand(
      registry,
      forkMemoryRestoreCommand,
      { environmentId, input: { projectId, revision } },
      "No se pudo volver a la versión anterior",
    );
    setBusy(false);
    setSent(null);
    if (failure !== null) return setError(failure);
    refresh();
  };

  const previous = memory.previous;
  const changes = previous === undefined ? [] : memoryChanges(previous.notes, memory.notes);
  const blocked =
    props.coordinatorHandle === null
      ? "Para corregir en una frase, el proyecto necesita un coordinador (en Bots)."
      : canCorrect
        ? null
        : "Esta conexión solo puede leer la memoria.";

  return (
    <>
      <form
        className="ade-memory-correct"
        onSubmit={(event) => {
          event.preventDefault();
          void apply();
        }}
      >
        <span className="ade-memory-you" aria-hidden>
          Tú
        </span>
        <div>
          <label htmlFor="ade-memory-correction" className="ade-memory-label">
            Corrígelo en una frase
          </label>
          <textarea
            id="ade-memory-correction"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void apply();
              }
            }}
            placeholder="«El pack cuesta 1.800 €, con una revisión incluida»"
            rows={2}
            maxLength={FORK_MEMORY_NOTE_MAX_LENGTH}
            disabled={busy || blocked !== null}
          />
          <div className="ade-memory-correct-row">
            <span className="ade-memory-hint">
              {blocked ??
                sent ??
                `La aplica @${props.coordinatorHandle}; antes se guarda la versión actual.`}
            </span>
            <button
              type="submit"
              className="ade-memory-apply"
              disabled={busy || blocked !== null || oneLine(draft) === ""}
            >
              <ArrowRightIcon size={15} aria-hidden />
              Aplicar corrección
            </button>
          </div>
        </div>
      </form>

      {error === null ? null : (
        <p className="ade-error" role="alert">
          {error}
        </p>
      )}

      {previous === undefined ? null : (
        <section className="ade-memory-diff" aria-label="Antes y después">
          <header>
            <div>
              <h3 className="ade-memory-label">Antes y después</h3>
              <p>
                {previousLabel(previous)} · revisión {previous.revision},{" "}
                {memoryAge(previous.savedAt, props.now)}
              </p>
            </div>
            {coordinatorThreadId === null ? null : (
              <button
                type="button"
                className="ade-button-quiet m-0!"
                onClick={() =>
                  setSelectedThread(
                    scopedThreadKey(scopeThreadRef(environmentId, coordinatorThreadId)),
                  )
                }
              >
                Ver el hilo
              </button>
            )}
          </header>
          {changes.length === 0 ? (
            <p className="ade-memory-hint">
              {previous.reason === "correction"
                ? "Aún sin cambios: el coordinador no ha guardado nada desde la corrección."
                : "Sin diferencias con la versión guardada."}
            </p>
          ) : (
            <ul className="ade-memory-changes">
              {changes.map((change) => (
                <li key={`${change.before?.id ?? ""}:${change.after?.id ?? ""}`}>
                  <p data-side="before" data-empty={change.before === null ? "" : undefined}>
                    <span className="ade-sr-only">Antes: </span>
                    {change.before?.text ?? "Nueva"}
                  </p>
                  <ArrowRightIcon size={14} aria-hidden />
                  <p data-side="after" data-empty={change.after === null ? "" : undefined}>
                    <span className="ade-sr-only">Después: </span>
                    {change.after === null ? "Quitada" : change.after.text}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <div className="ade-memory-correct-row">
            <span className="ade-memory-hint">
              Volver deja guardada la versión de ahora, así que también se puede deshacer.
            </span>
            <button
              type="button"
              className="ade-button-quiet m-0!"
              disabled={busy || !canRestore || changes.length === 0}
              onClick={() => void restore()}
            >
              <ArrowCounterClockwiseIcon size={15} aria-hidden />
              Volver a la revisión {previous.revision}
            </button>
          </div>
        </section>
      )}
    </>
  );
}
