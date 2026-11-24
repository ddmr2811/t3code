import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { BellIcon } from "@phosphor-icons/react/dist/csr/Bell";
import { BellSlashIcon } from "@phosphor-icons/react/dist/csr/BellSlash";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId } from "@t3tools/contracts";
import { useContext, useMemo, useState } from "react";

import { environmentCatalog } from "../connection/runtime.ts";
import { ProjectTitle, selectedThreadKeyAtom, useDecisionsPanel } from "../sidebar/Sidebar.tsx";
import {
  pendingAlertsEnabledAtom,
  pendingAlertsErrorAtom,
  pendingAlertsPermissionAtom,
  togglePendingAlerts,
  usePendingTrayNotifications,
} from "./notifications.ts";
import { RequestCards } from "./Requests.tsx";
import {
  buildPendingTrayItems,
  countPendingByKind,
  filterPendingItems,
  type PendingTrayFilterKind,
  type PendingTrayItem,
  type PendingTrayKind,
} from "./tray.logic.ts";

const KIND_LABELS: Record<PendingTrayKind, string> = {
  approval: "Aprobación",
  question: "Pregunta",
  plan: "Plan",
  guest: "Invitado",
};

const FILTER_LABELS: Record<PendingTrayFilterKind, string> = {
  all: "Todas",
  approval: "Aprobaciones",
  question: "Preguntas",
  plan: "Planes",
  guest: "Invitados",
};

const FILTER_ORDER: ReadonlyArray<PendingTrayFilterKind> = [
  "all",
  "approval",
  "question",
  "plan",
  "guest",
];

function DecisionCard(props: {
  item: PendingTrayItem<EnvironmentThreadShell>;
  onOpenBackLayer: (threadKey: string) => void;
}) {
  const { item } = props;
  const { thread } = item;
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const hasRequest = thread.hasPendingApprovals || thread.hasPendingUserInput;
  return (
    <section className="ade-decision" aria-label={thread.title}>
      <div className="ade-decision-top">
        <p className="ade-thread-view-meta">
          {item.machineLabel} ·{" "}
          <ProjectTitle environmentId={thread.environmentId} projectId={thread.projectId} />
          {thread.branch === null ? null : ` · ${thread.branch}`}
        </p>
        <div className="ade-decision-kinds">
          {item.kinds.map((kind) => (
            <span key={kind} className="ade-chip" data-kind={kind}>
              {KIND_LABELS[kind]}
            </span>
          ))}
        </div>
      </div>
      <h3>{thread.title}</h3>
      <RequestCards threadRef={threadRef} subscribe={hasRequest} />
      {hasRequest ? null : (
        <p className="ade-request-note">
          {(thread.pendingGuestMessageCount ?? 0) > 0
            ? "Un invitado quiere enviar un mensaje. Revísalo en el hilo."
            : "El plan está listo. Revísalo en el hilo."}
        </p>
      )}
      <div className="ade-decision-footer">
        <button
          type="button"
          className="ade-backlayer-link"
          onClick={() => props.onOpenBackLayer(scopedThreadKey(threadRef))}
        >
          <ArrowSquareOutIcon size={15} aria-hidden />
          <span>Abrir el hilo</span>
          <span className="ade-backlayer-hint">Capa trasera</span>
        </button>
      </div>
    </section>
  );
}

/**
 * Unified non-blocking pending tray across all operable machines.
 * Closes itself with none left while keeping its notification watcher active.
 */
