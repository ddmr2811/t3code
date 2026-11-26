import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom, type AtomRegistry } from "effect/reactivity";
import { useContext, useEffect, useRef } from "react";

import { environmentShell } from "../connection/runtime.ts";
import { operableEnvironmentIdsAtom } from "../state.ts";
import { workflowQuestionKey, workflowQuestionsAtom } from "./workflowQuestions.ts";
import { readWorkflowQuestion } from "@t3tools/client-runtime/workflows";
import {
  advancePendingNotificationState,
  buildPendingNotificationEvent,
  type PendingSeenByEnvironment,
  type PendingTrayItem,
  type PendingTrayNotificationEvent,
} from "./tray.logic.ts";

export type PendingAlertsPermission = "unsupported" | "default" | "granted" | "denied";
export type PendingTrayEventListener = (event: PendingTrayNotificationEvent) => void;

const listeners = new Set<PendingTrayEventListener>();

const readPermission = (): PendingAlertsPermission => {
  if (typeof window === "undefined" || typeof window.Notification === "undefined") {
    return "unsupported";
  }
  return window.Notification.permission;
};

// Kept strictly in memory (never localStorage) and disabled until the user explicitly enables it.
export const pendingAlertsEnabledAtom = Atom.make(false).pipe(
  Atom.keepAlive,
  Atom.withLabel("ade-pending-alerts-enabled"),
);

export const pendingAlertsPermissionAtom = Atom.make<PendingAlertsPermission>(
  readPermission(),
).pipe(Atom.keepAlive, Atom.withLabel("ade-pending-alerts-permission"));

export const pendingAlertsErrorAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("ade-pending-alerts-error"),
);

let previousHydrated: ReadonlySet<EnvironmentId> = new Set();
const hydratedEnvironmentIdsAtom = Atom.make((get) => {
  const next = new Set<EnvironmentId>();
  // Only count environments that are BOTH operable and have received their initial shell snapshot,
  // matching `needsYouThreadsAtom` so startup or transient session failures never fire false alerts.
  for (const environmentId of get(operableEnvironmentIdsAtom)) {
    const shell = get(environmentShell.stateValueAtom(environmentId));
    if (Option.isSome(shell.snapshot)) {
      next.add(environmentId);
    }
  }
  if (next.size === previousHydrated.size && [...next].every((id) => previousHydrated.has(id))) {
    return previousHydrated;
  }
  previousHydrated = next;
  return next;
}).pipe(Atom.withLabel("ade-hydrated-environments"));

