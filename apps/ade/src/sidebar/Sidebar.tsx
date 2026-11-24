import { RegistryContext, useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { ArrowsLeftRightIcon } from "@phosphor-icons/react/dist/csr/ArrowsLeftRight";
import { BellSimpleRingingIcon } from "@phosphor-icons/react/dist/csr/BellSimpleRinging";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { PulseIcon } from "@phosphor-icons/react/dist/csr/Pulse";
import { WarningCircleIcon } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { XCircleIcon } from "@phosphor-icons/react/dist/csr/XCircle";
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { arrayElementsEqual } from "@t3tools/client-runtime/state/entities";
import type {
  EnvironmentThreadShell,
  ThreadStructureTurnItem,
} from "@t3tools/client-runtime/state/models";
import type { ThreadCheckpointSummary } from "@t3tools/client-runtime/state/thread-checkpoints";
import { turnHasChanges } from "@t3tools/client-runtime/state/thread-repositories";
import type { EnvironmentId, ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@ui-sdk/react/tooltip";
import { AsyncResult, Atom } from "effect/reactivity";
import { Fragment, lazy, memo, Suspense, useContext, useEffect, useMemo, useState } from "react";

import { gradientFillStyle } from "../../../web/src/fork/dither/style.ts";
import {
  type DecisionsPanelChoice,
  selectNeedsYouThreads,
} from "../../../web/src/fork/decisions/decisions.logic.ts";
import { environmentCatalog } from "../connection/runtime.ts";
import { Composer, runCommand } from "../composer/Composer.tsx";
import { RequestCards, ThreadRequests } from "../decisions/Requests.tsx";
import { isTrayOpenForViewport, reconcileTrayChoice } from "../decisions/tray.logic.ts";
import type { DiffRange } from "../diff/DiffView.tsx";
import {
  availableMachineProviderCatalog,
  findBackupCandidateForThread,
} from "../failover/failover.logic.ts";
import {
  forkFailoverGetStateQuery,
  forkFailoverSwitchThreadCommand,
  refreshFailoverState,
} from "../failover/failover.state.ts";
import { toolPanelAtom } from "../panels/FloatingPanel.tsx";
import { SearchButton } from "../search/SearchButton.tsx";
import { ThreadTimeline } from "../timeline/Timeline.tsx";
import { planStepChip } from "../timeline/timeline.logic.ts";
import {
  environmentProjects,
  environmentThreadDetails,
  environmentThreadShells,
  operableEnvironmentIdsAtom,
  serverEnvironment,
} from "../state.ts";
import {
  decisionsByRow,
  groupThreads,
  lineageKey,
  listedThreads,
  projectAccentColor,
  projectMonogram,
  type RailProject,
  railProjects,
  type ThreadState,
  threadState,
} from "./sidebar.logic.ts";
import { allBotsAtom } from "../bots/bots.state.ts";

const STATE_VIEW = {
  "needs-you": { Glyph: WarningCircleIcon, text: "Te necesita" },
  working: { Glyph: PulseIcon, text: "Trabajando" },
  error: { Glyph: XCircleIcon, text: "Error" },
  done: { Glyph: CheckCircleIcon, text: "Terminado" },
} satisfies Record<ThreadState, unknown>;

// Built on the quiet shells, which keep their reference through streaming: the lists change
// only when a thread changes in a way a row shows, never on each streamed token.
const stableList = (
  label: string,
  select: (
    threads: ReadonlyArray<EnvironmentThreadShell>,
    get: Atom.AtomContext,
  ) => EnvironmentThreadShell[],
) => {
  let previous: ReadonlyArray<EnvironmentThreadShell> = [];
  return Atom.make((get) => {
    const next = select(get(environmentThreadShells.quietThreadShellsAtom), get);
    if (arrayElementsEqual(previous, next)) return previous;
    previous = next;
    return next;
  }).pipe(Atom.withLabel(label));
};

export const listedThreadsAtom = stableList("ade-listed-threads", listedThreads);
// Subagents included: the one that asks is the one to answer. Only where this ADE can answer.
const needsYouThreadsAtom = stableList("ade-needs-you", (threads, get) => {
  const operable = get(operableEnvironmentIdsAtom);
  return selectNeedsYouThreads(threads).filter((thread) => operable.has(thread.environmentId));
});

const decisionsChoiceAtom = Atom.make<DecisionsPanelChoice | null>(null).pipe(Atom.keepAlive);

/** Controls the mobile sidebar drawer on narrow viewports (≤ 720 px); unused on desktop. */
export const mobileSidebarOpenAtom = Atom.make(false).pipe(
  Atom.keepAlive,
  Atom.withLabel("ade-mobile-sidebar-open"),
);

const PHONE_QUERY = "(max-width: 720px)";

const viewportAtom = (query: string, label: string) =>
  Atom.make((get) => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    const media = window.matchMedia(query);
    const onChange = () => get.setSelf(media.matches);
    media.addEventListener("change", onChange);
    get.addFinalizer(() => media.removeEventListener("change", onChange));
    return media.matches;
  }).pipe(Atom.keepAlive, Atom.withLabel(label));

/** Tracks narrow mobile viewports (<= 720 px) so the pending tray stays non-blocking on phones. */
export const narrowViewportAtom = viewportAtom(PHONE_QUERY, "ade-narrow-viewport");

/** A desktop window too narrow for the expanded sidebar, the reading column and a panel at once. */
export const crowdedViewportAtom = viewportAtom("(max-width: 1199px)", "ade-crowded-viewport");

/** The waiting threads this ADE can answer, and whether their panel is open. */
export function useDecisionsPanel() {
  const threads = useAtomValue(needsYouThreadsAtom);
  // A bot handoff cut for too many hops also waits for the user, so it counts and opens the panel.
  const { handoffsByEnv } = useAtomValue(allBotsAtom);
  const cutHandoffKeys = [...handoffsByEnv].flatMap(([environmentId, handoffs]) =>
    handoffs
      .filter((handoff) => handoff.status === "cut")
      .map((handoff) => `handoff:${environmentId}:${handoff.id}`),
  );
  const [choice, setChoice] = useAtom(decisionsChoiceAtom);
  const narrowViewport = useAtomValue(narrowViewportAtom);
  const keys = [
    ...threads.map((thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
    ...cutHandoffKeys,
  ];
  const [toolPanel, setToolPanel] = useAtom(toolPanelAtom);
  const effectiveChoice = reconcileTrayChoice(choice, keys, narrowViewport);
  useEffect(() => {
    if (effectiveChoice !== choice) {
      setChoice(effectiveChoice);
    }
  }, [choice, effectiveChoice, setChoice]);
  return {
    threads,
    count: keys.length,
    // One panel at a time: an open terminal or activity keeps decisions waiting behind it.
    open: toolPanel === null && isTrayOpenForViewport(effectiveChoice, keys, narrowViewport),
    setOpen: (open: boolean) => {
      if (open) setToolPanel(null);
      setChoice({ open, seenKeys: keys });
    },
  };
}

type SetAtom = <R, W>(atom: Atom.Writable<R, W>, value: W) => void;

/** On a phone a panel covers the screen: going to a thread or a view, Back included, closes it. */
export function closePanelsOnPhone(set: SetAtom) {
  if (typeof window === "undefined" || !window.matchMedia(PHONE_QUERY).matches) return;
  set(toolPanelAtom, null);
  set(decisionsChoiceAtom, null);
}

// The selected thread lives in `?hilo=`, so a reload opens it again. Each choice is a history
// entry, so Back returns to the thread before.
const readSelectedFromUrl = () => new URLSearchParams(window.location.search).get("hilo");
export const selectedThreadKeyAtom = Atom.writable(
  (get) => {
    const onPopState = () => {
      closePanelsOnPhone((atom, value) => get.set(atom, value));
      get.setSelf(readSelectedFromUrl());
    };
    window.addEventListener("popstate", onPopState);
    get.addFinalizer(() => window.removeEventListener("popstate", onPopState));
    return readSelectedFromUrl();
  },
  (ctx, key: string | null) => {
    closePanelsOnPhone((atom, value) => ctx.set(atom, value));
    if (key === readSelectedFromUrl()) return;
    const url = new URL(window.location.href);
    if (key === null) url.searchParams.delete("hilo");
    else url.searchParams.set("hilo", key);
    window.history.pushState(null, "", url);
    ctx.setSelf(key);
  },
).pipe(Atom.keepAlive);

export function ThreadStateBadge(props: { state: ThreadState; withText?: boolean }) {
  const { Glyph, text } = STATE_VIEW[props.state];
  return (
    <span className="ade-thread-state" data-state={props.state}>
      <Glyph size={14} weight="bold" aria-hidden />
      {props.withText === true ? text : <span className="ade-sr-only">{text}</span>}
    </span>
  );
}

export function NeedsYouBlock(props: { compact?: boolean }) {
  const { count, open, setOpen } = useDecisionsPanel();
  const setMobileSidebar = useAtomSet(mobileSidebarOpenAtom);
  const words = count === 1 ? "te necesita" : "te necesitan";
  if (props.compact) {
    if (count === 0) return null;
    const label = `${count} ${words} · ${open ? "ocultar decisiones" : "ver decisiones"}`;
    return (
      <Tooltip type="label">
        <TooltipTrigger
          type="button"
          className="ade-rail-button ade-rail-needs-you"
          aria-expanded={open}
          aria-controls="ade-decisions"
          onClick={() => setOpen(!open)}
        >
          <BellSimpleRingingIcon size={19} weight="fill" aria-hidden />
          <span className="ade-rail-count" aria-hidden>
            {count}
          </span>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8} className="ade-rail-tooltip">
          {label}
        </TooltipContent>
      </Tooltip>
    );
  }
  if (count === 0) {
    // Nothing to decide, so nothing to press.
    return (
      <div className="ade-needs-you" data-empty>
        <span className="ade-needs-you-count">0</span>
        <span>{words}</span>
      </div>
    );
  }
  return (
    <button
      type="button"
      className="ade-needs-you"
      aria-expanded={open}
      aria-controls="ade-decisions"
      onClick={() => {
        const nextOpen = !open;
        if (nextOpen) setMobileSidebar(false);
        setOpen(nextOpen);
      }}
    >
      <span className="ade-needs-you-count">{count}</span>
      <span className="ade-needs-you-words">
        {words}
        <span className="ade-needs-you-action">
          {open ? "Ocultar decisiones" : "Ver decisiones"}
        </span>
      </span>
      <span
        aria-hidden
        className="ade-needs-you-dither"
        style={gradientFillStyle({
          color: "currentColor",
          edge: "right",
          length: 16,
          from: 0.75,
          to: 0,
        })}
      />
    </button>
  );
}

export function ProjectTitle(props: { environmentId: EnvironmentId; projectId: ProjectId }) {
  const title = useAtomValue(
    environmentProjects.environmentProjectIndexAtom(props.environmentId),
    (index) => index.get(props.projectId)?.title ?? null,
  );
  return <>{title ?? "Proyecto sin nombre"}</>;
}

function ProjectRailButton(props: {
  project: RailProject<EnvironmentThreadShell>;
  machineLabel: string;
  active: boolean;
  onOpen: (key: string) => void;
}) {
  const title =
    useAtomValue(
      environmentProjects.environmentProjectIndexAtom(props.project.environmentId),
      (index) => index.get(props.project.projectId)?.title ?? null,
    ) ?? "Proyecto sin nombre";
  const label = props.project.hasPendingDecision
    ? `${title} · ${props.machineLabel} · espera una decisión`
    : `${title} · ${props.machineLabel}`;
  const threadKey = scopedThreadKey(
    scopeThreadRef(props.project.primaryThread.environmentId, props.project.primaryThread.id),
  );
  const accent = projectAccentColor(`${props.project.environmentId}:${props.project.projectId}`);
  return (
    <Tooltip type="label">
      <TooltipTrigger
        type="button"
        className="ade-rail-project"
        aria-current={props.active ? "true" : undefined}
        onClick={() => props.onOpen(threadKey)}
      >
        <span
          className="ade-rail-mark"
          style={{ "--ade-project-color": accent } as Record<string, string>}
          aria-hidden
        >
          {projectMonogram(title)}
        </span>
        {props.project.hasPendingDecision ? <span className="ade-rail-dot" aria-hidden /> : null}
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8} className="ade-rail-tooltip">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

export function ProjectRail() {
  const listed = useAtomValue(listedThreadsAtom);
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const operable = useAtomValue(operableEnvironmentIdsAtom);
  const [selected, setSelected] = useAtom(selectedThreadKeyAtom);
  const needsYou = useAtomValue(needsYouThreadsAtom);
  const allShells = useAtomValue(environmentThreadShells.quietThreadShellsAtom);
  const projects = railProjects(
    listed,
    [...catalog.entries.keys()],
    operable,
    new Set(decisionsByRow(needsYou, allShells, listed).keys()),
  );
  if (projects.length === 0) return null;
  const selectedRef = selected === null ? null : parseScopedThreadKey(selected);
  return (
    <nav className="ade-rail-projects" aria-label="Proyectos">
      {projects.map((project) => {
        const active =
          selectedRef !== null &&
          selectedRef.environmentId === project.environmentId &&
          project.threads.some((thread) => thread.id === selectedRef.threadId);
        const machineLabel =
          catalog.entries.get(project.environmentId)?.target.label ?? project.environmentId;
        return (
          <ProjectRailButton
            key={project.key}
            project={project}
            machineLabel={machineLabel}
            active={active}
            onOpen={setSelected}
          />
        );
      })}
    </nav>
  );
}

const ThreadRow = memo(function ThreadRow(props: {
  thread: EnvironmentThreadShell;
  selected: boolean;
  onSelect: (key: string) => void;
}) {
  const key = scopedThreadKey(scopeThreadRef(props.thread.environmentId, props.thread.id));
  return (
    <li>
      <button
        type="button"
        className="ade-thread"
        aria-current={props.selected ? "true" : undefined}
        onClick={() => props.onSelect(key)}
      >
        <ThreadStateBadge state={threadState(props.thread)} />
        <span className="ade-thread-title">{props.thread.title}</span>
      </button>
    </li>
  );
});

const CARDS_PER_PROJECT = 3;

export function ThreadTree() {
  const listed = useAtomValue(listedThreadsAtom);
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const [selected, setSelected] = useAtom(selectedThreadKeyAtom);
  const setMobileSidebar = useAtomSet(mobileSidebarOpenAtom);
  const needsYou = useAtomValue(needsYouThreadsAtom);
  const narrowViewport = useAtomValue(narrowViewportAtom);
  const allShells = useAtomValue(environmentThreadShells.quietThreadShellsAtom);
  const decisions = useDecisionsPanel();
  const groups = groupThreads(listed, [...catalog.entries.keys()]);
  if (groups.length === 0) return null;
  // The same waiting threads as the panel, each under the row that shows it. Phones have the
  // panel only: the sidebar there is a drawer, mostly hidden.
  const rows = decisionsByRow(
    narrowViewport
      ? []
      : needsYou.filter((thread) => thread.hasPendingApprovals || thread.hasPendingUserInput),
    allShells,
    listed,
  );
  const selectThread = (key: string) => {
    setSelected(key);
    setMobileSidebar(false);
  };
  return (
    <nav className="ade-tree" aria-label="Hilos">
      {groups.map((machine) => (
        <section key={machine.environmentId} className="ade-tree-machine">
          <h2 className="ade-label">
            {catalog.entries.get(machine.environmentId)?.target.label ?? machine.environmentId}
          </h2>
          {machine.projects.map((project) => {
            const waiting = project.threads.some((thread) => rows.has(lineageKey(thread)));
            // A few cards per project; the rest wait in the decisions panel.
            let shown = 0;
            let hidden = 0;
            const cardsOf = (thread: EnvironmentThreadShell) =>
              (rows.get(lineageKey(thread)) ?? []).filter(() => {
                if (shown === CARDS_PER_PROJECT) {
                  hidden += 1;
                  return false;
                }
                shown += 1;
                return true;
              });
            return (
              <div
                key={project.projectId}
                className="ade-tree-project"
                data-waiting={waiting ? "" : undefined}
              >
                <h3 className="ade-tree-project-title">
                  <ProjectTitle
                    environmentId={machine.environmentId}
                    projectId={project.projectId}
                  />
                </h3>
                <ul className="ade-tree-threads">
                  {project.threads.map((thread) => {
                    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
                    return (
                      <Fragment key={key}>
                        <ThreadRow
                          thread={thread}
                          selected={key === selected}
                          onSelect={selectThread}
                        />
                        {cardsOf(thread).map((waiting) => (
                          <li key={waiting.id} className="ade-tree-decision">
                            {waiting.id === thread.id ? null : (
                              <p className="ade-request-note">Del subagente «{waiting.title}»</p>
                            )}
                            <RequestCards
                              threadRef={scopeThreadRef(waiting.environmentId, waiting.id)}
                              subscribe
                            />
                          </li>
                        ))}
                      </Fragment>
                    );
                  })}
                </ul>
                {hidden === 0 ? null : (
                  <button
                    type="button"
                    className="ade-link ade-tree-more"
                    onClick={() => decisions.setOpen(true)}
                  >
                    {hidden === 1 ? "1 más" : `${hidden} más`} en «te necesitan»
                  </button>
                )}
              </div>
            );
          })}
        </section>
      ))}
    </nav>
  );
}

const NO_THREAD = Atom.make(null);
// The diff renderer loads with the first diff opened, not with the app.
const DiffView = lazy(() => import("../diff/DiffView.tsx"));

const turnRange = (checkpoint: ThreadCheckpointSummary): DiffRange => ({
  fromTurnCount: checkpoint.checkpointTurnCount - 1,
  toTurnCount: checkpoint.checkpointTurnCount,
  title: `Cambios del turno ${checkpoint.checkpointTurnCount}`,
});

function ThreadChangesButton(props: {
  threadRef: ScopedThreadRef;
  onOpen: (range: DiffRange) => void;
}) {
  const checkpoints = useAtomValue(
    environmentThreadDetails.checkpointSummariesAtom(props.threadRef),
  );
  const last = checkpoints.at(-1);
  if (last === undefined || !checkpoints.some(turnHasChanges)) return null;
  return (
    <button
      type="button"
      className="ade-button-quiet"
      onClick={() =>
        props.onOpen({
          fromTurnCount: 0,
          toTurnCount: last.checkpointTurnCount,
          title: "Cambios de todo el hilo",
        })
      }
    >
      Cambios del hilo
    </button>
  );
}

function ThreadFailoverButton(props: {
  threadRef: ScopedThreadRef;
  thread: EnvironmentThreadShell;
  onError: (error: string | null) => void;
}) {
  const registry = useContext(RegistryContext);
  const canSwitch = useAtomValue(
    forkFailoverSwitchThreadCommand.permissionAtom(props.threadRef.environmentId),
  );
  const failoverResult = useAtomValue(
    forkFailoverGetStateQuery({ environmentId: props.threadRef.environmentId, input: {} }),
  );
  const failoverState = AsyncResult.getOrElse(failoverResult, () => null);
  const serverConfig = useAtomValue(
    serverEnvironment.configValueAtom(props.threadRef.environmentId),
  );
  const running =
    useAtomValue(environmentThreadDetails.queueWorkflowAtom(props.threadRef))?.activeRun != null;
  const [switching, setSwitching] = useState(false);

  const candidate = useMemo(
    () =>
      findBackupCandidateForThread(
        failoverState?.config ?? null,
        props.thread.modelSelection,
        availableMachineProviderCatalog(serverConfig, props.thread.projectId),
      ),
    [failoverState?.config, props.thread.modelSelection, props.thread.projectId, serverConfig],
  );

  if (!canSwitch || candidate === null) return null;

  const handleSwitch = async () => {
    if (switching || running) return;
    setSwitching(true);
    props.onError(null);
    const failure = await runCommand(
      registry,
      forkFailoverSwitchThreadCommand,
      {
        environmentId: props.threadRef.environmentId,
        input: {
          threadId: props.threadRef.threadId,
          resume: threadState(props.thread) === "error",
        },
      },
      "No se pudo cambiar al modelo de respaldo",
    );
    setSwitching(false);
    if (failure !== null) {
      props.onError(failure);
      return;
    }
    refreshFailoverState(registry, props.threadRef.environmentId);
  };

  return (
    <button
      type="button"
      className="ade-button-quiet ade-failover-quick-switch"
      disabled={switching || running}
      aria-label={`Cambiar a respaldo (${candidate.instanceId}/${candidate.model})`}
      onClick={() => void handleSwitch()}
    >
      <ArrowsLeftRightIcon size={14} aria-hidden />
      <span>{switching ? "Cambiando…" : "Cambiar a respaldo"}</span>
    </button>
  );
}

/** The project's mark, as on the rail, and its name. */
function ProjectMark(props: { environmentId: EnvironmentId; projectId: ProjectId }) {
  const title =
    useAtomValue(
      environmentProjects.environmentProjectIndexAtom(props.environmentId),
      (index) => index.get(props.projectId)?.title ?? null,
    ) ?? "Proyecto sin nombre";
  const accent = projectAccentColor(`${props.environmentId}:${props.projectId}`);
  return (
    <>
      <span
        className="ade-thread-view-mark"
        style={{ "--ade-project-color": accent } as Record<string, string>}
        aria-hidden
      >
        {projectMonogram(title)}
      </span>
      <span className="ade-thread-view-project">{title}</span>
    </>
  );
}

const NO_TURN_ITEMS: ReadonlyArray<ThreadStructureTurnItem> = [];

/** «Paso 3 de 4 · …» while the latest run works or waits on the user; nothing otherwise. */
function ThreadStepChip(props: { threadRef: ScopedThreadRef; thread: EnvironmentThreadShell }) {
  // The quiet thread keeps its value while replies stream, so tokens re-render nothing here.
  const turnItems =
    useAtomValue(environmentThreadDetails.quietThreadAtom(props.threadRef))?.projection.turnItems ??
    NO_TURN_ITEMS;
  const state = threadState(props.thread);
  if (state !== "working" && state !== "needs-you") return null;
  const chip = planStepChip(turnItems, props.thread.latestRun?.runId ?? null);
  if (chip === null) return null;
  return (
    <p className="ade-step-chip">
      {chip.total > 10 ? null : (
        <span className="ade-step-dashes" aria-hidden>
          {chip.steps.map((step) => (
            <span key={step.id} data-status={step.status} />
          ))}
        </span>
      )}
      <span className="ade-step-count">
        Paso {chip.number} de {chip.total}
      </span>
      <span className="ade-step-text">{chip.text}</span>
    </p>
  );
}

/** «N te necesitan» in the thread header: opens the same decisions panel as the rail. */
function NeedsYouButton() {
  const { count, open, setOpen } = useDecisionsPanel();
  if (count === 0) return null;
  return (
    <button
      type="button"
      className="ade-header-needs-you"
      aria-expanded={open}
      aria-controls="ade-decisions"
      onClick={() => setOpen(!open)}
    >
      <span className="ade-header-needs-you-count">{count}</span>
      {count === 1 ? "te necesita" : "te necesitan"}
    </button>
  );
}

/** The selected thread: its header and its timeline; null with nothing selected. */
export function SelectedThread() {
  const [key, setKey] = useAtom(selectedThreadKeyAtom);
  const [diff, setDiff] = useState<{ key: string; range: DiffRange } | null>(null);
  const ref = key === null ? null : parseScopedThreadKey(key);
  const [failoverError, setFailoverError] = useState<{ key: string; message: string } | null>(null);
  const openDiff = (range: DiffRange) => {
    if (key === null) return;
    setDiff({ key, range });
  };
  const openRange = diff !== null && diff.key === key ? diff.range : null;
  const thread = useAtomValue(
    ref === null ? NO_THREAD : environmentThreadShells.quietThreadShellAtom(ref),
  );
  const machine = useAtomValue(environmentCatalog.catalogValueAtom, (catalog) =>
    ref === null ? null : (catalog.entries.get(ref.environmentId)?.target.label ?? null),
  );
  if (ref === null) return null;
  const requests =
    machine === null || thread === null ? null : (
      <ThreadRequests key={`requests:${key}`} threadRef={ref} onOpenThread={setKey} />
    );
  return (
    <section className="ade-thread-view">
      <header className="ade-thread-view-header">
        {thread === null ? (
          <p className="ade-thread-view-meta">
            {machine === null
              ? "Este hilo es de una máquina que ya no está emparejada."
              : "Cargando el hilo…"}
          </p>
        ) : (
          <div className="ade-thread-view-title">
            <div className="ade-thread-view-name">
              <ProjectMark environmentId={thread.environmentId} projectId={thread.projectId} />
              <h1>{thread.title}</h1>
              <ThreadStateBadge state={threadState(thread)} />
            </div>
            <ThreadStepChip threadRef={ref} thread={thread} />
          </div>
        )}
        <div className="ade-thread-view-actions">
          {machine === null || thread === null || key === null ? null : (
            <ThreadFailoverButton
              key={key}
              threadRef={ref}
              thread={thread}
              onError={(message) => setFailoverError(message === null ? null : { key, message })}
            />
          )}
          {machine === null ? null : <ThreadChangesButton threadRef={ref} onOpen={openDiff} />}
          <button type="button" className="ade-button-quiet" onClick={() => setKey(null)}>
            Volver
          </button>
          <SearchButton />
          <NeedsYouButton />
        </div>
      </header>
      {failoverError !== null && failoverError.key === key ? (
        <p className="ade-error ade-thread-failover-error" role="alert">
          {failoverError.message}
        </p>
      ) : null}
      {machine === null ? null : openRange !== null ? (
        <Suspense fallback={<p className="ade-diff-note">Cargando el diff…</p>}>
          <DiffView threadRef={ref} range={openRange} onClose={() => setDiff(null)} />
        </Suspense>
      ) : (
        <ThreadTimeline
          key={key}
          threadRef={ref}
          onOpenChanges={(checkpoint) => openDiff(turnRange(checkpoint))}
          requests={requests}
        />
      )}
      {/* With the diff in its place, the timeline's last row shows here. */}
      {openRange !== null ? <div className="ade-requests-outside">{requests}</div> : null}
      {machine === null || thread === null ? null : (
        <Composer key={`composer:${key}`} threadRef={ref} thread={thread} />
      )}
    </section>
  );
}
