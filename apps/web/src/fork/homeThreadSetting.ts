// Fork-only: the home thread, a client setting the app opens on start with the Dashboard beside it.
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { persistClientSettingsUpdate, useClientSettings } from "../hooks/useSettings";
import { isHomeThread } from "./homeThread.logic";

export function useIsHomeThread(ref: ScopedThreadRef | null): boolean {
  return useClientSettings(
    (settings) => ref !== null && isHomeThread(settings.forkHomeThread, ref),
  );
}

export async function setHomeThread(ref: ScopedThreadRef, home: boolean): Promise<void> {
  const key = scopedThreadKey(ref);
  try {
    await persistClientSettingsUpdate((current) => ({
      ...current,
      // Unsetting only clears this thread, never one another device chose meanwhile.
      forkHomeThread: home ? key : current.forkHomeThread === key ? null : current.forkHomeThread,
    }));
  } catch (error) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: home ? "Could not set the home thread" : "Could not unset the home thread",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  }
}
