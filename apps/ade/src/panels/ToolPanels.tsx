import { RegistryContext, useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { BroadcastIcon } from "@phosphor-icons/react/dist/csr/Broadcast";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { connectionRouteId, credentialConnectionId } from "@t3tools/client-runtime/connection";
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useShortcut } from "@ui-sdk/react/shortcuts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { Atom, type AtomRegistry } from "effect/reactivity";
import { lazy, Suspense, useContext } from "react";

import { environmentCatalog } from "../connection/runtime.ts";
import {
  listedThreadsAtom,
  narrowViewportAtom,
  ProjectTitle,
  selectedThreadKeyAtom,
  ThreadStateBadge,
  useDecisionsPanel,
} from "../sidebar/Sidebar.tsx";
import { threadState } from "../sidebar/sidebar.logic.ts";
import { environmentProjects, environmentThreadShells, terminalAccessAtom } from "../state.ts";
import {
  FloatingPanel,
  isFocusInTerminal,
  type ToolPanel,
  toolPanelAtom,
} from "./FloatingPanel.tsx";

// Ghostty's wasm loads with the first terminal opened.
const TerminalView = lazy(() => import("../terminal/TerminalView.tsx"));

const NO_THREAD = Atom.make(null);
const NO_ACCESS = Atom.make(false);

function clockTime(iso: string): string {
  const parsed = DateTime.make(iso);
  if (Option.isNone(parsed)) return "";
  return DateTime.formatLocal(parsed.value, {
    locale: "es-ES",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const readCatalog = (registry: AtomRegistry.AtomRegistry) =>
  registry.get(environmentCatalog.catalogValueAtom);
type Catalog = ReturnType<typeof readCatalog>;

// The route's id is new each time the machine is paired.
function pairingOf(catalog: Catalog, ref: ScopedThreadRef | null): string | null {
  const target = ref === null ? undefined : catalog.entries.get(ref.environmentId)?.target;
  return target === undefined ? null : credentialConnectionId(connectionRouteId(target));
}

const refOf = (key: string | null) => (key === null ? null : parseScopedThreadKey(key));

/** Opens a tool panel in place of whatever panel is open. */
export function useOpenToolPanel() {
  const registry = useContext(RegistryContext);
  const decisions = useDecisionsPanel();
  return (kind: ToolPanel["kind"]) => {
    if (decisions.open) decisions.setOpen(false);
    registry.set(
      toolPanelAtom,
      kind === "actividad"
        ? { kind }
        : {
            kind,
            pairing: pairingOf(readCatalog(registry), refOf(registry.get(selectedThreadKeyAtom))),
          },
    );
  };
}

/** The open tool panel, if any, and Ctrl+J for the terminal. */
export function ToolPanels() {
  const [panel, setPanel] = useAtom(toolPanelAtom);
  const openToolPanel = useOpenToolPanel();
  useShortcut(
    "mod+j",
    () => (panel?.kind === "terminal" ? setPanel(null) : openToolPanel("terminal")),
    { when: () => !isFocusInTerminal(), description: "Abrir o cerrar la terminal" },
  );
  if (panel === null) return null;
  const close = () => setPanel(null);
  if (panel.kind === "actividad") {
    return (
      <FloatingPanel
        key="actividad"
        label="Actividad en vivo"
        icon={<BroadcastIcon size={16} aria-hidden />}
        onClose={close}
      >
        <Activity />
      </FloatingPanel>
    );
  }
  return (
    <FloatingPanel
      key="terminal"
      label="Terminal"
      icon={<TerminalWindowIcon size={16} aria-hidden />}
      onClose={close}
    >
      <TerminalBody pairing={panel.pairing} onClose={close} />
    </FloatingPanel>
  );
}

/** The selected thread's shell, or why there is none. */
function TerminalBody(props: { pairing: string | null; onClose: () => void }) {
  const key = useAtomValue(selectedThreadKeyAtom);
  const ref = refOf(key);
  const currentPairing = useAtomValue(environmentCatalog.catalogValueAtom, (catalog) =>
    pairingOf(catalog, ref),
  );
  const thread = useAtomValue(
    ref === null ? NO_THREAD : environmentThreadShells.quietThreadShellAtom(ref),
  );
  const allowed = useAtomValue(ref === null ? NO_ACCESS : terminalAccessAtom(ref.environmentId));
  const note = (text: string) => <p className="ade-panel-note">{text}</p>;
  if (ref === null) {
    return note("La terminal se abre en la carpeta de un hilo. Abre uno y vuelve a pulsar Ctrl+J.");
  }
  if (currentPairing === null) return note("La máquina de este hilo ya no está emparejada.");
  if (!allowed) {
    return note(
      "Esta sesión no tiene permiso de terminal. Vuelve a emparejar la máquina marcando «Permitir terminal».",
    );
  }
  // A terminal opened under another pairing is not opened again by itself.
  if (props.pairing !== currentPairing) {
    return note("La máquina se emparejó de nuevo. Abre la terminal otra vez con Ctrl+J.");
  }
  if (thread === null) return note("Cargando el hilo…");
  return <ThreadTerminal key={key} threadRef={ref} thread={thread} onClose={props.onClose} />;
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
  if (cwd === null) return <p className="ade-panel-note">Cargando el proyecto…</p>;
  return (
    <Suspense fallback={<p className="ade-panel-note">Cargando el terminal…</p>}>
      <TerminalView
        threadRef={props.threadRef}
        cwd={cwd}
        worktreePath={props.thread.worktreePath}
        onClose={props.onClose}
      />
    </Suspense>
  );
}

/** The threads that changed last, newest first; each opens its thread. */
function Activity() {
  const listed = useAtomValue(listedThreadsAtom);
  const setSelected = useAtomSet(selectedThreadKeyAtom);
  const setPanel = useAtomSet(toolPanelAtom);
  const narrowViewport = useAtomValue(narrowViewportAtom);
  const recent = [...listed].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 15);
  if (recent.length === 0) return <p className="ade-panel-note">Aún no hay actividad.</p>;
  return (
    <ol className="ade-activity">
      {recent.map((thread) => {
        const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
        return (
          <li key={key}>
            <button
              type="button"
              className="ade-activity-row"
              onClick={() => {
                setSelected(key);
                // On a phone the panel covers the thread it just opened.
                if (narrowViewport) setPanel(null);
              }}
            >
              <time dateTime={thread.updatedAt}>{clockTime(thread.updatedAt)}</time>
              <ThreadStateBadge state={threadState(thread)} />
              <span className="ade-activity-title">{thread.title}</span>
              <span className="ade-activity-project">
                <ProjectTitle environmentId={thread.environmentId} projectId={thread.projectId} />
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
