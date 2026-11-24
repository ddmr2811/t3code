import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  AVAILABLE_CONNECTION_STATE,
  presentConnectionState,
} from "@t3tools/client-runtime/connection";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  createTerminalEnvironmentAtoms,
  EMPTY_TERMINAL_BUFFER_STATE,
  INITIAL_TERMINAL_OUTPUT_CURSOR,
  readTerminalOutputUpdate,
  type TerminalBufferState,
} from "@t3tools/client-runtime/state/terminal";
import {
  DEFAULT_TERMINAL_ID,
  EnvironmentAuthorizationError,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { useContext, useEffect, useRef, useState } from "react";

// The monorepo's libghostty-vt surface (wasm, canvas, input), shared with apps/web, not copied.
import { GhosttyTerminalSurface } from "../../../web/src/terminal/ghostty/surface.ts";
import { connectionAtomRuntime, environmentCatalog } from "../connection/runtime.ts";
import { terminalAccessAtom } from "../state.ts";
import { drainTerminalInput, type QueuedInput } from "./input.logic.ts";

// Here, not in state.ts, so the terminal's transport loads with the first terminal opened.
const terminalEnvironment = createTerminalEnvironmentAtoms(connectionAtomRuntime);

const rgb = (hex: string) => ({
  r: Number.parseInt(hex.slice(1, 3), 16),
  g: Number.parseInt(hex.slice(3, 5), 16),
  b: Number.parseInt(hex.slice(5, 7), 16),
});

// The ADE's own tokens (ade.css) and the ANSI colors apps/web uses on dark.
const THEME = {
  background: rgb("#0a0a0a"),
  foreground: rgb("#f5f5f5"),
  cursor: rgb("#d97757"),
  selectionBackground: "rgba(217, 119, 87, 0.3)",
  palette: [
    "#000000",
    "#cd3131",
    "#0dbc79",
    "#e5e510",
    "#2472c8",
    "#bc3fbc",
    "#11a8cd",
    "#e5e5e5",
    "#666666",
    "#f14c4c",
    "#23d18b",
    "#f5f543",
    "#3b8eea",
    "#d670d6",
    "#29b8db",
    "#e5e5e5",
  ].map(rgb),
};
const FIRST_GRID = { cols: 80, rows: 24 };

type Status = TerminalBufferState["status"] | "opening" | "refused" | "failed";

const STATUS_TEXT: Record<Status, string> = {
  opening: "Abriendo…",
  starting: "Abriendo…",
  running: "En marcha",
  exited: "El proceso terminó",
  closed: "Cerrado",
  error: "El terminal falló en la máquina",
  refused: "La máquina rechazó el terminal: esta sesión no tiene permiso para abrirlo.",
  failed: "No se pudo abrir el terminal.",
};

const isRefusal = Schema.is(EnvironmentAuthorizationError);

/**
 * The thread's terminal: one shell on its machine, in the thread's folder. Output goes from the
 * session straight to the canvas; React only renders the status line.
 */
export default function TerminalView(props: {
  threadRef: ScopedThreadRef;
  cwd: string;
  worktreePath: string | null;
  onClose: () => void;
}) {
  // A shell that ended stays on screen until the user asks for another one.
  const [shell, setShell] = useState(0);
  return <Shell key={shell} {...props} onReopen={() => setShell(shell + 1)} />;
}

function Shell(props: {
  threadRef: ScopedThreadRef;
  cwd: string;
  worktreePath: string | null;
  onClose: () => void;
  onReopen: () => void;
}) {
  const registry = useContext(RegistryContext);
  const { environmentId, threadId } = props.threadRef;
  const { cwd, worktreePath } = props;
  const mountRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>("opening");
  const connected = useAtomValue(
    environmentCatalog.stateAtom(environmentId),
    (result) =>
      presentConnectionState(AsyncResult.getOrElse(result, () => AVAILABLE_CONNECTION_STATE))
        .phase === "connected",
  );

  useEffect(() => {
    const mount = mountRef.current;
    if (mount === null) return;
    const terminalId = DEFAULT_TERMINAL_ID;
    const input = { threadId, terminalId, cwd, worktreePath, ...FIRST_GRID };
    const attachAtom = terminalEnvironment.attach({ environmentId, input });
    const canOperate = () => registry.get(terminalAccessAtom(environmentId));
    let surface: GhosttyTerminalSurface | null = null;
    let disposed = false;
    let cursor = INITIAL_TERMINAL_OUTPUT_CURSOR;

    const session = terminalEnvironment.createSession({
      target: { environmentId, threadId, terminalId },
      gridSize: FIRST_GRID,
      canOperate,
      onExit: () => setStatus("exited"),
    });

    // One write at a time keeps keystrokes in order; what is typed meanwhile travels together.
    const queue: Array<QueuedInput> = [];
    let sending = false;
    // The server refuses input until the shell runs. A restart or a reattachment is another shell.
    let shell: string | null = null;
    const liveShell = () => (disposed || !canOperate() ? null : shell);
    const send = async (data: string, kind?: "binary" | "reply") => {
      const typedInto = liveShell();
      if (typedInto === null) return;
      const last = queue.at(-1);
      if (last !== undefined && last.kind === kind && last.shell === typedInto) last.data += data;
      else queue.push({ data, shell: typedInto, ...(kind === undefined ? {} : { kind }) });
      if (sending) return;
      sending = true;
      await drainTerminalInput(queue, liveShell, async (chunk, chunkKind) => {
        const result = await runAtomCommand(
          registry,
          terminalEnvironment.write,
          {
            environmentId,
            input: {
              threadId,
              terminalId,
              data: chunk,
              ...(chunkKind === undefined ? {} : { [chunkKind]: true }),
            },
          },
          { reportFailure: false },
        );
        return result._tag === "Success";
      });
      sending = false;
    };

    const apply = (result: AsyncResult.AsyncResult<TerminalBufferState, unknown>) => {
      if (result._tag === "Failure") {
        shell = null;
        const error = Option.getOrNull(Cause.findErrorOption(result.cause));
        setStatus(isRefusal(error) ? "refused" : "failed");
        return;
      }
      const buffer = AsyncResult.getOrElse(result, () => EMPTY_TERMINAL_BUFFER_STATE);
      if (buffer.version === 0) return;
      shell =
        buffer.status === "running"
          ? `${buffer.output.generation}:${buffer.lifecycleVersion}`
          : null;
      setStatus(buffer.status);
      if (surface === null) return;
      surface.setSharedGrid(buffer.grid);
      const update = readTerminalOutputUpdate(buffer.output, cursor);
      cursor = update.cursor;
      if (update.type === "reset") surface.resetAndWrite(update.data);
      else if (update.type === "append") surface.write(update.data);
    };

    // An attachment the server refused stays failed: ask again, the grant may have changed.
    registry.refresh(attachAtom);
    const stopSession = registry.mount(session.driver({ kind: "attached", input }));
    const stopOutput = registry.subscribe(attachAtom, apply, { immediate: true });
    void GhosttyTerminalSurface.create(mount, {
      theme: THEME,
      font: { family: "Geist Mono", size: 13 },
      onData: (data) => void send(data),
      onBinary: (data) => void send(data, "binary"),
      onReply: (data) => void send(data, "reply"),
      onResize: (cols, rows) => session.reportGridSize({ cols, rows }),
      onSelectionChange: () => {},
      beforeKey: () => true,
      onLinkActivate: () => {},
      canActivateLink: () => false,
    }).then(
      (created) => {
        if (disposed) return created.dispose();
        surface = created;
        created.input.setAttribute("aria-label", "Entrada del terminal");
        created.scrollbar.setAttribute("aria-label", "Historial del terminal");
        apply(registry.get(attachAtom));
        created.focus();
      },
      () => {
        if (!disposed) setStatus("failed");
      },
    );
    return () => {
      disposed = true;
      stopOutput();
      stopSession();
      surface?.dispose();
    };
  }, [registry, environmentId, threadId, cwd, worktreePath]);

  const close = () => {
    void runAtomCommand(
      registry,
      terminalEnvironment.close,
      { environmentId, input: { threadId, terminalId: DEFAULT_TERMINAL_ID, deleteHistory: false } },
      { reportFailure: false },
    );
    props.onClose();
  };
  const ended = status === "exited" || status === "closed";
  const problem = status === "refused" || status === "failed" || status === "error";

  return (
    <section className="ade-terminal" aria-label="Terminal">
      <header className="ade-terminal-header">
        {/* The panel around it says «Terminal»; this says where. */}
        <p className="ade-terminal-cwd">{worktreePath ?? cwd}</p>
        <p className="ade-terminal-status" role={problem ? "alert" : "status"}>
          {connected || problem
            ? STATUS_TEXT[status]
            : "Sin conexión con la máquina. El shell sigue allí y vuelve al reconectar."}
        </p>
        {ended ? (
          <button type="button" className="ade-button-quiet" onClick={props.onReopen}>
            Abrir otro
          </button>
        ) : problem ? null : (
          <button type="button" className="ade-button-quiet" onClick={close}>
            Cerrar el terminal compartido con la web
          </button>
        )}
      </header>
      <div ref={mountRef} className="ade-terminal-mount" />
    </section>
  );
}
