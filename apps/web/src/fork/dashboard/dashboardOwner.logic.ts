// Fork-only: which environment keeps the Dashboard. A client setting names it (null: the primary);
// the layout is read from and written to that environment alone, never to another one by itself.
import type { EnvironmentId, ForkDashboardLayout } from "@t3tools/contracts";

import { isDefaultLayout } from "./dashboardLayout.logic";

/** Servers that check the revision and keep `charts`. */
const DASHBOARD_OWNER_PROTOCOL = 3;

export interface OwnerCandidate {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connected: boolean;
  /** Its `forkDashboard` capability; 0 when it has none. */
  readonly protocol: number;
  readonly canWrite: boolean;
  /** Its saved layout, while its settings are known. */
  readonly layout: ForkDashboardLayout | null;
}

export type DashboardSource =
  | { readonly kind: "primary"; readonly layout: ForkDashboardLayout }
  | {
      readonly kind: "chosen";
      readonly environmentId: EnvironmentId;
      readonly label: string;
      readonly layout: ForkDashboardLayout;
    }
  | {
      /** Read only: the chosen environment cannot answer, so nothing is written anywhere. */
      readonly kind: "unavailable";
      readonly environmentId: EnvironmentId;
      readonly label: string;
      readonly layout: ForkDashboardLayout;
      readonly notice: string;
    };

const UNKNOWN_LABEL = "The chosen server";

export function resolveDashboardSource(input: {
  readonly owner: EnvironmentId | null;
  readonly primaryId: EnvironmentId | null;
  readonly candidates: ReadonlyArray<OwnerCandidate>;
  /** The chosen environment's layout as last read on this device. */
  readonly lastRead: ForkDashboardLayout | null;
  readonly primaryLayout: ForkDashboardLayout;
}): DashboardSource {
  const { owner } = input;
  if (owner === null || owner === input.primaryId) {
    return { kind: "primary", layout: input.primaryLayout };
  }
  const candidate = input.candidates.find((entry) => entry.environmentId === owner);
  const label = candidate?.label ?? UNKNOWN_LABEL;
  const fallback = input.lastRead ?? input.primaryLayout;
  if (candidate === undefined || !candidate.connected) {
    return {
      kind: "unavailable",
      environmentId: owner,
      label,
      layout: fallback,
      notice: `${label} is offline: showing the last saved layout`,
    };
  }
  if (candidate.protocol < DASHBOARD_OWNER_PROTOCOL || candidate.layout === null) {
    return {
      kind: "unavailable",
      environmentId: owner,
      label,
      layout: fallback,
      notice: `Update the T3 Code server on ${label} to keep the Dashboard there: showing the last saved layout`,
    };
  }
  return { kind: "chosen", environmentId: owner, label, layout: candidate.layout };
}

/** The one environment a save from this source may go to. */
export function dashboardWriteTarget(
  source: DashboardSource,
  primaryId: EnvironmentId | null,
): EnvironmentId | null {
  switch (source.kind) {
    case "primary":
      return primaryId;
    case "chosen":
      return source.environmentId;
    case "unavailable":
      return null;
  }
}

/** The environment the layout on screen belongs to, whether or not it can be written now. */
export function dashboardOwnerId(
  source: DashboardSource,
  primaryId: EnvironmentId | null,
): EnvironmentId | null {
  return source.kind === "primary" ? primaryId : source.environmentId;
}

/** Whether the chosen owner's own layout cannot be used, so the copy cached on this device is. */
export function needsLastRead(input: {
  readonly owner: EnvironmentId | null;
  readonly primaryId: EnvironmentId | null;
  readonly candidates: ReadonlyArray<OwnerCandidate>;
}): boolean {
  if (input.owner === null || input.owner === input.primaryId) return false;
  const candidate = input.candidates.find((entry) => entry.environmentId === input.owner);
  return (
    candidate === undefined ||
    !candidate.connected ||
    candidate.protocol < DASHBOARD_OWNER_PROTOCOL ||
    candidate.layout === null
  );
}

const canKeepDashboard = (candidate: OwnerCandidate) =>
  candidate.connected &&
  candidate.canWrite &&
  candidate.protocol >= DASHBOARD_OWNER_PROTOCOL &&
  candidate.layout !== null;

export interface OwnerOption {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly primary: boolean;
  /** The current owner stays listed so the selector names it, even when it cannot be chosen. */
  readonly disabled: boolean;
}

/** The environments the Dashboard can move to, the primary first, plus the current owner. */
export function ownerOptions(input: {
  readonly candidates: ReadonlyArray<OwnerCandidate>;
  readonly primaryId: EnvironmentId | null;
  readonly current: EnvironmentId | null;
}): ReadonlyArray<OwnerOption> {
  const options = input.candidates
    .filter((candidate) => canKeepDashboard(candidate) || candidate.environmentId === input.current)
    .map((candidate) => ({
      environmentId: candidate.environmentId,
      label: candidate.label,
      primary: candidate.environmentId === input.primaryId,
      disabled: !canKeepDashboard(candidate),
    }));
  if (input.current !== null && !options.some((o) => o.environmentId === input.current)) {
    options.push({
      environmentId: input.current,
      label: UNKNOWN_LABEL,
      primary: input.current === input.primaryId,
      disabled: true,
    });
  }
  return options.toSorted((a, b) => Number(b.primary) - Number(a.primary));
}

