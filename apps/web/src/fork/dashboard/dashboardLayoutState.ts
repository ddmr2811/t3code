// Fork-only: where the Dashboard's arrangement lives: the primary server's settings, so every
// client of that server shows the same Dashboard. Writing it needs the settings permission.
import { useAtomValue } from "@effect/atom-react";
import { DEFAULT_FORK_DASHBOARD_LAYOUT, type ForkDashboardLayout } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";

import { toastManager } from "../../components/ui/toast";

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
  /** Saves `layout` as the revision after `base`; "stale" when another device saved since. */
  readonly save: (
    layout: ForkDashboardLayout,
    base: ForkDashboardLayout,
  ) => Promise<"saved" | "stale" | "failed">;
}

export function useDashboardLayoutWriter(): DashboardLayoutWriter {
  const environmentId = usePrimaryEnvironmentId();
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const presentation = environmentId === null ? undefined : presentations.get(environmentId);
  const allowed = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(environmentId, PERMISSION_INPUT),
  );
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const serverLabel = presentation?.entry.target.label ?? null;
  const protocol = presentation?.serverConfig?.environment.capabilities.forkDashboard ?? 0;
  const supported = protocol >= 2;
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
    save: async (layout, base) => {
      if (environmentId === null || blocked !== null) return "failed";
      const result = await update({
        environmentId,
        input: {
          patch: {
            forkDashboard: {
              ...layout,
              // A protocol 2 server refuses a panel id it does not know.
              panels:
                protocol >= 3
                  ? layout.panels
                  : layout.panels.filter((panel) => panel.id !== "charts"),
              revision: base.revision + 1,
            },
          },
        },
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
    },
  };
}
