import { getDescriptorStringValue, isReasoningSelect } from "@t3tools/client-runtime/model-traits";
import {
  getProviderAttachmentLimitError,
  isProviderSendTurnSupportedImageMimeType,
  isRuntimeModeAbove,
  type ModelSelection,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES,
  type ProjectId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type ProviderOptionDescriptor,
  resolveProjectProviderInstanceEnabled,
  RuntimeMode,
  type ServerConfig,
} from "@t3tools/contracts";
import {
  type LegacyProjectSettingsFields,
  resolveProjectSettings,
} from "@t3tools/shared/projectSettings";

export interface TurnSettings {
  readonly model: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

/** An image waiting in the composer; `key` tells two copies of one screenshot apart. */
export interface DraftImage {
  readonly key: string;
  readonly file: Blob;
  readonly name: string;
  readonly mimeType: (typeof PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES)[number];
  readonly sizeBytes: number;
  /** A data: URL for the thumbnail; the bytes themselves upload from `file`. */
  readonly preview: string;
}

/** What the user changed in this thread's composer; anything unset is the thread's own. */
export interface TurnDraft extends Partial<TurnSettings> {
  readonly text: string;
  readonly images?: ReadonlyArray<DraftImage>;
}

export interface ProviderChoice {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly label: string;
  readonly accentColor: string | undefined;
  readonly models: ReadonlyArray<{
    readonly slug: string;
    readonly name: string;
    readonly descriptors: ReadonlyArray<ProviderOptionDescriptor>;
  }>;
  readonly runtimeModes: ReadonlyArray<RuntimeMode>;
  readonly interactionModes: boolean;
  /** False where a turn with images would fail; see `takesImages`. */
  readonly takesImages: boolean;
}

/**
 * The generic ACP driver passes images only to an agent that negotiated them when it started,
 * and fails the turn otherwise (Replay (dev) does not). The server does not publish what the
 * agent negotiated, so that driver counts as without images; every other one sends them.
 */
const takesImages = (driver: ProviderDriverKind) => driver !== "acpRegistry";

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
      driver: provider.driver,
      label: provider.displayName ?? provider.instanceId,
      accentColor: provider.accentColor,
      models: provider.models
        .filter((model) => model.isLegacy !== true)
        .map((model) => ({
          slug: model.slug,
          name: model.name,
          descriptors: model.capabilities?.optionDescriptors ?? [],
        })),
      runtimeModes: (provider.supportedRuntimeModes ?? RuntimeMode.literals).filter(
        (mode) => !isRuntimeModeAbove(mode, ceiling),
      ),
      interactionModes: provider.showInteractionModeToggle === true,
      takesImages: takesImages(provider.driver),
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

/**
 * Starting settings for a new thread in `projectId`: project defaults over machine defaults,
 * falling back to the first available provider/model and clamped to what that provider allows.
 */
export function defaultNewThreadSettings(
  config: Pick<ServerConfig, "settings">,
  projectId: ProjectId,
  providers: ReadonlyArray<ProviderChoice>,
  project?: LegacyProjectSettingsFields | null,
): TurnSettings | null {
  const firstProvider = providers.find((choice) => choice.models.length > 0);
  if (firstProvider === undefined) return null;
  const resolved = resolveProjectSettings(config.settings, projectId, project).settings;
  const preferred = resolved.defaultModelSelection;
  const preferredProvider =
    preferred === null
      ? undefined
      : providers.find(
          (choice) => choice.instanceId === preferred.instanceId && choice.models.length > 0,
        );
  const model: ModelSelection =
    preferred !== null &&
    preferredProvider !== undefined &&
    preferredProvider.models.some((candidate) => candidate.slug === preferred.model)
      ? preferred
      : preferredProvider !== undefined
        ? { instanceId: preferredProvider.instanceId, model: preferredProvider.models[0]!.slug }
        : { instanceId: firstProvider.instanceId, model: firstProvider.models[0]!.slug };

  return turnSettings(
    { text: "" },
    {
      model,
      runtimeMode: resolved.defaultRuntimeMode,
      interactionMode: "default",
    },
    providers,
  );
}

type ImageFile = Pick<File, "name" | "type" | "size">;

/**
 * The files of a pick or a paste that may go with the message, and why any were left out. The
 * checks are the turn contract's, so the server never refuses what the composer took.
 */
export function acceptImages<F extends ImageFile>(
  current: ReadonlyArray<DraftImage>,
  files: ReadonlyArray<F>,
): { readonly accepted: ReadonlyArray<F>; readonly error: string | null } {
  const accepted: Array<F> = [];
  const refused: Array<string> = [];
  for (const file of files) {
    if (!isProviderSendTurnSupportedImageMimeType(file.type)) {
      refused.push(`«${file.name}» no es PNG, JPEG, GIF ni WebP`);
      continue;
    }
    if (file.size === 0 || file.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      refused.push(`«${file.name}» pasa de 10 MB`);
      continue;
    }
    const all = [
      ...current.map((image) => ({ type: "image" as const, ...image })),
      ...accepted.map((image) => ({
        type: "image" as const,
        mimeType: image.type,
        sizeBytes: image.size,
      })),
      { type: "image" as const, mimeType: file.type, sizeBytes: file.size },
    ];
    if (getProviderAttachmentLimitError(all) !== undefined) {
      refused.push(`«${file.name}» no cabe: el mensaje ya lleva el máximo de imágenes`);
      continue;
    }
    accepted.push(file);
  }
  return { accepted, error: refused.length === 0 ? null : `${refused.join("; ")}.` };
}

/** The model's reasoning control and where it stands, or null when the model has none. */
export function modelEffort(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  selection: ModelSelection,
) {
  const descriptor = descriptors.find(isReasoningSelect);
  if (descriptor === undefined) return null;
  const current = getDescriptorStringValue(descriptor, selection);
  return {
    descriptor,
    current,
    label: descriptor.options.find((option) => option.id === current)?.label ?? null,
    bars: effortBars(descriptor, current),
  };
}

// As in T3's composer: named levels keep their word, an off level fills no bar.
const NAMED_LEVELS = new Set(["ultracode", "max", "default"]);
const OFF_LEVELS = new Set(["off", "none"]);
const MAX_BARS = 7;

/** One bar per ordinary level, filled up to the current one; null when bars cannot say it. */
export function effortBars(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
  current: string | null,
): { readonly count: number; readonly filled: number } | null {
  const special = new Set([...(descriptor.promptInjectedValues ?? []), ...NAMED_LEVELS]);
  const levels = descriptor.options.filter((option) => !special.has(option.id));
  if (levels.length < 2 || levels.length > MAX_BARS || current === null) return null;
  const startsAtOff = OFF_LEVELS.has(levels[0]!.id);
  const count = startsAtOff ? levels.length - 1 : levels.length;
  if (special.has(current)) return { count, filled: count };
  const index = levels.findIndex((option) => option.id === current);
  if (index < 0) return null;
  return { count, filled: startsAtOff ? index : index + 1 };
}

/** The selection with one option set, the others kept. */
export function withOption(selection: ModelSelection, id: string, value: string): ModelSelection {
  return {
    ...selection,
    options: [...(selection.options ?? []).filter((option) => option.id !== id), { id, value }],
  };
}