/** Asked before a write replaces a layout someone arranged; null when it holds the defaults. */
const replaceConfirm = (label: string, layout: ForkDashboardLayout) =>
  isDefaultLayout(layout)
    ? null
    : `Replace the dashboard saved on ${label}?\nIts aliases, icons, colours, sections, order and hidden items are replaced by this layout on every client that uses it.`;

export type OwnerSwitchChoice = "copy" | "use";

export interface OwnerSwitch {
  /** The client setting to store: null for the primary. */
  readonly owner: EnvironmentId | null;
  /** The one write the switch makes, always to the target. */
  readonly write: {
    readonly environmentId: EnvironmentId;
    readonly layout: ForkDashboardLayout;
    readonly base: ForkDashboardLayout;
  } | null;
  /** Asked before the write, when it would replace a layout the target already has. */
  readonly confirm: string | null;
  /** What the Dashboard shows once switched. */
  readonly next: ForkDashboardLayout;
}

export function planOwnerSwitch(input: {
  readonly choice: OwnerSwitchChoice;
  readonly target: OwnerCandidate;
  readonly primaryId: EnvironmentId | null;
  /** The layout on screen, which "copy" takes there. */
  readonly layout: ForkDashboardLayout;
}): OwnerSwitch | null {
  const { target } = input;
  if (!canKeepDashboard(target) || target.layout === null) return null;
  const owner = target.environmentId === input.primaryId ? null : target.environmentId;
  if (input.choice === "use") {
    return { owner, write: null, confirm: null, next: target.layout };
  }
  return {
    owner,
    write: { environmentId: target.environmentId, layout: input.layout, base: target.layout },
    confirm: replaceConfirm(target.label, target.layout),
    next: { ...input.layout, revision: target.layout.revision + 1 },
  };
}

/** A layout being edited, tied to the owner it was opened from and the revision it starts at. */
export interface DashboardDraft {
  readonly layout: ForkDashboardLayout;
  readonly base: ForkDashboardLayout;
  readonly ownerId: EnvironmentId | null;
  readonly ownerLabel: string;
}

const draftHasChanges = (draft: DashboardDraft) =>
  draft.layout !== draft.base && JSON.stringify(draft.layout) !== JSON.stringify(draft.base);

export type DraftPlan =
  /** Same owner: save as the revision after the draft's base. */
  | { readonly kind: "save"; readonly base: ForkDashboardLayout }
  /** The owner moved and nothing was changed: leave edit mode. */
  | { readonly kind: "close" }
  /** The owner moved under unsaved edits: never save them there unasked. */
  | {
      readonly kind: "moved";
      readonly notice: string;
      readonly copyLabel: string;
      readonly copyConfirm: string | null;
      /** The base a copy is saved after: the new owner's own layout. */
      readonly copyBase: ForkDashboardLayout;
    };

export function planDraft(
  draft: DashboardDraft,
  current: {
    readonly ownerId: EnvironmentId | null;
    readonly label: string;
    readonly layout: ForkDashboardLayout;
  },
): DraftPlan {
  if (draft.ownerId === current.ownerId) return { kind: "save", base: draft.base };
  if (!draftHasChanges(draft)) return { kind: "close" };
  return {
    kind: "moved",
    notice: `The dashboard is now saved on ${current.label}; your edits were made for ${draft.ownerLabel}`,
    copyLabel: `Copy my edits to ${current.label}`,
    copyConfirm: replaceConfirm(current.label, current.layout),
    copyBase: current.layout,
  };
}

/** An owner switch in flight: its answer only counts while it is the latest and the owner held. */
export interface OwnerOperation {
  readonly id: number;
  readonly owner: EnvironmentId | null;
}

export const operationIsCurrent = (operation: OwnerOperation, now: OwnerOperation) =>
  operation.id === now.id && operation.owner === now.owner;

/**
 * Watches the owner while a switch is in flight. Any change seen, even one that comes back to the
 * starting owner (A, then B, then A from another tab), makes the switch stale.
 */
export function watchOwner(start: EnvironmentId | null) {
  let last = start;
  let moved = false;
  return {
    observe(now: EnvironmentId | null) {
      if (now !== last) moved = true;
      last = now;
    },
    get moved() {
      return moved;
    },
  };
}

/** Keeps the previous list while nothing a consumer reads changed, so they skip a render. */
export function reuseCandidates(
  previous: ReadonlyArray<OwnerCandidate>,
  next: ReadonlyArray<OwnerCandidate>,
): ReadonlyArray<OwnerCandidate> {
  if (previous.length !== next.length) return next;
  const same = next.every((candidate, index) => {
    const before = previous[index];
    return (
      before !== undefined &&
      before.environmentId === candidate.environmentId &&
      before.label === candidate.label &&
      before.connected === candidate.connected &&
      before.protocol === candidate.protocol &&
      before.canWrite === candidate.canWrite &&
      before.layout === candidate.layout
    );
  });
  return same ? previous : next;
}
