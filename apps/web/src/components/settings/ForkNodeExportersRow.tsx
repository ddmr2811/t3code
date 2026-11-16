// Fork-only: the node_exporters a server reads for the Dashboard's machines without T3 Code.
import { useRef, useState } from "react";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";

import { Textarea } from "../ui/textarea";
import { formatNodeExporters, parseNodeExporters } from "./forkNodeExportersRow.logic";
import { SettingsRow, SettingResetButton } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const DESCRIPTION =
  "One per line: a name and the exporter's URL, such as prod-cx43 http://100.96.210.49:9100/metrics. This machine reads them for the Dashboard. Use the machine's Tailscale IP: only plain http to Tailscale IPs is read, never names.";

export function ForkNodeExportersRow() {
  const settings = useScopedSettings();
  const { targets, connectedEnvironments } = useSettingsScope();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["forkNodeExporters"]);
  const edited = useRef(false);
  const [invalid, setInvalid] = useState<ReadonlyArray<string>>([]);
  const scopeKey = targets.map((target) => target.environmentId).join(",");
  const missing = connectedEnvironments
    .filter((environment) => !environment.serverConfig?.environment.capabilities.forkMachines)
    .map((environment) => environment.label);
  const disabled = missing.length > 0;
  const current = formatNodeExporters(settings.forkNodeExporters);

  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("fork-node-exporters")}
      settingKeys={["forkNodeExporters"]}
      mixed={mixed}
      description={
        disabled
          ? `Needs the fork's server on: ${missing.join(", ")}.`
          : invalid.length > 0
            ? `Not saved, needs a name and a URL: ${invalid.join("; ")}`
            : DESCRIPTION
      }
      resetAction={
        !disabled && (mixed || settings.forkNodeExporters.length > 0) ? (
          <SettingResetButton
            label="Dashboard exporters"
            onClick={() =>
              updateSettings({ forkNodeExporters: DEFAULT_SERVER_SETTINGS.forkNodeExporters })
            }
          />
        ) : null
      }
    >
      <div className="mt-3 max-w-2xl pb-3.5">
        <Textarea
          key={`${scopeKey}:${mixed}:${current}`}
          aria-label="Dashboard exporters"
          autoCapitalize="none"
          spellCheck={false}
          disabled={disabled}
          rows={3}
          onChange={() => {
            edited.current = true;
          }}
          defaultValue={mixed ? "" : current}
          placeholder={mixed ? "Mixed" : "prod-cx43 http://100.96.210.49:9100/metrics"}
          onBlur={(event) => {
            if (disabled || !edited.current) return;
            edited.current = false;
            const parsed = parseNodeExporters(event.target.value);
            setInvalid(parsed.invalid);
            if (parsed.invalid.length > 0) return;
            if (mixed || formatNodeExporters(parsed.exporters) !== current) {
              updateSettings({ forkNodeExporters: parsed.exporters });
            }
          }}
        />
      </div>
    </SettingsRow>
  );
}
