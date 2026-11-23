import { useAtom, useAtomValue } from "@effect/atom-react";
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
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { memo } from "react";

import { gradientFillStyle } from "../../../web/src/fork/dither/style.ts";
import { selectNeedsYouThreads } from "../../../web/src/fork/decisions/decisions.logic.ts";
import { environmentCatalog } from "../connection/runtime.ts";
import { Composer } from "../composer/Composer.tsx";
import { ThreadTimeline } from "../timeline/Timeline.tsx";
import {
  environmentProjects,
  environmentThreadShells,
  operableEnvironmentIdsAtom,
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

const listedThreadsAtom = stableList("ade-listed-threads", listedThreads);
// Subagents included: the one that asks is the one to answer. Only where this ADE can answer.
const needsYouThreadsAtom = stableList("ade-needs-you", (threads, get) => {
  const operable = get(operableEnvironmentIdsAtom);
  return selectNeedsYouThreads(threads).filter((thread) => operable.has(thread.environmentId));
});

const needsYouFilterAtom = Atom.make(false).pipe(Atom.keepAlive);

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
  const count = useAtomValue(needsYouThreadsAtom).length;
  const [filtering, setFiltering] = useAtom(needsYouFilterAtom);
  const words = count === 1 ? "te necesita" : "te necesitan";
  if (count === 0) {
    // Nothing to filter to, so nothing to press.
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
      aria-pressed={filtering}
      onClick={() => setFiltering(!filtering)}
    >
      <span className="ade-needs-you-count">{count}</span>
      <span className="ade-needs-you-words">
        {words}
        <span className="ade-needs-you-action">{filtering ? "Ver todos" : "Ver solo estos"}</span>
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

function ProjectTitle(props: { environmentId: EnvironmentId; projectId: ProjectId }) {
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
  const needsYou = useAtomValue(needsYouThreadsAtom);
  const listed = useAtomValue(listedThreadsAtom);
  const filtering = useAtomValue(needsYouFilterAtom) && needsYou.length > 0;
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const [selected, setSelected] = useAtom(selectedThreadKeyAtom);
  const groups = groupThreads(filtering ? needsYou : listed, [...catalog.entries.keys()]);
  if (groups.length === 0) return null;
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
                      onSelect={setSelected}
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

/** The selected thread: its header and its timeline; null with nothing selected. */
export function SelectedThread() {
  const [key, setKey] = useAtom(selectedThreadKeyAtom);
  const ref = key === null ? null : parseScopedThreadKey(key);
  const thread = useAtomValue(
    ref === null ? NO_THREAD : environmentThreadShells.quietThreadShellAtom(ref),
  );
  const machine = useAtomValue(environmentCatalog.catalogValueAtom, (catalog) =>
    ref === null ? null : (catalog.entries.get(ref.environmentId)?.target.label ?? null),
  );
  if (ref === null) return null;
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
            </p>
          </div>
        )}
        <button type="button" className="ade-button-quiet" onClick={() => setKey(null)}>
          Volver al resumen
        </button>
      </header>
      {machine === null ? null : <ThreadTimeline key={key} threadRef={ref} />}
      {machine === null || thread === null ? null : (
        <Composer key={key} threadRef={ref} thread={thread} />
      )}
    </section>
  );
}
