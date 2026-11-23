import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import { environmentCatalog } from "../connection/runtime.ts";
import { ProjectTitle, selectedThreadKeyAtom, useDecisionsPanel } from "../sidebar/Sidebar.tsx";
import { RequestCards } from "./Requests.tsx";

function DecisionCard(props: { thread: EnvironmentThreadShell }) {
  const { thread } = props;
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const select = useAtomSet(selectedThreadKeyAtom);
  const machine = useAtomValue(
    environmentCatalog.catalogValueAtom,
    (catalog) => catalog.entries.get(thread.environmentId)?.target.label ?? thread.environmentId,
  );
  const hasRequest = thread.hasPendingApprovals || thread.hasPendingUserInput;
  return (
    <section className="ade-decision" aria-label={thread.title}>
      <p className="ade-thread-view-meta">
        {machine} ·{" "}
        <ProjectTitle environmentId={thread.environmentId} projectId={thread.projectId} />
      </p>
      <h3>{thread.title}</h3>
      <RequestCards threadRef={threadRef} subscribe={hasRequest} />
      {hasRequest ? null : (
        <p className="ade-request-note">
          {(thread.pendingGuestMessageCount ?? 0) > 0
            ? "Un invitado quiere enviar un mensaje. Revísalo en el hilo."
            : "El plan está listo. Revísalo en el hilo."}
        </p>
      )}
      <button type="button" className="ade-link" onClick={() => select(scopedThreadKey(threadRef))}>
        Abrir el hilo
      </button>
    </section>
  );
}

/** Every pending request of every machine this ADE can answer on; closes itself with none left. */
export function DecisionsPanel() {
  const { threads, open, setOpen } = useDecisionsPanel();
  if (!open) return null;
  return (
    <aside id="ade-decisions" className="ade-decisions" aria-label="Decisiones">
      <header>
        <div>
          <p className="ade-label">
            {threads.length === 1 ? "1 pendiente" : `${threads.length} pendientes`}
          </p>
          <h2>Decisiones</h2>
        </div>
        <button type="button" className="ade-button-quiet" onClick={() => setOpen(false)}>
          Cerrar
        </button>
      </header>
      {threads.map((thread) => (
        <DecisionCard key={`${thread.environmentId}:${thread.id}`} thread={thread} />
      ))}
    </aside>
  );
}