/** Hook point for future mobile/web push bridges to observe newly arrived pending tray items. */
export function subscribePendingTrayEvents(listener: PendingTrayEventListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function togglePendingAlerts(
  registry: AtomRegistry.AtomRegistry,
): Promise<PendingAlertsPermission> {
  const currentEnabled = registry.get(pendingAlertsEnabledAtom);
  if (currentEnabled) {
    registry.set(pendingAlertsEnabledAtom, false);
    registry.set(pendingAlertsErrorAtom, null);
    return readPermission();
  }
  const permission = readPermission();
  registry.set(pendingAlertsPermissionAtom, permission);
  if (permission === "unsupported") {
    registry.set(pendingAlertsEnabledAtom, false);
    registry.set(pendingAlertsErrorAtom, "Este navegador no admite notificaciones locales.");
    return permission;
  }
  if (permission === "denied") {
    registry.set(pendingAlertsEnabledAtom, false);
    registry.set(pendingAlertsErrorAtom, "Notificaciones bloqueadas por el navegador.");
    return permission;
  }
  try {
    const granted =
      permission === "granted" ? "granted" : await window.Notification.requestPermission();
    registry.set(pendingAlertsPermissionAtom, granted);
    registry.set(pendingAlertsEnabledAtom, granted === "granted");
    registry.set(
      pendingAlertsErrorAtom,
      granted === "denied" ? "Notificaciones bloqueadas por el navegador." : null,
    );
    return granted;
  } catch {
    registry.set(pendingAlertsEnabledAtom, false);
    registry.set(
      pendingAlertsErrorAtom,
      "No se pudo solicitar permiso de notificaciones en este navegador.",
    );
    return "unsupported";
  }
}

/**
 * Watches pending tray items per hydrated machine and notifies listeners (and browser Notification
 * when explicitly opted in) whenever a new pending thread enters the tray after initial snapshot.
 */
export function usePendingTrayNotifications(
  items: ReadonlyArray<PendingTrayItem>,
  onFocusThread?: (threadKey: string) => void,
) {
  const registry = useContext(RegistryContext);
  const alertsEnabled = useAtomValue(pendingAlertsEnabledAtom);
  const hydratedEnvironmentIds = useAtomValue(hydratedEnvironmentIdsAtom);
  const seenByEnvRef = useRef<PendingSeenByEnvironment>(new Map());
  const onFocusRef = useRef(onFocusThread);

  useEffect(() => {
    onFocusRef.current = onFocusThread;
  }, [onFocusThread]);

  useEffect(() => {
    const { nextSeenByEnv, newlyPending } = advancePendingNotificationState(seenByEnvRef.current, {
      items,
      hydratedEnvironmentIds,
    });
    seenByEnvRef.current = nextSeenByEnv;
    const event = buildPendingNotificationEvent(newlyPending);
    if (event === null) return;
    sendAlert(registry, alertsEnabled, event, () => {
      const targetKey = event.threadKeys[0];
      if (targetKey !== undefined) onFocusRef.current?.(targetKey);
    });
  }, [alertsEnabled, hydratedEnvironmentIds, items, registry]);
}

/** Tells the listeners, and the browser when the user opted in. */
function sendAlert(
  registry: AtomRegistry.AtomRegistry,
  alertsEnabled: boolean,
  event: PendingTrayNotificationEvent,
  onClick: () => void,
) {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // One failing subscriber must not break the tray or other listeners.
    }
  }

  if (
    alertsEnabled &&
    typeof window !== "undefined" &&
    typeof window.Notification !== "undefined" &&
    window.Notification.permission === "granted"
  ) {
    try {
      const notification = new window.Notification(event.title, {
        body: event.body,
        tag: "ade-pending-tray",
      });
      notification.onclick = () => {
        window.focus();
        onClick();
        notification.close();
      };
    } catch {
      // Mobile browsers such as Android Chrome reject direct `new Notification()` without a SW.
      registry.set(pendingAlertsEnabledAtom, false);
      registry.set(
        pendingAlertsErrorAtom,
        "Este navegador no permite notificaciones directas desde la pestaña.",
      );
    }
  }
}

/**
 * A workflow run that pauses for a person alerts like a thread that waits, once its machine's
 * list has arrived. `onOpen` brings up the tray, where the question is answered.
 */
export function useWorkflowQuestionNotifications(onOpen: () => void) {
  const registry = useContext(RegistryContext);
  const alertsEnabled = useAtomValue(pendingAlertsEnabledAtom);
  const { questions, loaded } = useAtomValue(workflowQuestionsAtom);
  const seenByEnvRef = useRef<PendingSeenByEnvironment>(new Map());
  const onOpenRef = useRef(onOpen);

  useEffect(() => {
    onOpenRef.current = onOpen;
  }, [onOpen]);

  useEffect(() => {
    const { nextSeenByEnv, newlyPending } = advancePendingNotificationState(seenByEnvRef.current, {
      items: questions.map((open) => ({ ...open, key: workflowQuestionKey(open) })),
      hydratedEnvironmentIds: loaded,
    });
    seenByEnvRef.current = nextSeenByEnv;
    const first = newlyPending[0];
    if (first === undefined) return;
    const event: PendingTrayNotificationEvent = {
      id: newlyPending.map((item) => item.key).join("|"),
      count: newlyPending.length,
      title:
        newlyPending.length === 1
          ? "Un flujo espera tu respuesta"
          : `${newlyPending.length} flujos esperan tu respuesta`,
      body: readWorkflowQuestion(first.question).title,
      threadKeys: [],
    };
    sendAlert(registry, alertsEnabled, event, () => onOpenRef.current());
  }, [alertsEnabled, loaded, questions, registry]);
}
