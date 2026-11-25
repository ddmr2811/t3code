import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { secondTick } from "@t3tools/client-runtime/clock";
import {
  BACKGROUND_WORK_STOP_RETRY_AFTER_MS,
  isBackgroundWorkStopPending,
  type BackgroundWorkStopRequest,
} from "@t3tools/client-runtime/state/thread-execution";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useContext, useState } from "react";

import { runCommand } from "../composer/Composer.tsx";
import { environmentThreadDetails, operateAccessAtom, threadEnvironment } from "../state.ts";
import { tickElapsed } from "./elapsed.ts";
import { backgroundWork } from "./timeline.logic.ts";

/** Work the agent left going, such as a delegated task, above the composer as T3 shows it. */
export function BackgroundWorkBar(props: {
  threadRef: ScopedThreadRef;
  onOpenThread: (key: string) => void;
}) {
  const { threadRef } = props;
  const registry = useContext(RegistryContext);
  // The quiet thread keeps its value while replies stream, so tokens re-render nothing here.
  const thread = useAtomValue(environmentThreadDetails.quietThreadAtom(threadRef));
  const canStop = useAtomValue(operateAccessAtom(threadRef.environmentId)) === "operate";
  // Interrupt stops the active run first, not this work; the composer owns that Stop.
  const runIsLive =
    useAtomValue(environmentThreadDetails.queueWorkflowAtom(threadRef))?.activeRun != null;
  const [open, setOpen] = useState(false);
  const [stop, setStop] = useState<BackgroundWorkStopRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const work = thread === null ? null : backgroundWork(thread.projection);
  if (work === null) return null;
  const threadKey = scopedThreadKey(threadRef);
  const stopping = isBackgroundWorkStopPending(stop, threadKey, work.tasks, false);
  const startedAtMs = work.startedAtMs;

  // Accepted is not ended: «Parando…» stays while the tasks are listed, and frees up after a
  // while in case the provider never lets go, as in T3.
  const interrupt = async () => {
    const request = { threadKey, taskIds: work.tasks.map((task) => task.taskId), retryAt: null };
    setStop(request);
    setError(null);
    const failure = await runCommand(
      registry,
      threadEnvironment.interruptTurn,
      { environmentId: threadRef.environmentId, input: { threadId: threadRef.threadId } },
      "No se pudo parar el trabajo en segundo plano",
    );
    if (failure !== null) {
      setStop(null);
      setError(failure);
      return;
    }
    const accepted = {
      ...request,
      retryAt: secondTick.getSnapshot() + BACKGROUND_WORK_STOP_RETRY_AFTER_MS,
    };
    setStop((current) => (current === request ? accepted : current));
    // @effect-diagnostics-next-line globalTimers:off -- a click handler, outside any Effect program.
    setTimeout(
      () => setStop((current) => (current === accepted ? null : current)),
      BACKGROUND_WORK_STOP_RETRY_AFTER_MS,
    );
  };

  return (
    <div className="ade-background">
      <div className="ade-background-bar">
        <p className="ade-background-title" role="status">
          {work.title}
        </p>
        {startedAtMs === null ? null : (
          <span
            className="ade-background-time"
            ref={tickElapsed((nowMs) => Math.max(1_000, nowMs - startedAtMs), true)}
          />
        )}
        <button
          type="button"
          className="ade-background-action"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          Detalles
        </button>
        {canStop ? (
          <button
            type="button"
            className="ade-background-action"
            disabled={stopping || runIsLive}
            onClick={() => void interrupt()}
          >
            {stopping ? "Parando…" : "Parar"}
          </button>
        ) : null}
      </div>
      {open ? (
        <ul className="ade-background-list" aria-label="Trabajo en segundo plano">
          {work.tasks.map(({ taskId, label, waiting, childThreadId }) => (
            <li key={taskId}>
              <span className="ade-background-label">{label}</span>
              <span className="ade-background-state">{waiting ? "Esperando" : "En marcha"}</span>
              {childThreadId === undefined ? null : (
                <button
                  type="button"
                  className="ade-background-action"
                  onClick={() =>
                    props.onOpenThread(
                      scopedThreadKey(scopeThreadRef(threadRef.environmentId, childThreadId)),
                    )
                  }
                >
                  Abrir
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {error === null ? null : (
        <p className="ade-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
