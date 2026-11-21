import type { ScopedThreadRef } from "@t3tools/contracts";
import { msg } from "gt-react";

import {
  isThreadNotificationsMuted,
  withThreadNotificationsMuted,
} from "./components/ThreadNotificationCoordinator.logic";
import { stackedThreadToast, toastManager } from "./components/ui/toast";
import { persistClientSettingsUpdate, useClientSettings } from "./hooks/useSettings";
import { m } from "./i18n/messages";

export function useThreadNotificationsMuted(ref: ScopedThreadRef | null): boolean {
  return useClientSettings(
    (settings) =>
      ref !== null && isThreadNotificationsMuted(settings.mutedThreadNotifications, ref),
  );
}

export async function setThreadNotificationsMuted(
  ref: ScopedThreadRef,
  muted: boolean,
): Promise<void> {
  try {
    await persistClientSettingsUpdate((current) => ({
      ...current,
      mutedThreadNotifications: withThreadNotificationsMuted(
        current.mutedThreadNotifications,
        ref,
        muted,
      ),
    }));
  } catch (error) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: m(
          muted ? msg("Could not mute notifications") : msg("Could not unmute notifications"),
        ),
        description: error instanceof Error ? error.message : m(msg("An error occurred.")),
      }),
    );
  }
}
