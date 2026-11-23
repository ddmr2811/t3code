import { useAtomValue } from "@effect/atom-react";
import { Atom, type AtomRegistry } from "effect/reactivity";
import { useEffect, useRef } from "react";

import {
  buildPendingNotificationEvent,
  detectNewlyPending,
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
    return readPermission();
  }
  const permission = readPermission();
  registry.set(pendingAlertsPermissionAtom, permission);
  if (permission === "unsupported" || permission === "denied") {
    registry.set(pendingAlertsEnabledAtom, false);
    return permission;
  }
  const granted =
    permission === "granted" ? "granted" : await window.Notification.requestPermission();
  registry.set(pendingAlertsPermissionAtom, granted);
  registry.set(pendingAlertsEnabledAtom, granted === "granted");
  return granted;
}

/**
 * Watches pending tray items and notifies listeners (and browser Notification when explicitly
 * opted in) whenever a new pending thread enters the tray after initial load.
 */
export function usePendingTrayNotifications(
  items: ReadonlyArray<PendingTrayItem>,
  onFocusThread?: (threadKey: string) => void,
) {
  const alertsEnabled = useAtomValue(pendingAlertsEnabledAtom);
  const seenKeysRef = useRef<ReadonlySet<string> | null>(null);
  const onFocusRef = useRef(onFocusThread);

  useEffect(() => {
    onFocusRef.current = onFocusThread;
  }, [onFocusThread]);

  useEffect(() => {
    const newlyPending = detectNewlyPending(seenKeysRef.current, items);
    seenKeysRef.current = new Set(items.map((item) => item.key));
    const event = buildPendingNotificationEvent(newlyPending);
    if (event === null) return;

    for (const listener of listeners) {
      listener(event);
    }

    if (
      alertsEnabled &&
      typeof window !== "undefined" &&
      typeof window.Notification !== "undefined" &&
      window.Notification.permission === "granted"
    ) {
      const notification = new window.Notification(event.title, {
        body: event.body,
        tag: "ade-pending-tray",
      });
      const targetKey = event.threadKeys[0];
      if (targetKey !== undefined) {
        notification.onclick = () => {
          window.focus();
          onFocusRef.current?.(targetKey);
          notification.close();
        };
      }
    }
  }, [alertsEnabled, items]);
}
