import { RegistryContext, useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { ArrowRightIcon } from "@phosphor-icons/react/dist/csr/ArrowRight";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ClockCounterClockwise";
import { FileTextIcon } from "@phosphor-icons/react/dist/csr/FileText";
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
import { useContext, useRef, useState } from "react";

import { AgentAvatar, botMascot } from "../backroom/AgentAvatar.tsx";
import { Window } from "../backroom/Window.tsx";
import { WorkTile } from "../backroom/WorkTile.tsx";
import { botState } from "../bots/bots.logic.ts";
import {
  allBotsAtom,
  forkMemoryCorrectCommand,
  forkMemoryListQuery,
  forkMemoryRestoreCommand,
  refreshBots,
  refreshMemory,
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
  turnOpen,
} from "./memory.logic.ts";

/** Notes are one line; pasted line breaks become spaces, as the server requires. */
const oneLine = (text: string) => text.replace(/[\s\u0085]+/g, " ").trim();

export function MemoryView() {
  const { projects, machineCount, loading } = useAtomValue(homeProjectsAtom);
  const [selectedKey, setSelectedKey] = useAtom(selectedHomeProjectKeyAtom);
  const selected =
    (selectedKey === null ? undefined : projects.find((target) => target.key === selectedKey)) ??
    projects[0] ??
    null;

  return (
    <Window
      crumb="Memoria"
      label="Memoria"
      className="ade-memory"
      actions={
        projects.length > 1 ? (
          <label className="br-field">
            <span className="ade-sr-only">Proyecto</span>
            <select
              className="v4-chip"
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
        ) : undefined
      }
    >
      {selected === null ? (
        <p className="br-empty">
          {loading
            ? "Cargando proyectos…"
            : "Añade un proyecto para ver lo que el equipo sabe de él."}
        </p>
      ) : (
        <ProjectMemoryCard key={selected.key} target={selected} />
      )}
    </Window>
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
  const threads = useAtomValue(listedThreadsAtom);

  if (result._tag !== "Success") {
    return result._tag === "Failure" ? (
      <p className="ade-error" role="alert">
        No se pudo leer la memoria del proyecto
        {`: ${errorDisplayMessage(Cause.squash(result.cause)) ?? "error desconocido"}`}
      </p>
    ) : (
      <p className="br-empty">Cargando memoria…</p>
    );
  }
  const memory = result.value;
  const sections = memorySections(memory.notes);
  const readers = memoryReaders(bots, project.id, sections.essential.length);
  const coordinator = readers.find((reader) => reader.bot.coordinator)?.bot ?? null;
  const threadOf = (threadId: string | null | undefined) =>
    threads.find((thread) => thread.environmentId === environmentId && thread.id === threadId);
  // The server refuses to go back meanwhile; the button says why before anyone tries. The
  // correction's own thread counts too, in case the coordinator changed since.
  const coordinatorWorking =
    (coordinator !== null && turnOpen(threadOf(coordinator.threadId))) ||
    turnOpen(threadOf(memory.previous?.threadId));
  const now = DateTime.toEpochMillis(DateTime.nowUnsafe());

  return (
    <div className="v4-memory">
      <article className="v4-note">
        <header className="v4-note-head">
          <WorkTile kind="book" size="sm" />
          <span>
            <h3>Lo que el equipo sabe de {project.title}</h3>
            <small>
              <ClockCounterClockwiseIcon size={12} aria-hidden />
              {memory.revision === undefined
                ? memory.notes.length === 0
                  ? "Aún sin notas"
                  : `${memory.notes.length} notas`
                : `Revisión ${memory.revision}${memory.updatedAt === undefined ? "" : `, ${memoryAge(memory.updatedAt, now)}`}`}
            </small>
          </span>
        </header>

        {memory.notes.length === 0 ? (
          <p className="br-empty">
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
          coordinatorWorking={coordinatorWorking}
          now={now}
        />
      </article>

      <aside className="v4-memory-side" aria-label="Fuentes y quién la lee">
        <section>
          <h4>Fuentes</h4>
          {memory.notes.length === 0 && memory.previous === undefined ? (
            <p className="br-empty">Aún no hay fuentes: la primera nota abre la memoria.</p>
          ) : (
            <ul className="v4-sources">
              {(
                [
                  ["Escritas por ti", memory.notes.filter((note) => note.origin === "user").length],
                  ["De los agentes", memory.notes.filter((note) => note.origin === "agent").length],
                ] as const
              ).map(([label, count]) =>
                count === 0 ? null : (
                  <li key={label}>
                    <FileTextIcon size={15} aria-hidden />
                    <span>{label}</span>
                    <small>{count === 1 ? "1 nota" : `${count} notas`}</small>
                  </li>
                ),
              )}
              {memory.previous === undefined ? null : (
                <li>
                  <FileTextIcon size={15} aria-hidden />
                  <span>{previousLabel(memory.previous)}</span>
                  <small>v{memory.previous.revision}</small>
                </li>
              )}
            </ul>
          )}
        </section>
        <section>
          <h4>En su próximo encargo</h4>
          {readers.length === 0 ? (
            <p className="br-empty">
              Ningún bot trabaja en este proyecto. Sus hilos pueden buscar en ella igualmente.
            </p>
          ) : (
            <ul className="v4-next">
              {readers.map(({ bot, reads }) => (
                <Reader key={bot.id} environmentId={environmentId} bot={bot} reads={reads} />
              ))}
            </ul>
          )}
        </section>
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
    <section className="br-note-section" aria-label={props.title}>
      <h4>
        {props.title} · {props.notes.length}
        <span>{props.hint}</span>
      </h4>
      <dl className="v4-note-body">
        {props.notes.map((note) => (
          <div key={note.id}>
            <dt>
              {note.origin === "user" ? "Tú" : "Agente"}
              <small>{memoryAge(note.updatedAt, props.now)}</small>
            </dt>
            <dd>{note.text}</dd>
          </div>
        ))}
      </dl>
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
      <AgentAvatar kind={botMascot(props.bot)} />
      <span>
        <strong>
          {props.bot.name}
          {props.bot.coordinator ? " · coordina" : ""}
          {state.status === "working" ? " · trabajando" : ""}
        </strong>
        <span>{props.reads}</span>
      </span>
    </li>
  );
}

function Correction(props: {
  environmentId: EnvironmentId;
  memory: ForkMemoryListResult;
  projectId: HomeProjectTarget["project"]["id"];
  coordinatorHandle: string | null;
  coordinatorThreadId: ForkBot["threadId"];
  coordinatorWorking: boolean;
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
  // A ref, so two sends in one tick see each other before React renders.
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const start = () => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    return true;
  };
  // Also after a refusal, so the next try is made against what the server holds now.
  const finish = (failure: string | null) => {
    refreshMemory(registry, environmentId, projectId);
    // A correction may open the coordinator's thread; its readers should show it now.
    refreshBots(registry, environmentId);
    inFlight.current = false;
    setBusy(false);
    if (failure !== null) setError(failure);
  };

  const apply = async () => {
    const text = oneLine(draft);
    // The ref stops a second Enter; the revision stops one from another screen.
    if (text === "" || blocked !== null || !start()) return;
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
    if (failure === null) setDraft((current) => (oneLine(current) === text ? "" : current));
    finish(failure);
  };

  const restore = async () => {
    if (!start()) return;
    const failure = await runCommand(
      registry,
      forkMemoryRestoreCommand,
      { environmentId, input: { projectId, revision } },
      "No se pudo volver a la versión anterior",
    );
    setSent(null);
    finish(failure);
  };

  const previous = memory.previous;
  const changes = previous === undefined ? [] : memoryChanges(previous.notes, memory.notes);
  // The thread that holds the way back: the correction's own, else the coordinator's.
  const heldBy = previous?.threadId ?? coordinatorThreadId;
  const blocked =
    props.coordinatorHandle === null
      ? "Para corregir en una frase, el proyecto necesita un coordinador (en Bots)."
      : canCorrect
        ? null
        : "Esta conexión solo puede leer la memoria.";

  return (
    <>
      <form
        className="v4-correction"
        onSubmit={(event) => {
          event.preventDefault();
          void apply();
        }}
      >
        <span className="v4-you" aria-hidden>
          Tú
        </span>
        <div className="br-correction">
          <label htmlFor="ade-memory-correction" className="ade-sr-only">
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
          <div className="br-correction-row">
            <button
              type="submit"
              className="v4-primary"
              disabled={busy || blocked !== null || oneLine(draft) === ""}
            >
              <ArrowRightIcon size={14} aria-hidden />
              Aplicar la corrección
            </button>
            <span className="br-hint">
              {blocked ??
                sent ??
                `La aplica @${props.coordinatorHandle}; antes se guarda la versión actual.`}
            </span>
          </div>
        </div>
      </form>

      {error === null ? null : (
        <p className="ade-error" role="alert">
          {error}
        </p>
      )}

      {previous === undefined ? null : (
        <section className="br-note-section" aria-label="Antes y después">
          <header className="br-diff-head">
            <div>
              <h4>Antes y después</h4>
              <p>
                {previousLabel(previous)} · revisión {previous.revision},{" "}
                {memoryAge(previous.savedAt, props.now)}
              </p>
            </div>
            {heldBy === null ? null : (
              <button
                type="button"
                className="v4-secondary"
                onClick={() =>
                  setSelectedThread(scopedThreadKey(scopeThreadRef(environmentId, heldBy)))
                }
              >
                Ver el hilo
              </button>
            )}
          </header>
          {changes.length === 0 ? (
            <p className="br-empty">
              {previous.reason === "correction"
                ? "Aún sin cambios: el coordinador no ha guardado nada desde la corrección."
                : "Sin diferencias con la versión guardada."}
            </p>
          ) : (
            <dl className="v4-note-body br-changes">
              {changes.map((change) => (
                <div key={`${change.before?.id ?? ""}:${change.after?.id ?? ""}`} data-changed="">
                  <dt data-empty={change.before === null ? "" : undefined}>
                    <span className="ade-sr-only">Antes: </span>
                    {change.before?.text ?? "Nueva"}
                  </dt>
                  <dd>
                    <span className="ade-sr-only">Después: </span>
                    {change.after === null ? "Quitada" : <mark>{change.after.text}</mark>}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          <div className="br-correction-row">
            <span className="br-hint">
              {props.coordinatorWorking
                ? "El coordinador aún está aplicando la corrección; podrás volver cuando acabe."
                : "Volver deja guardada la versión de ahora, así que también se puede deshacer."}
            </span>
            <button
              type="button"
              className="v4-secondary"
              disabled={busy || !canRestore || changes.length === 0 || props.coordinatorWorking}
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
