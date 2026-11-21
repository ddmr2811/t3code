import { useRef } from "react";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { useGT } from "gt-react";

import { Input } from "../ui/input";
import { environmentsWithoutForkTargetBranch } from "./forkTargetBranchRow.logic";
import { SettingsRow, SettingResetButton } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function ForkTargetBranchRow() {
  const gt = useGT();
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
      title={gt("Target branch")}
      description={
        disabled
          ? gt("Needs the fork's server on: {machines}.", { machines: missing.join(", ") })
          : gt(
              "Automatic pull keeps this branch current instead of the default one, and new pull requests target it unless the branch records another base. Leave empty to use the repository's default branch.",
            )
      }
      resetAction={
        !disabled && (mixed || current !== DEFAULT_SERVER_SETTINGS.forkTargetBranch) ? (
          <SettingResetButton
            ariaLabel={gt("Reset target branch to default")}
            onClick={() =>
              updateSettings({ forkTargetBranch: DEFAULT_SERVER_SETTINGS.forkTargetBranch })
            }
          />
        ) : null
      }
      control={
        <Input
          key={`${scopeKey}:${mixed}:${current}`}
          aria-label={gt("Target branch")}
          autoCapitalize="none"
          spellCheck={false}
          disabled={disabled}
          onChange={() => {
            edited.current = true;
          }}
          placeholder={
            mixed ? gt("Mixed", { $context: "values differ across targets" }) : gt("Default branch")
          }
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
