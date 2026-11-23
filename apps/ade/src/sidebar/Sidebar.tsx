import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { CheckCircleIcon } from "@phosphor-icons/react/dist/csr/CheckCircle";
import { PulseIcon } from "@phosphor-icons/react/dist/csr/Pulse";
import { WarningCircleIcon } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { XCircleIcon } from "@phosphor-icons/react/dist/csr/XCircle";
import { connectionRouteId, credentialConnectionId } from "@t3tools/client-runtime/connection";
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { arrayElementsEqual } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ThreadCheckpointSummary } from "@t3tools/client-runtime/state/thread-checkpoints";
import { turnHasChanges } from "@t3tools/client-runtime/state/thread-repositories";
import type { EnvironmentId, ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { lazy, memo, Suspense, useState } from "react";

import { gradientFillStyle } from "../../../web/src/fork/dither/style.ts";
import {
  type DecisionsPanelChoice,
  isDecisionsPanelOpen,
  selectNeedsYouThreads,
} from "../../../web/src/fork/decisions/decisions.logic.ts";
import { environmentCatalog } from "../connection/runtime.ts";
import { Composer } from "../composer/Composer.tsx";
import { ThreadRequests } from "../decisions/Requests.tsx";
import type { DiffRange } from "../diff/DiffView.tsx";
import { ThreadTimeline } from "../timeline/Timeline.tsx";
import {
  environmentProjects,
  environmentThreadDetails,
  environmentThreadShells,
  operableEnvironmentIdsAtom,
  terminalAccessAtom,
} from "../state.ts";
import { groupThreads, listedThreads, type ThreadState, threadState } from "./sidebar.logic.ts";

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

/** The waiting threads this ADE can answer, and whether their panel is open. */
export function useDecisionsPanel() {
  const threads = useAtomValue(needsYouThreadsAtom);
  const [choice, setChoice] = useAtom(decisionsChoiceAtom);
  const keys = threads.map((thread) =>
    scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
  );
  return {
    threads,
    open: isDecisionsPanelOpen(choice, keys),
    setOpen: (open: boolean) => setChoice({ open, seenKeys: keys }),
  };
}

// The selected thread lives in `?hilo=`, so a reload opens it again. Each choice is a history
// entry, so Back returns to the thread before.
const readSelectedFromUrl = () => new URLSearchParams(window.location.search).get("hilo");
export const selectedThreadKeyAtom = Atom.writable(
  (get) => {
    const onPopState = () => get.setSelf(readSelectedFromUrl());
    window.addEventListener("popstate", onPopState);
    get.addFinalizer(() => window.removeEventListener("popstate", onPopState));
    return readSelectedFromUrl();
  },
  (ctx, key: string | null) => {
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

export function NeedsYouBlock() {
  const { threads, open, setOpen } = useDecisionsPanel();
  const count = threads.length;
  const words = count === 1 ? "te necesita" : "te necesitan";
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
      onClick={() => setOpen(!open)}
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

export function ThreadTree() {
  const listed = useAtomValue(listedThreadsAtom);
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const [selected, setSelected] = useAtom(selectedThreadKeyAtom);
  const setMobileSidebar = useAtomSet(mobileSidebarOpenAtom);
  const groups = groupThreads(listed, [...catalog.entries.keys()]);
  if (groups.length === 0) return null;
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
          {machine.projects.map((project) => (
            <div key={project.projectId} className="ade-tree-project">
              <h3 className="ade-tree-project-title">
                <ProjectTitle environmentId={machine.environmentId} projectId={project.projectId} />
              </h3>
              <ul className="ade-tree-threads">
                {project.threads.map((thread) => {
                  const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
                  return (
                    <ThreadRow
                      key={key}
                      thread={thread}
                      selected={key === selected}
                      onSelect={selectThread}
                    />
                  );
                })}
              </ul>
            </div>
          ))}
        </section>
      ))}
    </nav>
  );
}

const NO_THREAD = Atom.make(null);
// The diff renderer loads with the first diff opened, not with the app.
const DiffView = lazy(() => import("../diff/DiffView.tsx"));

// Ghostty's wasm loads with the first terminal opened.
const TerminalView = lazy(() => import("../terminal/TerminalView.tsx"));

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

function TerminalButton(props: { environmentId: EnvironmentId; onOpen: () => void }) {
  const allowed = useAtomValue(terminalAccessAtom(props.environmentId));
  return (
    <span className="ade-why-anchor">
      <button
        type="button"
        className="ade-button-quiet"
        disabled={!allowed}
        aria-describedby={allowed ? undefined : "ade-terminal-why"}
        onClick={props.onOpen}
      >
        Terminal
      </button>
      {allowed ? null : (
        <span id="ade-terminal-why" role="tooltip" className="ade-why">
          Esta sesión no tiene permiso de terminal. Vuelve a emparejar la máquina marcando «Permitir
          terminal».
        </span>
      )}
    </span>
  );
}

