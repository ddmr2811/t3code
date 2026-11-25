// Fork-only: the model that drafts a bot from one sentence in the ADE.
import {
  DEFAULT_SERVER_SETTINGS,
  isForkBotDraftModelAllowed,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { useGT } from "gt-react";

import { useEnvironmentProviders } from "../../state/environments";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingResetButton } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useSearchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const AUTOMATIC = "automatic";
const SEPARATOR = "\u0000";

export function ForkBotDraftModelRow() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const { connectedEnvironments } = useSettingsScope();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["forkBotDraftModelSelection"]);
  const current = settings.forkBotDraftModelSelection;
  const providersByEnvironment = useEnvironmentProviders();
  const environment = connectedEnvironments[0];
  const providers =
    environment === undefined ? [] : (providersByEnvironment.get(environment.environmentId) ?? []);
  const options = providers.flatMap((provider) =>
    provider.enabled && provider.installed
      ? provider.models
          .filter(
            (model) =>
              model.isLegacy !== true && isForkBotDraftModelAllowed(provider.driver, model.slug),
          )
          .map((model) => ({
            value: `${provider.instanceId}${SEPARATOR}${model.slug}`,
            label: `${provider.displayName ?? provider.instanceId} · ${model.name}`,
          }))
      : [],
  );
  const currentValue =
    current === null ? AUTOMATIC : `${current.instanceId}${SEPARATOR}${current.model}`;
  const labelOf = (value: string) =>
    value === AUTOMATIC
      ? gt("Automatic: Gemini Flash, then Kimi")
      : (options.find((option) => option.value === value)?.label ??
        gt("{model} (not available)", { model: value.split(SEPARATOR)[1] ?? value }));

  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("fork-bot-draft-model")}
      settingKeys={["forkBotDraftModelSelection"]}
      mixed={mixed}
      description={gt(
        "In the ADE, the model that writes a bot from one sentence. Only Gemini through Antigravity or a paid OpenCode model, since the sentence may carry project data. When it is not available, the ADE drafts from the sentence alone.",
      )}
      resetAction={
        mixed || current !== null ? (
          <SettingResetButton
            ariaLabel={gt("Reset bot drafting model to default")}
            onClick={() =>
              updateSettings({
                forkBotDraftModelSelection: DEFAULT_SERVER_SETTINGS.forkBotDraftModelSelection,
              })
            }
          />
        ) : null
      }
      control={
        <Select
          value={mixed ? null : currentValue}
          onValueChange={(value) => {
            if (value === null || value === currentValue) return;
            const [instanceId = "", model = ""] = value.split(SEPARATOR);
            updateSettings({
              forkBotDraftModelSelection:
                value === AUTOMATIC
                  ? null
                  : { instanceId: ProviderInstanceId.make(instanceId), model },
            });
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-72" aria-label={gt("Bot drafting model")}>
            <SelectValue>
              {mixed
                ? gt("Mixed", { $context: "values differ across targets" })
                : labelOf(currentValue)}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem hideIndicator value={AUTOMATIC}>
              {labelOf(AUTOMATIC)}
            </SelectItem>
            {currentValue !== AUTOMATIC &&
            !options.some((option) => option.value === currentValue) ? (
              <SelectItem hideIndicator value={currentValue}>
                {labelOf(currentValue)}
              </SelectItem>
            ) : null}
            {options.map((option) => (
              <SelectItem hideIndicator key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
