// Fork-only: the Dashboard layout is written whole, so a save must come from the revision the
// server holds; otherwise two devices editing at once would drop each other's changes unseen.
import {
  ServerSettingsError,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

export const ensureForkDashboardRevision = (
  current: ServerSettings,
  patch: ServerSettingsPatch,
  settingsPath: string,
): Effect.Effect<void, ServerSettingsError> =>
  patch.forkDashboard === undefined ||
  patch.forkDashboard.revision === current.forkDashboard.revision + 1
    ? Effect.void
    : Effect.fail(new ServerSettingsError({ settingsPath, operation: "write-stale-dashboard" }));
