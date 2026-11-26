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
export function advancePendingNotificationState<
  I extends { readonly key: string; readonly environmentId: EnvironmentId },
>(
  seenByEnv: PendingSeenByEnvironment,
  input: {
    readonly items: ReadonlyArray<I>;
    readonly hydratedEnvironmentIds: ReadonlySet<EnvironmentId>;
  },
): {
  readonly nextSeenByEnv: PendingSeenByEnvironment;
  readonly newlyPending: ReadonlyArray<I>;
} {
  const itemsByEnv = new Map<EnvironmentId, I[]>();
  for (const item of input.items) {
    const list = itemsByEnv.get(item.environmentId);
    if (list === undefined) itemsByEnv.set(item.environmentId, [item]);
    else list.push(item);
  }

  const nextSeenByEnv = new Map<EnvironmentId, ReadonlySet<string>>();
  const newlyPending: I[] = [];

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

/** «Luego»: when a decision comes back, and the requests it had then. Nothing leaves the server. */
export interface Snooze {
  readonly until: number;
  readonly requestIds: ReadonlyArray<string>;
}
export type Snoozes = Readonly<Record<string, Snooze>>;

const SNOOZES_STORAGE_KEY = "ade.decisions.snoozed";
// Tomorrow at 08:00 is at most ~32 h away; anything further was not written by this code.
const MAX_SNOOZE_MS = 3 * 24 * 60 * 60 * 1000;

/** Tomorrow at 08:00 local time, whatever the hour it is snoozed at. */
export function snoozeUntilTomorrow(now: DateTime.DateTime): number {
  const local = DateTime.makeZonedUnsafe(now, { timeZone: DateTime.zoneMakeLocal() });
  const tomorrow = DateTime.add(local, { days: 1 });
  return DateTime.toEpochMillis(
    DateTime.setParts(tomorrow, { hour: 8, minute: 0, second: 0, millisecond: 0 }),
  );
}

/**
 * Hidden until its time, and only while the thread still waits on just what it waited on when
 * snoozed: something new, or nothing of that left, ends it. `pendingIds` is null while loading.
 */
export function isSnoozed(
  snooze: Snooze | undefined,
  pendingIds: ReadonlyArray<string> | null,
  now: number,
): boolean {
  // While its requests load nothing is hidden: a new one must never wait on a slow read.
  if (snooze === undefined || snooze.until <= now || snooze.requestIds.length === 0) return false;
  if (pendingIds === null) return false;
  return pendingIds.length > 0 && pendingIds.every((id) => snooze.requestIds.includes(id));
}

/**
 * What a waiting thread waits on: its request ids, plus a marker for guest messages and plans,
 * which carry no id, so a new one ends a «Luego». Null while its requests load.
 */
export function waitingIds(
  thread: Pick<
    PendingThreadInput,
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "pendingGuestMessageCount"
    | "hasActionableProposedPlan"
    | "updatedAt"
  >,
  requests: {
    readonly approvals: ReadonlyArray<{ readonly requestId: string }>;
    readonly userInputs: ReadonlyArray<{ readonly requestId: string }>;
  } | null,
): ReadonlyArray<string> | null {
  const others = [
    ...((thread.pendingGuestMessageCount ?? 0) > 0
      ? [`invitados:${thread.pendingGuestMessageCount}`]
      : []),
    ...(thread.hasActionableProposedPlan ? [`plan@${thread.updatedAt}`] : []),
  ];
  if (!thread.hasPendingApprovals && !thread.hasPendingUserInput)
    return others.length > 0 ? others : [`sin-peticion@${thread.updatedAt}`];
  if (requests === null) return null;
  return [
    ...[...requests.approvals, ...requests.userInputs].map((request) => request.requestId),
    ...others,
  ];
}

/** Drops what is due and what no longer waits, so a later wait on the same thread starts fresh. */
export function pruneSnoozes(
  snoozes: Snoozes,
  waitingKeys: ReadonlyArray<string>,
  now: number,
): Snoozes {
  return Object.fromEntries(
    Object.entries(snoozes).filter(
      ([key, snooze]) => snooze.until > now && waitingKeys.includes(key),
    ),
  );
}

/** The nearest return time still ahead, for the one timer that brings it back. */
export function nextSnoozeReturn(snoozes: Snoozes, now: number): number | null {
  const ahead = Object.values(snoozes)
    .map((snooze) => snooze.until)
    .filter((until) => until > now);
  return ahead.length === 0 ? null : Math.min(...ahead);
}

const isSnooze = (value: unknown, now: number): value is Snooze => {
  if (typeof value !== "object" || value === null) return false;
  const { until, requestIds } = value as Record<string, unknown>;
  return (
    typeof until === "number" &&
    Number.isFinite(until) &&
    until > now &&
    until <= now + MAX_SNOOZE_MS &&
    Array.isArray(requestIds) &&
    requestIds.every((id) => typeof id === "string")
  );
};

/** What this browser has snoozed and is not due yet; a damaged entry is ignored. */
export function readSnoozes(now: number, storage?: Pick<Storage, "getItem">): Snoozes {
  try {
    const store = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
    const parsed: unknown = JSON.parse(store?.getItem(SNOOZES_STORAGE_KEY) ?? "{}");
    if (typeof parsed !== "object" || parsed === null) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, Snooze] => isSnooze(entry[1], now)),
    );
  } catch {
    return {};
  }
}

export function writeSnoozes(snoozes: Snoozes, storage?: Pick<Storage, "setItem">): void {
  try {
    const store = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
    store?.setItem(SNOOZES_STORAGE_KEY, JSON.stringify(snoozes));
  } catch {
    // Private browsing may refuse storage; the snooze then lasts until the page reloads.
  }
}
