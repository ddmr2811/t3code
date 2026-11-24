import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  type DecisionsPanelChoice,
  isDecisionsPanelOpen,
} from "../../../web/src/fork/decisions/decisions.logic.ts";

export type PendingTrayKind = "approval" | "question" | "plan" | "guest";
export type PendingTrayFilterKind = "all" | PendingTrayKind;

export type PendingThreadInput = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "projectId"
  | "title"
  | "branch"
  | "worktreePath"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingGuestMessageCount"
  | "hasActionableProposedPlan"
  | "interactionMode"
  | "updatedAt"
>;

export interface PendingTrayItem<T extends PendingThreadInput = PendingThreadInput> {
  readonly key: string;
  readonly thread: T;
  readonly environmentId: EnvironmentId;
  readonly machineLabel: string;
  readonly kinds: ReadonlyArray<PendingTrayKind>;
  readonly primaryKind: PendingTrayKind;
}

export interface PendingTrayNotificationEvent {
  readonly id: string;
  readonly count: number;
  readonly title: string;
  readonly body: string;
  readonly threadKeys: ReadonlyArray<string>;
}

export type PendingSeenByEnvironment = ReadonlyMap<EnvironmentId, ReadonlySet<string>>;

export function classifyPendingKinds(thread: PendingThreadInput): ReadonlyArray<PendingTrayKind> {
  const kinds: PendingTrayKind[] = [];
  if (thread.hasPendingApprovals) kinds.push("approval");
  if (thread.hasPendingUserInput) kinds.push("question");
  if ((thread.pendingGuestMessageCount ?? 0) > 0) kinds.push("guest");
  if (thread.interactionMode === "plan" && thread.hasActionableProposedPlan) kinds.push("plan");
  return kinds.length > 0 ? kinds : ["plan"];
}

export function buildPendingTrayItems<T extends PendingThreadInput>(
  threads: ReadonlyArray<T>,
  machineLabelOf: (environmentId: EnvironmentId) => string,
): ReadonlyArray<PendingTrayItem<T>> {
  return threads.map((thread) => {
    const kinds = classifyPendingKinds(thread);
    return {
      key: scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      thread,
      environmentId: thread.environmentId,
      machineLabel: machineLabelOf(thread.environmentId),
      kinds,
      primaryKind: kinds[0]!,
    };
  });
}

export function countPendingByKind(
  items: ReadonlyArray<Pick<PendingTrayItem, "kinds">>,
): Record<PendingTrayFilterKind, number> {
  const counts: Record<PendingTrayFilterKind, number> = {
    all: items.length,
    approval: 0,
    question: 0,
    plan: 0,
    guest: 0,
  };
  for (const item of items) {
    for (const kind of item.kinds) counts[kind] += 1;
  }
  return counts;
}

export function filterPendingItems<T extends PendingThreadInput>(
  items: ReadonlyArray<PendingTrayItem<T>>,
  filter: {
    readonly kind: PendingTrayFilterKind;
    readonly environmentId: EnvironmentId | "all";
  },
): ReadonlyArray<PendingTrayItem<T>> {
  return items.filter((item) => {
    if (filter.environmentId !== "all" && item.environmentId !== filter.environmentId) {
      return false;
    }
    if (filter.kind !== "all" && !item.kinds.includes(filter.kind)) {
      return false;
    }
    return true;
  });
}

/**
 * Tracks initial hydration independently per enabled machine: a machine's first snapshot seeds its
 * baseline without emitting notifications, and only keys arriving after that snapshot trigger alerts.
 */
export function advancePendingNotificationState<T extends PendingThreadInput>(
  seenByEnv: PendingSeenByEnvironment,
  input: {
    readonly items: ReadonlyArray<PendingTrayItem<T>>;
    readonly hydratedEnvironmentIds: ReadonlySet<EnvironmentId>;
  },
): {
  readonly nextSeenByEnv: PendingSeenByEnvironment;
  readonly newlyPending: ReadonlyArray<PendingTrayItem<T>>;
} {
  const itemsByEnv = new Map<EnvironmentId, PendingTrayItem<T>[]>();
  for (const item of input.items) {
    const list = itemsByEnv.get(item.environmentId);
    if (list === undefined) itemsByEnv.set(item.environmentId, [item]);
    else list.push(item);
  }

  const nextSeenByEnv = new Map<EnvironmentId, ReadonlySet<string>>();
  const newlyPending: PendingTrayItem<T>[] = [];

  for (const environmentId of input.hydratedEnvironmentIds) {
    const currentItems = itemsByEnv.get(environmentId) ?? [];
    const currentKeys = new Set(currentItems.map((item) => item.key));
    const previousKeys = seenByEnv.get(environmentId);
    if (previousKeys !== undefined) {
      for (const item of currentItems) {
        if (!previousKeys.has(item.key)) {
          newlyPending.push(item);
        }
      }
    }
    nextSeenByEnv.set(environmentId, currentKeys);
  }

  return { nextSeenByEnv, newlyPending };
}

