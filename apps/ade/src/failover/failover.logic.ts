import {
  FORK_FAILOVER_ID_MAX_LENGTH,
  FORK_FAILOVER_MAX_CHAINS,
  FORK_FAILOVER_MAX_COOLDOWN_SECONDS,
  FORK_FAILOVER_MAX_SWITCHES_PER_WINDOW,
  FORK_FAILOVER_MAX_TARGETS_PER_CHAIN,
  FORK_FAILOVER_MIN_COOLDOWN_SECONDS,
  FORK_FAILOVER_MIN_SWITCHES_PER_WINDOW,
  FORK_FAILOVER_MODEL_MAX_LENGTH,
  FORK_FAILOVER_NAME_MAX_LENGTH,
  FORK_FAILOVER_PROTOCOL_VERSION,
  type ForkFailoverChain,
  type ForkFailoverConfig,
  type ForkFailoverTarget,
  type ProjectId,
  type ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  type ServerConfig,
} from "@t3tools/contracts";

const SINGLE_LINE_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface MachineModelOption {
  readonly instanceId: ProviderInstanceId;
  readonly providerLabel: string;
  readonly model: string;
  readonly modelName: string;
}

export interface FailoverChainDraft {
  readonly id: string;
  readonly name: string;
  readonly matchInstanceId?: ProviderInstanceId;
  readonly matchModel?: string;
  readonly targets: ReadonlyArray<ForkFailoverTarget>;
}

export interface FailoverConfigDraft {
  readonly enabled: boolean;
  readonly cooldownSeconds: number;
  readonly maxSwitchesPerWindow: number;
  readonly chains: ReadonlyArray<FailoverChainDraft>;
}

export function failoverTargetKey(
  target: Pick<ForkFailoverTarget, "instanceId" | "model">,
): string {
  return `${target.instanceId}\u0000${target.model}`;
}

export type MachineProviderCatalog = ReadonlyMap<ProviderInstanceId, ReadonlySet<string> | null>;

function isProviderSelectable(provider: ServerConfig["providers"][number]): boolean {
  return (
    provider.enabled &&
    provider.installed &&
    provider.status !== "disabled" &&
    provider.status !== "error" &&
    provider.availability !== "unavailable" &&
    provider.auth.status !== "unauthenticated"
  );
}

export function availableMachineModelOptions(
  config: Pick<ServerConfig, "providers"> | null,
): ReadonlyArray<MachineModelOption> {
  if (config === null) return [];
  const options: MachineModelOption[] = [];
  for (const provider of config.providers) {
    if (!isProviderSelectable(provider)) {
      continue;
    }
    const providerLabel = provider.displayName ?? provider.instanceId;
    for (const model of provider.models) {
      if (model.isLegacy === true) continue;
      options.push({
        instanceId: provider.instanceId,
        providerLabel,
        model: model.slug,
        modelName: model.name,
      });
    }
  }
  return options;
}

export function availableMachineProviderCatalog(
  config: Pick<ServerConfig, "providers" | "settings"> | null,
  projectId?: ProjectId,
): MachineProviderCatalog {
  const catalog = new Map<ProviderInstanceId, ReadonlySet<string> | null>();
  if (config === null) return catalog;
  for (const provider of config.providers) {
    if (!isProviderSelectable(provider)) continue;
    if (
      projectId !== undefined &&
      !resolveProjectProviderInstanceEnabled(config.settings, projectId, provider.instanceId)
    ) {
      continue;
    }
    const knownModels =
      provider.models.length === 0
        ? null
        : new Set(
            provider.models.filter((model) => model.isLegacy !== true).map((model) => model.slug),
          );
    catalog.set(provider.instanceId, knownModels);
  }
  return catalog;
}

function isTargetInCatalog(
  target: Pick<ForkFailoverTarget, "instanceId" | "model">,
  availableProviders: MachineProviderCatalog,
): boolean {
  if (!availableProviders.has(target.instanceId)) return false;
  const knownModels = availableProviders.get(target.instanceId);
  if (knownModels === null || knownModels === undefined) return true;
  return knownModels.has(target.model);
}

