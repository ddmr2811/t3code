// Fork-only: where the Dashboard's arrangement lives: the settings of the environment the client
// setting `forkDashboardOwner` names, or of the primary, so every client of it shows the same
// Dashboard. Writing it needs the settings permission there.
import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_FORK_DASHBOARD_LAYOUT,
  type EnvironmentId,
  type ForkDashboardLayout,
  ForkDashboardLayout as ForkDashboardLayoutSchema,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";

import { toastManager } from "../../components/ui/toast";
import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";
import { useClientSettings } from "../../hooks/useSettings";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { environmentPresentations, useEnvironmentPresentation } from "../../state/presentation";
import { primaryServerSettingsAtom, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  type DashboardSource,
  dashboardWriteTarget,
  needsLastRead,
  type OwnerCandidate,
  resolveDashboardSource,
  reuseCandidates,
} from "./dashboardOwner.logic";

const PERMISSION_INPUT = { patch: { forkDashboard: DEFAULT_FORK_DASHBOARD_LAYOUT } };

let previousCandidates: ReadonlyArray<OwnerCandidate> = [];
const ownerCandidatesAtom = Atom.make((get): ReadonlyArray<OwnerCandidate> => {
  const next = [...get(environmentPresentations.presentationsAtom)].map(
    ([environmentId, presentation]) => ({
      environmentId,
      label: presentation.entry.target.label,
      connected: presentation.connection.phase === "connected",
      protocol: presentation.serverConfig?.environment.capabilities.forkDashboard ?? 0,
      canWrite: get(
        serverEnvironment.updateSettings.permissionAtom(environmentId, PERMISSION_INPUT),
      ),
      layout: presentation.serverConfig?.settings.forkDashboard ?? null,
    }),
  );
  previousCandidates = reuseCandidates(previousCandidates, next);
  return previousCandidates;
}).pipe(Atom.withLabel("fork-dashboard-owner-candidates"));

/** Versioned, so a layout cached in an older shape is never read as the current one. */
const lastReadKey = (environmentId: EnvironmentId) => `t3code:forkDashboard:v1:${environmentId}`;

function readLastRead(environmentId: EnvironmentId): ForkDashboardLayout | null {
  try {
    return getLocalStorageItem(lastReadKey(environmentId), ForkDashboardLayoutSchema);
  } catch {
    return null;
  }
}

export interface DashboardOwnerState {
  readonly source: DashboardSource;
  readonly primaryId: EnvironmentId | null;
  readonly candidates: ReadonlyArray<OwnerCandidate>;
}

export function useDashboardOwner(): DashboardOwnerState {
  const owner = useClientSettings((settings) => settings.forkDashboardOwner);
  const primaryId = usePrimaryEnvironmentId();
  const candidates = useAtomValue(ownerCandidatesAtom);
  const primaryLayout = useAtomValue(primaryServerSettingsAtom).forkDashboard;
  // Read whenever the owner's own layout cannot be used, so it shows what was last read there.
  const lastRead =
    owner !== null && needsLastRead({ owner, primaryId, candidates }) ? readLastRead(owner) : null;
  const source = resolveDashboardSource({ owner, primaryId, candidates, lastRead, primaryLayout });
  const liveLayout = source.kind === "chosen" ? source.layout : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the owner's layout into localStorage so it still shows while that server is offline
  useEffect(() => {
    if (owner === null || liveLayout === null) return;
    try {
      setLocalStorageItem(lastReadKey(owner), liveLayout, ForkDashboardLayoutSchema);
    } catch {
      // Storage may be unavailable; the offline fallback is then the primary's layout.
    }
  }, [owner, liveLayout]);
  return { source, primaryId, candidates };
}

export function useSavedDashboardLayout(): ForkDashboardLayout {
  return useDashboardOwner().source.layout;
}

export type DashboardSaveOutcome = "saved" | "stale" | "failed";

/** Saves `layout` to one environment as the revision after `base`. */
function useWriteDashboardLayout() {
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  return async (
    environmentId: EnvironmentId,
    layout: ForkDashboardLayout,
    base: ForkDashboardLayout,
  ): Promise<DashboardSaveOutcome> => {
    const result = await update({
      environmentId,
      input: { patch: { forkDashboard: { ...layout, revision: base.revision + 1 } } },
    });
    if (result._tag === "Success") return "saved";
    const error =
      result._tag === "Failure" ? Option.getOrNull(Cause.findErrorOption(result.cause)) : null;
    if (
      error !== null &&
      typeof error === "object" &&
      "operation" in error &&
      error.operation === "write-stale-dashboard"
    ) {
      return "stale";
    }
    toastManager.add({
      type: "error",
      title: "Dashboard not saved",
      description: error instanceof Error ? error.message : "The server did not take the change.",
    });
    return "failed";
  };
}

export interface DashboardLayoutWriter {
  /** The machine whose settings hold the layout, as the user names it. */
  readonly serverLabel: string | null;
  /** Why the layout cannot be changed from here, or null when it can. */
  readonly blocked: string | null;
  /** Why the Charts panel cannot be moved or hidden: a server that drops its setting. */
  readonly chartsBlocked: string | null;
  /** Why "What the AI did" cannot be moved or hidden, for the same reason. */
  readonly activityBlocked: string | null;
  /** Saves `layout` as the revision after `base`; "stale" when another device saved since. */
  readonly save: (
    layout: ForkDashboardLayout,
    base: ForkDashboardLayout,
  ) => Promise<DashboardSaveOutcome>;
  /** Writes `layout` to the environment the Dashboard moves to, the only other write it makes. */
  readonly copyTo: (
    environmentId: EnvironmentId,
    layout: ForkDashboardLayout,
    base: ForkDashboardLayout,
  ) => Promise<DashboardSaveOutcome>;
}

export function useDashboardLayoutWriter(state: DashboardOwnerState): DashboardLayoutWriter {
  const { source } = state;
  const environmentId = dashboardWriteTarget(source, state.primaryId);
  const { presentation } = useEnvironmentPresentation(environmentId);
  const allowed = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(environmentId, PERMISSION_INPUT),
  );
  const write = useWriteDashboardLayout();
  const serverLabel =
    source.kind === "primary" ? (presentation?.entry.target.label ?? null) : source.label;
  const protocol = presentation?.serverConfig?.environment.capabilities.forkDashboard ?? 0;
  const blocked =
    source.kind === "unavailable"
      ? source.notice
      : environmentId === null
        ? "Connect to a server to arrange the Dashboard."
        : protocol < 2
          ? `Update the T3 Code server on ${serverLabel ?? "this machine"} to arrange the Dashboard.`
          : !allowed
            ? `This connection may not change ${serverLabel ?? "the server"}'s settings.`
            : null;
  return {
    serverLabel,
    blocked,
    chartsBlocked:
      protocol >= 3 || source.kind === "unavailable"
        ? null
        : `Update the T3 Code server on ${serverLabel ?? "this machine"} to move or hide Charts.`,
    activityBlocked:
      protocol >= 4 || source.kind === "unavailable"
        ? null
        : `Update the T3 Code server on ${serverLabel ?? "this machine"} to move or hide this panel.`,
    save: async (layout, base) => {
      if (environmentId === null || blocked !== null) return "failed";
      return write(environmentId, layout, base);
    },
    copyTo: write,
  };
}
