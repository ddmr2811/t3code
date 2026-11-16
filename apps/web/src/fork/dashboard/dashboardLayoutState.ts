// Fork-only: where the Dashboard's arrangement lives: the primary server's settings, so every
// client of that server shows the same Dashboard. Writing it needs the settings permission.
import { useAtomValue } from "@effect/atom-react";
import { DEFAULT_FORK_DASHBOARD_LAYOUT, type ForkDashboardLayout } from "@t3tools/contracts";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { environmentPresentations } from "../../state/presentation";
import { primaryServerSettingsAtom, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

export function useSavedDashboardLayout(): ForkDashboardLayout {
  return useAtomValue(primaryServerSettingsAtom).forkDashboard;
}

const PERMISSION_INPUT = { patch: { forkDashboard: DEFAULT_FORK_DASHBOARD_LAYOUT } };

export interface DashboardLayoutWriter {
  /** The machine whose settings hold the layout, as the user names it. */
  readonly serverLabel: string | null;
  /** Why the layout cannot be changed from here, or null when it can. */
  readonly blocked: string | null;
  readonly save: (layout: ForkDashboardLayout) => Promise<boolean>;
}

export function useDashboardLayoutWriter(): DashboardLayoutWriter {
  const environmentId = usePrimaryEnvironmentId();
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const presentation = environmentId === null ? undefined : presentations.get(environmentId);
  const allowed = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(environmentId, PERMISSION_INPUT),
  );
  const update = useAtomCommand(serverEnvironment.updateSettings, "save the Dashboard layout");
  const serverLabel = presentation?.entry.target.label ?? null;
  const supported = (presentation?.serverConfig?.environment.capabilities.forkDashboard ?? 0) >= 1;
  const blocked =
    environmentId === null
      ? "Connect to a server to arrange the Dashboard."
      : !supported
        ? `Update the T3 Code server on ${serverLabel ?? "this machine"} to arrange the Dashboard.`
        : !allowed
          ? `This connection may not change ${serverLabel ?? "the server"}'s settings.`
          : null;
  return {
    serverLabel,
    blocked,
    save: async (layout) => {
      if (environmentId === null || blocked !== null) return false;
      const result = await update({
        environmentId,
        input: { patch: { forkDashboard: layout } },
      });
      return result._tag === "Success";
    },
  };
}