/**
 * Desktop auto-opens the non-blocking side rail on new pending items; narrow mobile viewports stay
 * non-blocking and only open the full-screen tray when the user explicitly opens it.
 */
export function isTrayOpenForViewport(
  choice: DecisionsPanelChoice | null,
  waitingKeys: ReadonlyArray<string>,
  narrowViewport: boolean,
): boolean {
  if (waitingKeys.length === 0) return false;
  if (narrowViewport) return choice?.open === true;
  return isDecisionsPanelOpen(choice, waitingKeys);
}

/**
 * Clears stale `open: true` state once the pending tray empties on narrow viewports so a later
 * pending item cannot unexpectedly pop open the full-screen mobile overlay.
 */
export function reconcileTrayChoice(
  choice: DecisionsPanelChoice | null,
  waitingKeys: ReadonlyArray<string>,
  narrowViewport: boolean,
): DecisionsPanelChoice | null {
  if (narrowViewport && waitingKeys.length === 0 && choice?.open === true) {
    return null;
  }
  return choice;
}

const KIND_SINGULAR: Record<PendingTrayKind, string> = {
  approval: "Aprobación pendiente",
  question: "Pregunta pendiente",
  plan: "Plan listo para revisar",
  guest: "Mensaje de invitado",
};

export function buildPendingNotificationEvent(
  newlyPending: ReadonlyArray<PendingTrayItem>,
): PendingTrayNotificationEvent | null {
  if (newlyPending.length === 0) return null;
  const first = newlyPending[0]!;
  const title =
    newlyPending.length === 1
      ? `${KIND_SINGULAR[first.primaryKind]} · ${first.machineLabel}`
      : `${newlyPending.length} nuevos pendientes en ADE`;
  const body =
    newlyPending.length === 1
      ? first.thread.title
      : newlyPending
          .slice(0, 3)
          .map((item) => `${item.machineLabel}: ${item.thread.title}`)
          .join(" · ");
  const threadKeys = newlyPending.map((item) => item.key);
  return {
    id: threadKeys.join("|"),
    count: newlyPending.length,
    title,
    body,
    threadKeys,
  };
}

/** «Luego»: each decision key with the time it comes back, in ms. Nothing is dropped from the server. */
export type SnoozedUntil = Readonly<Record<string, number>>;

const SNOOZED_STORAGE_KEY = "ade.decisions.snoozed";

/** Tomorrow at 08:00 local time, whatever the hour it is snoozed at. */
export function snoozeUntilTomorrow(now: DateTime.DateTime): number {
  const local = DateTime.makeZonedUnsafe(now, { timeZone: DateTime.zoneMakeLocal() });
  const tomorrow = DateTime.add(local, { days: 1 });
  return DateTime.toEpochMillis(
    DateTime.setParts(tomorrow, { hour: 8, minute: 0, second: 0, millisecond: 0 }),
  );
}

export function isSnoozed(snoozed: SnoozedUntil, key: string, now: number): boolean {
  return (snoozed[key] ?? 0) > now;
}

/** What this browser has snoozed and has not come back yet; a damaged entry is ignored. */
export function readSnoozed(now: number, storage?: Pick<Storage, "getItem">): SnoozedUntil {
  try {
    const store = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
    const parsed: unknown = JSON.parse(store?.getItem(SNOOZED_STORAGE_KEY) ?? "{}");
    if (typeof parsed !== "object" || parsed === null) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > now,
      ),
    );
  } catch {
    return {};
  }
}

export function writeSnoozed(snoozed: SnoozedUntil, storage?: Pick<Storage, "setItem">): void {
  try {
    const store = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
    store?.setItem(SNOOZED_STORAGE_KEY, JSON.stringify(snoozed));
  } catch {
    // Private browsing may refuse storage; the snooze then lasts until the page reloads.
  }
}
