import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { ClockIcon } from "@phosphor-icons/react/dist/csr/Clock";
import { NotePencilIcon } from "@phosphor-icons/react/dist/csr/NotePencil";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { ProhibitIcon } from "@phosphor-icons/react/dist/csr/Prohibit";
import { PulseIcon } from "@phosphor-icons/react/dist/csr/Pulse";
import { TrashIcon } from "@phosphor-icons/react/dist/csr/Trash";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  type EnvironmentId,
  type ForkCoordinationStatus,
  type ProjectId,
  projectKeyFromName,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { type FormEvent, useContext, useMemo, useState } from "react";

import { runCommand } from "../composer/Composer.tsx";
import { environmentCatalog } from "../connection/runtime.ts";
import { listedThreadsAtom, selectedThreadKeyAtom, ThreadStateBadge } from "../sidebar/Sidebar.tsx";
import { operableEnvironmentIdsAtom } from "../state.ts";
import {
  buildProjectBoardGroups,
  COORDINATION_STATUSES,
  type CoordinationDraft,
  type CoordinationStatusFilter,
  type ProjectBoardGroup,
  type ProjectBoardItem,
  threadModelLabel,
  validateCoordinationDraft,
} from "./coordination.logic.ts";
import {
  allCoordinationEntriesAtom,
  allEnvironmentProjectsAtom,
  forkCoordinationRemoveCommand,
  forkCoordinationUpsertCommand,
  refreshCoordinationBoard,
} from "./coordination.state.ts";

const STATUS_META: Record<
  ForkCoordinationStatus,
  { readonly label: string; readonly Icon: typeof PulseIcon }
> = {
  working: { label: "En marcha", Icon: PulseIcon },
  waiting: { label: "Esperando", Icon: ClockIcon },
  blocked: { label: "Bloqueado", Icon: ProhibitIcon },
  done: { label: "Terminado", Icon: CheckCircleIcon },
};

const FILTER_LABELS: Record<CoordinationStatusFilter, string> = {
  all: "Todos",
  blocked: "Bloqueados",
  waiting: "Esperando",
  working: "En marcha",
  done: "Terminados",
};

interface EditorState {
  readonly mode: "create" | "edit";
  readonly environmentId: EnvironmentId;
  readonly draft: CoordinationDraft;
}

function formatUpdatedShort(iso: string): string {
  const parsed = DateTime.make(iso);
  if (Option.isNone(parsed)) return "";
  const diffMinutes = Math.max(
    0,
    Math.round(
      (DateTime.toEpochMillis(DateTime.nowUnsafe()) - DateTime.toEpochMillis(parsed.value)) /
        60_000,
    ),
  );
  if (diffMinutes < 1) return "ahora";
  if (diffMinutes < 60) return `hace ${diffMinutes} min`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `hace ${diffHours} h`;
  return DateTime.formatLocal(parsed.value, {
    locale: "es-ES",
    day: "numeric",
    month: "short",
  });
}

function CoordinationStatusBadge(props: { status: ForkCoordinationStatus }) {
  const { label, Icon } = STATUS_META[props.status];
  return (
    <span className="ade-coord-status" data-coord-status={props.status}>
      <Icon size={14} weight="bold" aria-hidden />
      {label}
    </span>
  );
}