export function DecisionsPanel() {
  const registry = useContext(RegistryContext);
  const { threads, open, setOpen } = useDecisionsPanel();
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const selectThread = useAtomSet(selectedThreadKeyAtom);
  const alertsEnabled = useAtomValue(pendingAlertsEnabledAtom);
  const alertsPermission = useAtomValue(pendingAlertsPermissionAtom);
  const alertsNote = useAtomValue(pendingAlertsErrorAtom);
  const [kindFilter, setKindFilter] = useState<PendingTrayFilterKind>("all");
  const [machineFilter, setMachineFilter] = useState<EnvironmentId | "all">("all");

  const items = useMemo(
    () =>
      buildPendingTrayItems(
        threads,
        (environmentId) => catalog.entries.get(environmentId)?.target.label ?? environmentId,
      ),
    [catalog.entries, threads],
  );

  const openBackLayer = (threadKey: string) => {
    selectThread(threadKey);
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 720px)").matches) {
      setOpen(false);
    }
  };

  usePendingTrayNotifications(items, openBackLayer);

  if (!open) return null;

  const counts = countPendingByKind(items);
  const machinesInTray = [...new Map(items.map((item) => [item.environmentId, item.machineLabel]))];
  const effectiveMachine =
    machineFilter !== "all" && machinesInTray.some(([id]) => id === machineFilter)
      ? machineFilter
      : "all";
  const effectiveKind = kindFilter !== "all" && counts[kindFilter] === 0 ? "all" : kindFilter;
  const visible = filterPendingItems(items, {
    kind: effectiveKind,
    environmentId: effectiveMachine,
  });

  const handleToggleAlerts = async () => {
    await togglePendingAlerts(registry);
  };

  return (
    <aside id="ade-decisions" className="ade-decisions" aria-label="Decisiones">
      <header>
        <div>
          <p className="ade-label">
            {threads.length === 1 ? "1 pendiente" : `${threads.length} pendientes`}
          </p>
          <h2>Decisiones</h2>
        </div>
        <div className="ade-decisions-header-actions">
          <button
            type="button"
            className="ade-button-quiet ade-alert-toggle"
            aria-pressed={alertsEnabled}
            aria-label={
              alertsPermission === "denied"
                ? "Notificaciones bloqueadas en el navegador"
                : alertsEnabled
                  ? "Desactivar avisos del navegador"
                  : "Activar avisos al llegar nuevos pendientes"
            }
            onClick={() => void handleToggleAlerts()}
          >
            {alertsEnabled ? (
              <BellIcon size={15} weight="fill" aria-hidden />
            ) : (
              <BellSlashIcon size={15} aria-hidden />
            )}
            <span>{alertsEnabled ? "Avisos" : "Sin avisos"}</span>
          </button>
          <button type="button" className="ade-button-quiet" onClick={() => setOpen(false)}>
            Cerrar
          </button>
        </div>
      </header>
      {alertsNote === null ? null : (
        <p className="ade-request-note" role="status">
          {alertsNote}
        </p>
      )}
      {items.length > 1 || effectiveKind !== "all" || effectiveMachine !== "all" ? (
        <div className="ade-tray-filters" role="group" aria-label="Filtrar pendientes">
          <div className="ade-filter-chips">
            {FILTER_ORDER.filter((kind) => kind === "all" || counts[kind] > 0).map((kind) => (
              <button
                key={kind}
                type="button"
                className="ade-filter-chip"
                aria-pressed={effectiveKind === kind}
                onClick={() => setKindFilter(kind)}
              >
                {FILTER_LABELS[kind]} <span>{counts[kind]}</span>
              </button>
            ))}
          </div>
          {machinesInTray.length > 1 ? (
            <label className="ade-tray-machine-filter">
              <span className="ade-sr-only">Filtrar por máquina</span>
              <select
                value={effectiveMachine}
                onChange={(event) =>
                  setMachineFilter(event.currentTarget.value as EnvironmentId | "all")
                }
              >
                <option value="all">Todas las máquinas ({machinesInTray.length})</option>
                {machinesInTray.map(([environmentId, label]) => (
                  <option key={environmentId} value={environmentId}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      ) : null}
      {visible.length === 0 ? (
        <p className="ade-request-note">Ningún pendiente coincide con el filtro actual.</p>
      ) : (
        visible.map((item) => (
          <DecisionCard key={item.key} item={item} onOpenBackLayer={openBackLayer} />
        ))
      )}
    </aside>
  );
}