/** A shell in the thread's worktree, or in its project's folder when it has none. */
function ThreadTerminal(props: {
  threadRef: ScopedThreadRef;
  thread: EnvironmentThreadShell;
  onClose: () => void;
}) {
  const root = useAtomValue(
    environmentProjects.environmentProjectIndexAtom(props.threadRef.environmentId),
    (index) => index.get(props.thread.projectId)?.workspaceRoot ?? null,
  );
  const cwd = props.thread.worktreePath ?? root;
  if (cwd === null) return <p className="ade-diff-note">Cargando el proyecto…</p>;
  return (
    <Suspense fallback={<p className="ade-diff-note">Cargando el terminal…</p>}>
      <TerminalView
        threadRef={props.threadRef}
        cwd={cwd}
        worktreePath={props.thread.worktreePath}
        onClose={props.onClose}
      />
    </Suspense>
  );
}

/** The selected thread: its header and its timeline; null with nothing selected. */
export function SelectedThread() {
  const [key, setKey] = useAtom(selectedThreadKeyAtom);
  const [diff, setDiff] = useState<{ key: string; range: DiffRange } | null>(null);
  const ref = key === null ? null : parseScopedThreadKey(key);
  const [terminal, setTerminal] = useState<{ key: string; pairing: string } | null>(null);
  const openDiff = (range: DiffRange) => {
    if (key === null) return;
    setTerminal(null);
    setDiff({ key, range });
  };
  const openRange = diff !== null && diff.key === key ? diff.range : null;
  const thread = useAtomValue(
    ref === null ? NO_THREAD : environmentThreadShells.quietThreadShellAtom(ref),
  );
  const machine = useAtomValue(environmentCatalog.catalogValueAtom, (catalog) =>
    ref === null ? null : (catalog.entries.get(ref.environmentId)?.target.label ?? null),
  );
  // The route's id is new each time the machine is paired. A terminal opened under another
  // pairing, or before the machine was removed, is not opened again by itself.
  const pairing = useAtomValue(environmentCatalog.catalogValueAtom, (catalog) => {
    const target = ref === null ? undefined : catalog.entries.get(ref.environmentId)?.target;
    return target === undefined ? null : credentialConnectionId(connectionRouteId(target));
  });
  if (ref === null) return null;
  const terminalOpen = terminal !== null && terminal.key === key && terminal.pairing === pairing;
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
          <div>
            <ThreadStateBadge state={threadState(thread)} withText />
            <h1>{thread.title}</h1>
            <p className="ade-thread-view-meta">
              {machine} ·{" "}
              <ProjectTitle environmentId={thread.environmentId} projectId={thread.projectId} />
              {thread.branch === null ? null : ` · ${thread.branch}`}
              {thread.worktreePath === null ? null : " · worktree"}
              {thread.modelSelection?.model ? ` · ${thread.modelSelection.model}` : null}
            </p>
          </div>
        )}
        <div className="ade-thread-view-actions">
          {machine === null ? null : <ThreadChangesButton threadRef={ref} onOpen={openDiff} />}
          {key === null || pairing === null || thread === null ? null : (
            <TerminalButton
              environmentId={ref.environmentId}
              onOpen={() => setTerminal({ key, pairing })}
            />
          )}
          <button type="button" className="ade-button-quiet" onClick={() => setKey(null)}>
            Volver
          </button>
        </div>
      </header>
      {machine === null ? null : terminalOpen && thread !== null ? (
        <ThreadTerminal
          key={key}
          threadRef={ref}
          thread={thread}
          onClose={() => setTerminal(null)}
        />
      ) : openRange !== null ? (
        <Suspense fallback={<p className="ade-diff-note">Cargando el diff…</p>}>
          <DiffView threadRef={ref} range={openRange} onClose={() => setDiff(null)} />
        </Suspense>
      ) : (
        <ThreadTimeline
          key={key}
          threadRef={ref}
          onOpenChanges={(checkpoint) => openDiff(turnRange(checkpoint))}
        />
      )}
      {machine === null || thread === null ? null : (
        <>
          <ThreadRequests key={`requests:${key}`} threadRef={ref} onOpenThread={setKey} />
          <Composer key={key} threadRef={ref} thread={thread} />
        </>
      )}
    </section>
  );
}