function chainSpecificity(
  chain: ForkFailoverChain,
  current: Pick<ForkFailoverTarget, "instanceId" | "model">,
): number {
  const hasInstance = chain.matchInstanceId !== undefined;
  const hasModel = chain.matchModel !== undefined;
  if (hasInstance && chain.matchInstanceId !== current.instanceId) return -1;
  if (hasModel && chain.matchModel !== current.model) return -1;
  if (hasInstance && hasModel) return 3;
  if (hasInstance) return 2;
  if (hasModel) return 1;
  return 0;
}

/** Finds the first eligible backup target for a thread under the machine's failover config. */
export function findBackupCandidateForThread(
  config: ForkFailoverConfig | null,
  current: Pick<ForkFailoverTarget, "instanceId" | "model">,
  availableProviders: MachineProviderCatalog,
): ForkFailoverTarget | null {
  if (config === null || config.chains.length === 0) return null;
  let bestChain: ForkFailoverChain | null = null;
  let bestScore = -1;
  for (const chain of config.chains) {
    const score = chainSpecificity(chain, current);
    if (score > bestScore) {
      bestChain = chain;
      bestScore = score;
    }
  }
  if (bestChain === null) return null;
  const currentKey = failoverTargetKey(current);
  const currentIndex = bestChain.targets.findIndex(
    (target) => failoverTargetKey(target) === currentKey,
  );
  const ordered =
    currentIndex >= 0
      ? [...bestChain.targets.slice(currentIndex + 1), ...bestChain.targets.slice(0, currentIndex)]
      : bestChain.targets;
  return (
    ordered.find(
      (target) =>
        failoverTargetKey(target) !== currentKey && isTargetInCatalog(target, availableProviders),
    ) ?? null
  );
}

export function moveTargetInChain(
  targets: ReadonlyArray<ForkFailoverTarget>,
  index: number,
  direction: -1 | 1,
): ReadonlyArray<ForkFailoverTarget> {
  const nextIndex = index + direction;
  if (index < 0 || index >= targets.length || nextIndex < 0 || nextIndex >= targets.length) {
    return targets;
  }
  const copy = [...targets];
  const current = copy[index]!;
  copy[index] = copy[nextIndex]!;
  copy[nextIndex] = current;
  return copy;
}

export function buildSafeChainId(existingIds: ReadonlySet<string>, rawName: string): string {
  const slug = rawName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const base = `chain:${slug || "respaldo"}`;
  if (!existingIds.has(base)) return base;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!existingIds.has(candidate)) return candidate;
  }
  return `${base}-${existingIds.size + 1}`;
}

export function formatFailoverTargetLabel(
  target: Pick<ForkFailoverTarget, "instanceId" | "model">,
  options: ReadonlyArray<MachineModelOption>,
): string {
  const match = options.find(
    (option) => option.instanceId === target.instanceId && option.model === target.model,
  );
  if (match !== undefined) return `${match.providerLabel} · ${match.modelName}`;
  return `${target.instanceId} · ${target.model}`;
}