function CoordinationEditor(props: {
  initial: EditorState;
  machineLabels: ReadonlyMap<EnvironmentId, string>;
  operableEnvs: ReadonlyArray<EnvironmentId>;
  projectsByEnv: ReadonlyMap<
    EnvironmentId,
    ReadonlyMap<string, { readonly id: ProjectId; readonly title: string }>
  >;
  threads: ReadonlyArray<EnvironmentThreadShell>;
  onClose: () => void;
}) {
  const registry = useContext(RegistryContext);
  const [environmentId, setEnvironmentId] = useState<EnvironmentId>(props.initial.environmentId);
  const [draft, setDraft] = useState<CoordinationDraft>(props.initial.draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canWrite = useAtomValue(forkCoordinationUpsertCommand.permissionAtom(environmentId));

  const machineOptions = useMemo(
    () =>
      props.operableEnvs.includes(environmentId)
        ? props.operableEnvs
        : [environmentId, ...props.operableEnvs],
    [environmentId, props.operableEnvs],
  );
  const envProjects = useMemo(
    () => [...(props.projectsByEnv.get(environmentId)?.values() ?? [])],
    [environmentId, props.projectsByEnv],
  );
  const envThreads = useMemo(
    () => props.threads.filter((thread) => thread.environmentId === environmentId),
    [environmentId, props.threads],
  );

  const selectKnownProject = (projectId: string) => {
    const project = props.projectsByEnv.get(environmentId)?.get(projectId);
    if (project === undefined) return;
    setDraft((current) => ({
      ...current,
      projectName: project.title,
      projectKey: projectKeyFromName(project.title, project.id),
    }));
  };

  const selectThread = (rawId: string) => {
    if (rawId === "") {
      setDraft(({ threadId: _removed, ...rest }) => rest);
      return;
    }
    const thread = envThreads.find((candidate) => candidate.id === rawId);
    if (thread === undefined) return;
    const project = props.projectsByEnv.get(environmentId)?.get(thread.projectId);
    const model = threadModelLabel(thread);
    setDraft((current) => ({
      ...current,
      threadId: thread.id,
      projectName: project?.title ?? current.projectName,
      projectKey:
        project === undefined ? current.projectKey : projectKeyFromName(project.title, project.id),
      agentName: current.agentName.trim() === "" ? thread.title : current.agentName,
      ...(model === null || current.modelLabel?.trim() ? {} : { modelLabel: model }),
    }));
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const validated = validateCoordinationDraft(draft);
    if (!validated.ok) {
      setError(validated.error);
      return;
    }
    setBusy(true);
    setError(null);
    const failure = await runCommand(
      registry,
      forkCoordinationUpsertCommand,
      { environmentId, input: validated.input },
      "No se pudo guardar la nota de coordinación",
    );
    setBusy(false);
    if (failure !== null) {
      setError(failure);
      return;
    }
    refreshCoordinationBoard(registry, environmentId);
    props.onClose();
  };

  return (
    <form className="ade-coord-form" onSubmit={(event) => void handleSubmit(event)}>
      <header className="ade-coord-form-header">
        <h2>{props.initial.mode === "edit" ? "Editar nota de estado" : "Nueva nota de estado"}</h2>
        <button type="button" className="ade-button-quiet" onClick={props.onClose}>
          Cancelar
        </button>
      </header>
      <div className="ade-coord-form-grid">
        <label>
          Máquina
          <select
            value={environmentId}
            disabled={props.initial.mode === "edit" || machineOptions.length <= 1}
            onChange={(event) => {
              setEnvironmentId(event.currentTarget.value as EnvironmentId);
              setDraft(({ threadId: _removed, ...rest }) => rest);
            }}
          >
            {machineOptions.map((id) => (
              <option key={id} value={id}>
                {props.machineLabels.get(id) ?? id}
              </option>
            ))}
          </select>
        </label>
        {envProjects.length > 0 ? (
          <label>
            Proyecto conectado (opcional)
            <select value="" onChange={(event) => selectKnownProject(event.currentTarget.value)}>
              <option value="">Elegir de esta máquina…</option>
              {envProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.title}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label>
          Nombre del proyecto
          <input
            value={draft.projectName}
            maxLength={160}
            required
            placeholder="Ej. T3 Code Fork"
            onChange={(event) => {
              const projectName = event.currentTarget.value;
              setDraft((current) => ({
                ...current,
                projectName,
                projectKey:
                  props.initial.mode === "edit"
                    ? current.projectKey
                    : projectKeyFromName(projectName),
              }));
            }}
          />
        </label>
        <label>
          Agente / hilo responsable
          <input
            value={draft.agentName}
            maxLength={120}
            required
            placeholder="Ej. Codex revisión o Claude UI"
            onChange={(event) =>
              setDraft((current) => ({ ...current, agentName: event.currentTarget.value }))
            }
          />
        </label>
        <label>
          Hilo vinculado (capa trasera)
          <select
            value={draft.threadId ?? ""}
            onChange={(event) => selectThread(event.currentTarget.value)}
          >
            <option value="">Sin hilo vinculado</option>
            {envThreads.map((thread) => (
              <option key={thread.id} value={thread.id}>
                {thread.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          Modelo (opcional)
          <input
            value={draft.modelLabel ?? ""}
            maxLength={120}
            placeholder="Ej. gpt-5.4 / claude-sonnet"
            onChange={(event) =>
              setDraft((current) => ({ ...current, modelLabel: event.currentTarget.value }))
            }
          />
        </label>
      </div>
      <fieldset className="ade-coord-status-picker">
        <legend>Estado</legend>
        <div className="ade-filter-chips">
          {COORDINATION_STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              className="ade-filter-chip"
              aria-pressed={draft.status === status}
              onClick={() => setDraft((current) => ({ ...current, status }))}
            >
              {STATUS_META[status].label}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="ade-coord-fields">
        <label>
          En qué está
          <textarea
            rows={2}
            maxLength={500}
            value={draft.workingOn}
            placeholder="Tarea activa ahora mismo"
            onChange={(event) =>
              setDraft((current) => ({ ...current, workingOn: event.currentTarget.value }))
            }
          />
        </label>
        <label>
          Qué ha hecho
          <textarea
            rows={2}
            maxLength={1000}
            value={draft.completedSummary}
            placeholder="Hitos cerrados para no repetir trabajo ni perder contexto"
            onChange={(event) =>
              setDraft((current) => ({ ...current, completedSummary: event.currentTarget.value }))
            }
          />
        </label>
        <label>
          Qué espera
          <textarea
            rows={2}
            maxLength={500}
            value={draft.waitingFor}
            placeholder="Aprobación, revisión, cuota o dependencia externa"
            onChange={(event) =>
              setDraft((current) => ({ ...current, waitingFor: event.currentTarget.value }))
            }
          />
        </label>
      </div>
      {!canWrite ? (
        <p className="ade-request-note" role="status">
          Solo lectura: esta sesión no tiene permiso de operación en esta máquina.
        </p>
      ) : null}
      {error === null ? null : (
        <p className="ade-error" role="alert">
          {error}
        </p>
      )}
      <div className="ade-coord-form-actions">
        <button type="submit" className="ade-button" disabled={busy || !canWrite}>
          {busy ? "Guardando…" : "Guardar nota"}
        </button>
      </div>
    </form>
  );
}

function ProjectBoardCard(props: {
  item: ProjectBoardItem;
  onOpenThread: (key: string) => void;
  onEdit: (item: ProjectBoardItem) => void;
  onRemove: (environmentId: EnvironmentId, id: string) => Promise<void>;
}) {
  const { item } = props;
  const canEdit = useAtomValue(forkCoordinationUpsertCommand.permissionAtom(item.environmentId));
  const canRemove = useAtomValue(forkCoordinationRemoveCommand.permissionAtom(item.environmentId));
  const [removing, setRemoving] = useState(false);

  return (
    <article className="ade-coord-card" data-coord-status={item.status}>
      <header className="ade-coord-card-head">
        <div className="ade-coord-card-badges">
          <CoordinationStatusBadge status={item.status} />
          {item.liveState === "needs-you" ? <ThreadStateBadge state="needs-you" withText /> : null}
          {item.entry === null ? <span className="ade-chip">Hilo en vivo</span> : null}
        </div>
        <span className="ade-coord-updated">{formatUpdatedShort(item.updatedAt)}</span>
      </header>
      <h3 className="ade-coord-title">{item.agentName}</h3>
      <p className="ade-coord-meta">
        <span>{item.machineLabel}</span>
        {item.modelLabel === null ? null : <span>· {item.modelLabel}</span>}
        {item.thread?.branch ? <span>· {item.thread.branch}</span> : null}
        {item.thread?.worktreePath ? <span>· worktree</span> : null}
      </p>
      {item.entry !== null ? (
        <dl className="ade-coord-notes">
          {item.workingOn !== "" ? (
            <div>
              <dt>En qué está</dt>
              <dd>{item.workingOn}</dd>
            </div>
          ) : null}
          {item.completedSummary !== "" ? (
            <div>
              <dt>Hecho</dt>
              <dd>{item.completedSummary}</dd>
            </div>
          ) : null}
          {item.waitingFor !== "" ? (
            <div>
              <dt>Espera</dt>
              <dd>{item.waitingFor}</dd>
            </div>
          ) : null}
        </dl>
      ) : (
        <p className="ade-coord-empty-note">
          Sin nota de coordinación aún. Anota en qué está para coordinar relevos y evitar solapes.
        </p>
      )}
      <footer className="ade-coord-card-actions">
        {item.threadKey === null ? null : (
          <button
            type="button"
            className="ade-backlayer-link"
            onClick={() => props.onOpenThread(item.threadKey!)}
          >
            <ArrowSquareOutIcon size={15} aria-hidden />
            <span>Ver hilo</span>
            <span className="ade-backlayer-hint">Capa trasera</span>
          </button>
        )}
        <div className="ade-coord-card-edit-actions">
          <button
            type="button"
            className="ade-button-quiet"
            disabled={!canEdit}
            onClick={() => props.onEdit(item)}
          >
            <NotePencilIcon size={14} aria-hidden />
            <span>{item.entry === null ? "Anotar" : "Editar"}</span>
          </button>
          {item.entry === null ? null : (
            <button
              type="button"
              className="ade-button-quiet"
              disabled={!canRemove || removing}
              onClick={async () => {
                setRemoving(true);
                await props.onRemove(item.environmentId, item.entry!.id);
                setRemoving(false);
              }}
            >
              <TrashIcon size={14} aria-hidden />
              <span>{removing ? "Quitando…" : "Limpiar"}</span>
            </button>
          )}
        </div>
      </footer>
    </article>
  );
}

function ProjectSection(props: {
  group: ProjectBoardGroup;
  canCreate: boolean;
  onAddForProject: (group: ProjectBoardGroup) => void;
  onOpenThread: (key: string) => void;
  onEditItem: (item: ProjectBoardItem) => void;
  onRemoveEntry: (environmentId: EnvironmentId, id: string) => Promise<void>;
}) {
  const { group } = props;
  return (
    <section className="ade-project-group" aria-label={group.projectName}>
      <header className="ade-project-group-header">
        <div>
          <h2>{group.projectName}</h2>
          <p className="ade-project-group-counts">
            {group.counts.needsYou > 0 ? (
              <span className="ade-count-accent">{group.counts.needsYou} te esperan</span>
            ) : null}
            {group.counts.blocked > 0 ? (
              <span className="ade-count-danger">{group.counts.blocked} bloqueados</span>
            ) : null}
            {group.counts.working > 0 ? <span>{group.counts.working} en marcha</span> : null}
            {group.counts.waiting > 0 ? <span>{group.counts.waiting} esperando</span> : null}
            <span>{group.counts.notes === 1 ? "1 nota" : `${group.counts.notes} notas`}</span>
          </p>
        </div>
        {props.canCreate ? (
          <button
            type="button"
            className="ade-button-quiet"
            onClick={() => props.onAddForProject(group)}
          >
            <PlusIcon size={14} aria-hidden />
            <span>Nota</span>
          </button>
        ) : null}
      </header>
      <div className="ade-coord-grid">
        {group.items.map((item) => (
          <ProjectBoardCard
            key={item.key}
            item={item}
            onOpenThread={props.onOpenThread}
            onEdit={props.onEditItem}
            onRemove={props.onRemoveEntry}
          />
        ))}
      </div>
    </section>
  );
}

/** Front-layer board grouped by project: combines persisted coordination notes with live threads. */
export function ProjectBoard() {
  const registry = useContext(RegistryContext);
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const threads = useAtomValue(listedThreadsAtom);
  const operableSet = useAtomValue(operableEnvironmentIdsAtom);
  const { byEnv, loadingCount, errors: loadErrors } = useAtomValue(allCoordinationEntriesAtom);
  const projectsByEnv = useAtomValue(allEnvironmentProjectsAtom);
  const openThread = useAtomSet(selectedThreadKeyAtom);

  const [statusFilter, setStatusFilter] = useState<CoordinationStatusFilter>("all");
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const machineLabels = useMemo(
    () =>
      new Map<EnvironmentId, string>(
        [...catalog.entries].map(([id, entry]) => [id, entry.target.label]),
      ),
    [catalog.entries],
  );
  const operableEnvs = useMemo(
    () => [...catalog.entries.keys()].filter((id) => operableSet.has(id)),
    [catalog.entries, operableSet],
  );

  const groups = useMemo(
    () =>
      buildProjectBoardGroups({
        machineLabels,
        projectsByEnv,
        threads,
        entriesByEnv: byEnv,
        statusFilter,
        query,
      }),
    [byEnv, machineLabels, projectsByEnv, query, statusFilter, threads],
  );

  const startNewNote = (project?: {
    readonly environmentId: EnvironmentId;
    readonly projectKey: string;
    readonly projectName: string;
  }) => {
    const defaultEnv = project?.environmentId ?? operableEnvs[0];
    if (defaultEnv === undefined) return;
    setEditor({
      mode: "create",
      environmentId: defaultEnv,
      draft: {
        projectKey: project?.projectKey ?? "",
        projectName: project?.projectName ?? "",
        agentName: "",
        status: "working",
        workingOn: "",
        completedSummary: "",
        waitingFor: "",
      },
    });
  };

  const startEditItem = (item: ProjectBoardItem) => {
    if (item.entry !== null) {
      setEditor({
        mode: "edit",
        environmentId: item.environmentId,
        draft: {
          id: item.entry.id,
          projectKey: item.entry.projectKey,
          projectName: item.entry.projectName,
          ...(item.entry.threadId === undefined ? {} : { threadId: item.entry.threadId }),
          agentName: item.entry.agentName,
          status: item.entry.status,
          workingOn: item.entry.workingOn,
          completedSummary: item.entry.completedSummary,
          waitingFor: item.entry.waitingFor,
          ...(item.entry.modelLabel === undefined ? {} : { modelLabel: item.entry.modelLabel }),
        },
      });
      return;
    }
    setEditor({
      mode: "create",
      environmentId: item.environmentId,
      draft: {
        projectKey: item.projectKey,
        projectName: item.projectName,
        ...(item.thread === null ? {} : { threadId: item.thread.id as ThreadId }),
        agentName: item.agentName,
        status: item.status,
        workingOn: "",
        completedSummary: "",
        waitingFor: "",
        ...(item.modelLabel === null ? {} : { modelLabel: item.modelLabel }),
      },
    });
  };

  const handleRemove = async (environmentId: EnvironmentId, id: string) => {
    setRemoveError(null);
    const failure = await runCommand(
      registry,
      forkCoordinationRemoveCommand,
      { environmentId, input: { id } },
      "No se pudo limpiar la nota",
    );
    if (failure !== null) {
      setRemoveError(failure);
      return;
    }
    refreshCoordinationBoard(registry, environmentId);
  };

  return (
    <div className="ade-projects">
      <header className="ade-projects-header">
        <div>
          <p className="ade-label">Capa frontal</p>
          <h1>Tablero por proyecto</h1>
          <p className="ade-projects-subtitle">
            Estado coordinado e hilos en vivo por proyecto. Toca cualquier hilo para abrir su capa
            trasera.
          </p>
        </div>
        {operableEnvs.length > 0 ? (
          <button type="button" className="ade-button" onClick={() => startNewNote()}>
            <PlusIcon size={15} weight="bold" aria-hidden />
            <span>Nueva nota</span>
          </button>
        ) : null}
      </header>

      <div className="ade-projects-toolbar">
        <div className="ade-filter-chips" role="group" aria-label="Filtrar por estado">
          {(["all", ...COORDINATION_STATUSES] as const).map((status) => (
            <button
              key={status}
              type="button"
              className="ade-filter-chip"
              aria-pressed={statusFilter === status}
              onClick={() => setStatusFilter(status)}
            >
              {FILTER_LABELS[status]}
            </button>
          ))}
        </div>
        <label className="ade-projects-search">
          <span className="ade-sr-only">Buscar proyecto, agente o nota</span>
          <input
            type="search"
            value={query}
            placeholder="Filtrar proyecto, agente o nota…"
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </label>
      </div>

      {loadErrors.length === 0 ? null : (
        <div className="ade-error" role="status">
          {loadErrors.map((failure) => (
            <p key={failure.environmentId} className="ade-coord-load-error">
              {machineLabels.get(failure.environmentId) ?? failure.environmentId}: {failure.message}
            </p>
          ))}
        </div>
      )}

      {removeError === null ? null : (
        <p className="ade-error" role="alert">
          {removeError}
        </p>
      )}

      {editor === null ? null : (
        <CoordinationEditor
          key={`${editor.mode}:${editor.environmentId}:${editor.draft.id ?? editor.draft.threadId ?? editor.draft.projectKey}`}
          initial={editor}
          machineLabels={machineLabels}
          operableEnvs={operableEnvs}
          projectsByEnv={projectsByEnv}
          threads={threads}
          onClose={() => setEditor(null)}
        />
      )}

      {groups.length === 0 ? (
        <section className="ade-projects-empty">
          <p>
            {loadingCount > 0
              ? "Cargando tablero por proyecto…"
              : query.trim() !== "" || statusFilter !== "all"
                ? "Ninguna tarjeta coincide con este filtro."
                : "Todavía no hay notas ni hilos en los proyectos conectados."}
          </p>
          {operableEnvs.length > 0 && editor === null ? (
            <button type="button" className="ade-button-quiet" onClick={() => startNewNote()}>
              Crear primera nota de estado
            </button>
          ) : null}
        </section>
      ) : (
        <div className="ade-project-groups">
          {groups.map((group) => (
            <ProjectSection
              key={group.projectKey}
              group={group}
              canCreate={operableEnvs.length > 0}
              onAddForProject={(target) => {
                const preferredEnv =
                  target.environmentIds.find((id) => operableSet.has(id)) ?? operableEnvs[0];
                if (preferredEnv === undefined) return;
                startNewNote({
                  environmentId: preferredEnv,
                  projectKey: target.projectKey,
                  projectName: target.projectName,
                });
              }}
              onOpenThread={openThread}
              onEditItem={startEditItem}
              onRemoveEntry={handleRemove}
            />
          ))}
        </div>
      )}
    </div>
  );
}
