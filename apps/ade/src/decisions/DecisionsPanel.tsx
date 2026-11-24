import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import type { PendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import { Atom } from "effect/reactivity";
import { ArrowSquareOutIcon } from "@phosphor-icons/react/dist/csr/ArrowSquareOut";
import { BellIcon } from "@phosphor-icons/react/dist/csr/Bell";
import { BellSimpleRingingIcon } from "@phosphor-icons/react/dist/csr/BellSimpleRinging";
import { BellSlashIcon } from "@phosphor-icons/react/dist/csr/BellSlash";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId } from "@t3tools/contracts";
import { useShortcut } from "@ui-sdk/react/shortcuts";
import { type ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";

import { environmentCatalog } from "../connection/runtime.ts";
import { environmentThreadDetails } from "../state.ts";
import { FloatingPanel } from "../panels/FloatingPanel.tsx";
import { ProjectTitle, selectedThreadKeyAtom, useDecisionsPanel } from "../sidebar/Sidebar.tsx";
import {
  pendingAlertsEnabledAtom,
  pendingAlertsErrorAtom,
  pendingAlertsPermissionAtom,
  togglePendingAlerts,
  usePendingTrayNotifications,
} from "./notifications.ts";
import { HandoffNotices, useCutHandoffs } from "./HandoffNotices.tsx";
import { FirstRequest, RequestCards, trayHasFocus } from "./Requests.tsx";
import {
  buildPendingTrayItems,
  countPendingByKind,
  filterPendingItems,
  nextSnoozeReturn,
  waitingIds,
  type PendingTrayFilterKind,
  type PendingTrayItem,
  type PendingTrayKind,
  type Snoozes,
} from "./tray.logic.ts";
import {
  bringBackDecision,
  snoozeClockAtom,
  snoozeDecision,
  snoozesAtom,
  tickSnoozeClock,
} from "./snoozed.ts";

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

type TrayMode = "una" | "lista" | "pospuestas";

const MODE_LABELS: Record<TrayMode, string> = {
  una: "Una a una",
  lista: "Lista",
  pospuestas: "Pospuestas",
};

/** A row of the tray: a waiting thread, or a cut bot handoff (`item` null). */
interface TrayEntry {
  readonly key: string;
  readonly kind: PendingTrayKind;
  readonly label: string;
  readonly title: string;
  readonly item: PendingTrayItem<EnvironmentThreadShell> | null;
}

const RETURN_TIME = new Intl.DateTimeFormat("es", {
  weekday: "long",
  hour: "2-digit",
  minute: "2-digit",
});

function DecisionCard(props: {
  item: PendingTrayItem<EnvironmentThreadShell>;
  onOpenBackLayer: (threadKey: string) => void;
  /** The one-at-a-time tray: only the first request, and its «Luego». */
  later?: ReactNode;
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
      {props.later === undefined ? (
        <RequestCards threadRef={threadRef} subscribe={hasRequest} inCard />
      ) : (
        <FirstRequest threadRef={threadRef} subscribe={hasRequest} />
      )}
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
        {props.later}
      </div>
    </section>
  );
}

/** «Solo tú decides»: one decision at a time, answered with Y, N or S while focus is here. */
const NO_REQUESTS = Atom.make<PendingThreadRequests | null>(null);

function OneAtATime(props: {
  waiting: ReadonlyArray<TrayEntry>;
  onLater: (key: string, ids: ReadonlyArray<string>) => void;
  onOpenBackLayer: (threadKey: string) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const current = props.waiting[0];
  const thread = current?.item?.thread;
  const requests = useAtomValue(
    thread !== undefined && (thread.hasPendingApprovals || thread.hasPendingUserInput)
      ? environmentThreadDetails.pendingRequestsAtom(
          scopeThreadRef(thread.environmentId, thread.id),
        )
      : NO_REQUESTS,
  );
  // «Luego» waits until it knows what it sets aside: a handoff is itself, a thread its requests.
  const ids =
    current === undefined
      ? null
      : thread === undefined
        ? [current.key]
        : waitingIds(thread, requests);
  // Y, N and S need focus here; take it on open only when nothing else holds it.
  useEffect(() => {
    const active = document.activeElement;
    if (
      active === null ||
      active === document.body ||
      active.closest('[aria-controls="ade-decisions"]')
    ) {
      ref.current?.focus({ preventScroll: true });
    }
  }, []);
  const later = () => {
    if (current === undefined || ids === null) return;
    ref.current?.focus();
    props.onLater(current.key, ids);
  };
  useShortcut("s", later, {
    when: () => ids !== null && trayHasFocus(),
    description: "Luego",
  });
  const laterButton = (
    <button type="button" className="ade-button-quiet" disabled={ids === null} onClick={later}>
      Luego <kbd>S</kbd>
    </button>
  );
  return (
    <section ref={ref} className="ade-tray" tabIndex={-1} aria-label="Solo tú decides">
      <p className="ade-tray-count">
        Solo tú decides
        <span>{current === undefined ? "nada ahora" : `1/${props.waiting.length}`}</span>
      </p>
      {current === undefined ? (
        <p className="ade-request-note">No queda nada por decidir ahora.</p>
      ) : current.item === null ? (
        <HandoffNotices
          include={(key) => key === current.key}
          onOpenBackLayer={props.onOpenBackLayer}
          later={laterButton}
        />
      ) : (
        <DecisionCard
          key={current.key}
          item={current.item}
          onOpenBackLayer={props.onOpenBackLayer}
          later={laterButton}
        />
      )}
    </section>
  );
}

/** What «Luego» set aside, each with its way back. */
function SnoozedList(props: {
  entries: ReadonlyArray<TrayEntry>;
  snoozed: Snoozes;
  onBringBack: (key: string) => void;
}) {
  return (
    <ul className="ade-snoozed-list" aria-label="Pospuestas">
      {props.entries.map((entry) => (
        <li key={entry.key} className="ade-snoozed">
          <span className="ade-chip" data-kind={entry.kind}>
            {entry.label}
          </span>
          <span className="ade-snoozed-title">{entry.title}</span>
          <span className="ade-request-note">
            Vuelve el {RETURN_TIME.format(props.snoozed[entry.key]?.until ?? 0)}
          </span>
          <button
            type="button"
            className="ade-button-quiet"
            onClick={() => props.onBringBack(entry.key)}
          >
            Traer ahora
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Unified non-blocking pending tray across all operable machines.
 * Closes itself with none left while keeping its notification watcher active.
 */
export function DecisionsPanel() {
  const registry = useContext(RegistryContext);
  const { threads, snoozedKeys, waitingKeys, count, open, setOpen } = useDecisionsPanel();
  const snoozes = useAtomValue(snoozesAtom);
  const clock = useAtomValue(snoozeClockAtom);
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const selectThread = useAtomSet(selectedThreadKeyAtom);
  const alertsEnabled = useAtomValue(pendingAlertsEnabledAtom);
  const alertsPermission = useAtomValue(pendingAlertsPermissionAtom);
  const alertsNote = useAtomValue(pendingAlertsErrorAtom);
  const [kindFilter, setKindFilter] = useState<PendingTrayFilterKind>("all");
  const [machineFilter, setMachineFilter] = useState<EnvironmentId | "all">("all");
  const [mode, setMode] = useState<TrayMode>("una");
  const handoffs = useCutHandoffs();

  // One timer to the nearest return, and a re-check when the tab shows again after sleeping.
  useEffect(() => {
    const tick = () => tickSnoozeClock(registry);
    const due = nextSnoozeReturn(snoozes, clock);
    if (due === null) return;
    // @effect-diagnostics-next-line globalTimers:off -- a React effect, outside any Effect program.
    const timer = setTimeout(tick, due - clock);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [clock, registry, snoozes]);

  const items = useMemo(
    () =>
      buildPendingTrayItems(
        threads,
        (environmentId) => catalog.entries.get(environmentId)?.target.label ?? environmentId,
      ),
    [catalog.entries, threads],
  );
  const waitingItems = useMemo(
    () => items.filter((item) => !snoozedKeys.includes(item.key)),
    [items, snoozedKeys],
  );

  const openBackLayer = (threadKey: string) => {
    selectThread(threadKey);
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 720px)").matches) {
      setOpen(false);
    }
  };

  // A snoozed decision that comes back, on time or with a new request, alerts as new.
  usePendingTrayNotifications(waitingItems, openBackLayer);

  if (!open) return null;

  const queue: ReadonlyArray<TrayEntry> = [
    ...handoffs.map((notice) => ({
      key: notice.key,
      kind: "approval" as const,
      label: "Aviso",
      title: notice.title,
      item: null,
    })),
    ...items.map((item) => ({
      key: item.key,
      kind: item.primaryKind,
      label: KIND_LABELS[item.primaryKind],
      title: item.thread.title,
      item,
    })),
  ];
  const waiting = queue.filter((entry) => !snoozedKeys.includes(entry.key));
  const setAside = queue.filter((entry) => snoozedKeys.includes(entry.key));
  const effectiveMode = mode === "pospuestas" && setAside.length === 0 ? "una" : mode;

  const counts = countPendingByKind(waitingItems);
  const machinesInTray = [
    ...new Map(waitingItems.map((item) => [item.environmentId, item.machineLabel])),
  ];
  const effectiveMachine =
    machineFilter !== "all" && machinesInTray.some(([id]) => id === machineFilter)
      ? machineFilter
      : "all";
  const effectiveKind = kindFilter !== "all" && counts[kindFilter] === 0 ? "all" : kindFilter;
  const visible = filterPendingItems(waitingItems, {
    kind: effectiveKind,
    environmentId: effectiveMachine,
  });

  const handleToggleAlerts = async () => {
    await togglePendingAlerts(registry);
  };

  return (
    <FloatingPanel
      id="ade-decisions"
      label="Decisiones"
      icon={<BellSimpleRingingIcon size={16} aria-hidden />}
      onClose={() => setOpen(false)}
      actions={
        <>
          <span className="ade-panel-count">
            {count === 1 ? "1 pendiente" : `${count} pendientes`}
          </span>
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
        </>
      }
    >
      {alertsNote === null ? null : (
        <p className="ade-request-note" role="status">
          {alertsNote}
        </p>
      )}
      <div className="ade-filter-chips" role="group" aria-label="Cómo ver los pendientes">
        {(["una", "lista", "pospuestas"] as const)
          .filter((option) => option !== "pospuestas" || setAside.length > 0)
          .map((option) => (
            <button
              key={option}
              type="button"
              className="ade-filter-chip"
              aria-pressed={effectiveMode === option}
              onClick={() => setMode(option)}
            >
              {MODE_LABELS[option]}
              {option === "pospuestas" ? <span> {setAside.length}</span> : null}
            </button>
          ))}
      </div>
      {effectiveMode === "una" ? (
        <OneAtATime
          waiting={waiting}
          onLater={(key, ids) => {
            setMode("una");
            // Snoozing the last one must not close the panel under the user's hands.
            if (waitingKeys.length === 1) setOpen(true);
            snoozeDecision(registry, key, ids, [...waitingKeys, ...snoozedKeys]);
          }}
          onOpenBackLayer={openBackLayer}
        />
      ) : null}
      {effectiveMode === "pospuestas" ? (
        <SnoozedList
          entries={setAside}
          snoozed={snoozes}
          onBringBack={(key) => bringBackDecision(registry, key)}
        />
      ) : null}
      {effectiveMode !== "lista" ? null : waitingItems.length > 1 ||
        effectiveKind !== "all" ||
        effectiveMachine !== "all" ? (
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
      {effectiveMode !== "lista" ? null : (
        <>
          <HandoffNotices
            include={(key) => !snoozedKeys.includes(key)}
            onOpenBackLayer={openBackLayer}
          />
          {visible.length === 0 &&
          handoffs.every((handoff) => snoozedKeys.includes(handoff.key)) ? (
            <p className="ade-request-note">Ningún pendiente coincide con el filtro actual.</p>
          ) : (
            visible.map((item) => (
              <DecisionCard key={item.key} item={item} onOpenBackLayer={openBackLayer} />
            ))
          )}
        </>
      )}
    </FloatingPanel>
  );
}
