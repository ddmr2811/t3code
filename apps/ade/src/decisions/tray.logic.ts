import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId } from "@t3tools/contracts";

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
 * Returns only items whose thread key was not present in `previousKeys`.
 * When `previousKeys` is `null` (initial hydration), returns empty so existing items do not spam.
 */
export function detectNewlyPending<T extends PendingThreadInput>(
  previousKeys: ReadonlySet<string> | null,
  currentItems: ReadonlyArray<PendingTrayItem<T>>,
): ReadonlyArray<PendingTrayItem<T>> {
  if (previousKeys === null) return [];
  return currentItems.filter((item) => !previousKeys.has(item.key));
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