export function validateFailoverConfigDraft(
  draft: FailoverConfigDraft,
):
  | { readonly ok: true; readonly config: ForkFailoverConfig }
  | { readonly ok: false; readonly error: string } {
  const cooldownSeconds = Math.trunc(draft.cooldownSeconds);
  if (
    !Number.isInteger(cooldownSeconds) ||
    cooldownSeconds < FORK_FAILOVER_MIN_COOLDOWN_SECONDS ||
    cooldownSeconds > FORK_FAILOVER_MAX_COOLDOWN_SECONDS
  ) {
    return {
      ok: false,
      error: `El enfriamiento debe estar entre ${FORK_FAILOVER_MIN_COOLDOWN_SECONDS} y ${FORK_FAILOVER_MAX_COOLDOWN_SECONDS} segundos.`,
    };
  }

  const maxSwitchesPerWindow = Math.trunc(draft.maxSwitchesPerWindow);
  if (
    !Number.isInteger(maxSwitchesPerWindow) ||
    maxSwitchesPerWindow < FORK_FAILOVER_MIN_SWITCHES_PER_WINDOW ||
    maxSwitchesPerWindow > FORK_FAILOVER_MAX_SWITCHES_PER_WINDOW
  ) {
    return {
      ok: false,
      error: `El límite anti-bucle debe estar entre ${FORK_FAILOVER_MIN_SWITCHES_PER_WINDOW} y ${FORK_FAILOVER_MAX_SWITCHES_PER_WINDOW} relevos.`,
    };
  }

  if (draft.chains.length > FORK_FAILOVER_MAX_CHAINS) {
    return {
      ok: false,
      error: `No se pueden guardar más de ${FORK_FAILOVER_MAX_CHAINS} cadenas de respaldo.`,
    };
  }

  const seenChainIds = new Set<string>();
  const chains: ForkFailoverChain[] = [];

  for (const chain of draft.chains) {
    const id = chain.id.trim();
    if (
      id.length === 0 ||
      id.length > FORK_FAILOVER_ID_MAX_LENGTH ||
      !SAFE_ID_PATTERN.test(id) ||
      id.includes("..")
    ) {
      return { ok: false, error: "Identificador de cadena no válido." };
    }
    if (seenChainIds.has(id)) {
      return { ok: false, error: `La cadena «${id}» está duplicada.` };
    }
    seenChainIds.add(id);

    const name = chain.name.trim();
    if (name.length === 0) {
      return { ok: false, error: "Cada cadena necesita un nombre." };
    }
    if (name.length > FORK_FAILOVER_NAME_MAX_LENGTH || SINGLE_LINE_CONTROL_PATTERN.test(name)) {
      return {
        ok: false,
        error: `El nombre «${name.slice(0, 24)}» contiene caracteres no válidos o supera el máximo.`,
      };
    }

    const matchModel = chain.matchModel?.trim();
    if (
      matchModel !== undefined &&
      matchModel.length > 0 &&
      (matchModel.length > FORK_FAILOVER_MODEL_MAX_LENGTH ||
        SINGLE_LINE_CONTROL_PATTERN.test(matchModel))
    ) {
      return { ok: false, error: "El modelo de coincidencia no es válido." };
    }

    if (chain.targets.length === 0) {
      return {
        ok: false,
        error: `La cadena «${name}» debe incluir al menos un modelo de respaldo.`,
      };
    }
    if (chain.targets.length > FORK_FAILOVER_MAX_TARGETS_PER_CHAIN) {
      return {
        ok: false,
        error: `La cadena «${name}» supera el máximo de ${FORK_FAILOVER_MAX_TARGETS_PER_CHAIN} modelos.`,
      };
    }

    const seenTargets = new Set<string>();
    const targets: ForkFailoverTarget[] = [];
    for (const target of chain.targets) {
      const model = target.model.trim();
      if (
        model.length === 0 ||
        model.length > FORK_FAILOVER_MODEL_MAX_LENGTH ||
        SINGLE_LINE_CONTROL_PATTERN.test(model)
      ) {
        return { ok: false, error: `Modelo no válido en la cadena «${name}».` };
      }
      const key = failoverTargetKey({ instanceId: target.instanceId, model });
      if (seenTargets.has(key)) {
        return {
          ok: false,
          error: `La cadena «${name}» repite el modelo ${target.instanceId}/${model}.`,
        };
      }
      seenTargets.add(key);
      targets.push({
        instanceId: target.instanceId,
        model,
        ...(target.options === undefined ? {} : { options: target.options }),
      });
    }

    chains.push({
      id,
      name,
      ...(chain.matchInstanceId === undefined ? {} : { matchInstanceId: chain.matchInstanceId }),
      ...(matchModel === undefined || matchModel.length === 0 ? {} : { matchModel }),
      targets,
    });
  }

  return {
    ok: true,
    config: {
      version: FORK_FAILOVER_PROTOCOL_VERSION,
      enabled: draft.enabled,
      cooldownSeconds,
      maxSwitchesPerWindow,
      chains,
    },
  };
}
