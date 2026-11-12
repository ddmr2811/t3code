import { useRef } from "react";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";

import { Input } from "../ui/input";
import { environmentsWithoutForkTargetBranch } from "./forkTargetBranchRow.logic";
import { SettingsRow, SettingResetButton } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const DESCRIPTION =
  "Automatic pull keeps this branch current instead of the default one, and new pull requests target it unless the branch records another base. Leave empty to use the repository's default branch.";

export function ForkTargetBranchRow() {
  const settings = useScopedSettings();
  const { targets, connectedEnvironments } = useSettingsScope();
  const scopeKey = targets.map((target) => `${target.environmentId}:${target.projectId}`).join(",");
  const edited = useRef(false);
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["forkTargetBranch"]);
  const missing = environmentsWithoutForkTargetBranch(
    connectedEnvironments.map((environment) => ({
      label: environment.label,
      capabilities: environment.serverConfig?.environment.capabilities,
    })),
  );
  const disabled = missing.length > 0;
  const current = settings.forkTargetBranch ?? "";

  return (
    <SettingsRow
      serverScoped
      settingKeys={["forkTargetBranch"]}
      mixed={mixed}
      title="Target branch"
      description={disabled ? `Needs the fork's server on: ${missing.join(", ")}.` : DESCRIPTION}
      resetAction={
        !disabled && (mixed || current !== DEFAULT_SERVER_SETTINGS.forkTargetBranch) ? (
          <SettingResetButton
            label="target branch"
            onClick={() =>
              updateSettings({ forkTargetBranch: DEFAULT_SERVER_SETTINGS.forkTargetBranch })
            }
          />
        ) : null
      }
      control={
        <Input
          key={`${scopeKey}:${mixed}:${current}`}
          aria-label="Target branch"
          autoCapitalize="none"
          spellCheck={false}
          disabled={disabled}
          onChange={() => {
            edited.current = true;
          }}
          placeholder={mixed ? "Mixed" : "Default branch"}
          defaultValue={mixed ? "" : current}
          onBlur={(event) => {
            const value = event.target.value.trim();
            if (!disabled && edited.current && (mixed || value !== current))
              updateSettings({ forkTargetBranch: value });
            edited.current = false;
          }}
        />
      }
    />
  );
}
