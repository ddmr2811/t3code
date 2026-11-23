import {
  isRuntimeModeAbove,
  type ModelSelection,
  type ProjectId,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  resolveProjectProviderInstanceEnabled,
  RuntimeMode,
  type ServerConfig,
} from "@t3tools/contracts";

export interface TurnSettings {
  readonly model: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

/** What the user changed in this thread's composer; anything unset is the thread's own. */
export interface TurnDraft extends Partial<TurnSettings> {
  readonly text: string;
}

export interface ProviderChoice {
  readonly instanceId: ProviderInstanceId;
  readonly label: string;
  readonly models: ReadonlyArray<{ readonly slug: string; readonly name: string }>;
  readonly runtimeModes: ReadonlyArray<RuntimeMode>;
  readonly interactionModes: boolean;
}

/** The providers a thread of `projectId` may run on this machine, with the modes each allows. */
export function providerChoices(
  config: Pick<ServerConfig, "providers" | "settings" | "managedPolicy">,
  projectId: ProjectId,
): ReadonlyArray<ProviderChoice> {
  const ceiling = config.managedPolicy?.limits?.maxRuntimeMode;
  return config.providers
    .filter(
      (provider) =>
        // The project's own switch decides over the machine's, as in T3's composers.
        resolveProjectProviderInstanceEnabled(config.settings, projectId, provider.instanceId) &&
        provider.installed &&
        provider.status !== "disabled" &&
        provider.availability !== "unavailable" &&
        provider.models.length > 0,
    )
    .map((provider) => ({
      instanceId: provider.instanceId,
      label: provider.displayName ?? provider.instanceId,
      models: provider.models.filter((model) => model.isLegacy !== true),
      runtimeModes: (provider.supportedRuntimeModes ?? RuntimeMode.literals).filter(
        (mode) => !isRuntimeModeAbove(mode, ceiling),
      ),
      interactionModes: provider.showInteractionModeToggle === true,
    }));
}

/** The settings a send uses: the draft's choices over the thread's, within what the provider allows. */
export function turnSettings(
  draft: TurnDraft,
  thread: TurnSettings,
  providers: ReadonlyArray<ProviderChoice>,
): TurnSettings {
  const model = draft.model ?? thread.model;
  const provider = providers.find((choice) => choice.instanceId === model.instanceId);
  const runtimeMode = draft.runtimeMode ?? thread.runtimeMode;
  return {
    model,
    // A mode the chosen provider does not offer falls back to its safest one it does.
    runtimeMode:
      provider === undefined || provider.runtimeModes.includes(runtimeMode)
        ? runtimeMode
        : (provider.runtimeModes[0] ?? runtimeMode),
    // Plan mode only where the provider shows the toggle; elsewhere the thread's mode stands.
    interactionMode:
      provider?.interactionModes === true
        ? (draft.interactionMode ?? thread.interactionMode)
        : thread.interactionMode,
  };
}
