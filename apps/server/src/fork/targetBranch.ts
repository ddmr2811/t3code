import type { ProjectId, ServerSettings } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

const REF_PREFIX = "refs/heads/";

function normalizeTargetBranch(value: string): string | null {
  const trimmed = value.trim();
  const name = (trimmed.startsWith(REF_PREFIX) ? trimmed.slice(REF_PREFIX.length) : trimmed).trim();
  return name.length > 0 ? name : null;
}

/** Rama de destino del proyecto, normalizada; null si no hay. */
export function forkTargetBranchFor(
  settings: ServerSettings,
  projectId: ProjectId | null,
): string | null {
  return normalizeTargetBranch(
    resolveProjectSettings(settings, projectId).settings.forkTargetBranch,
  );
}

/** ¿Se puede hacer auto pull de la rama en la que está la carpeta? */
export function isForkAutoPullBranch(input: {
  readonly branch: string | null;
  readonly isDefaultBranch: boolean;
  readonly targetBranch: string | null;
}): boolean {
  if (input.targetBranch === null) return input.isDefaultBranch;
  return input.branch === input.targetBranch;
}

/** Rama a probar como base de un PR antes de la principal; null si no aplica. */
export function forkPrBaseCandidate(input: {
  readonly headBranch: string;
  readonly targetBranch: string | null;
}): string | null {
  if (input.targetBranch === null || input.headBranch === input.targetBranch) return null;
  return input.targetBranch;
}

/** Primer destino no nulo de varios proyectos que comparten carpeta. */
export function firstForkTargetBranch(targets: ReadonlyArray<string | null>): string | null {
  return targets.find((target): target is string => target !== null) ?? null;
}
