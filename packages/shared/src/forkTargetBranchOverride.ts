import type { ProjectScopedServerSettingKey, ProjectSettingsOverrides } from "@t3tools/contracts";

/**
 * Fork: clients replace a project's whole override entry, and one without this branch does not
 * know `forkTargetBranch`. Keep the stored value unless the entry carries the key; an explicit
 * `""` removes it, so the project inherits again and no empty override lingers.
 */
export function withForkTargetBranchOverride(
  merged: ProjectSettingsOverrides,
  stored: ProjectSettingsOverrides | undefined,
  incoming: ProjectSettingsOverrides,
): ProjectSettingsOverrides {
  const { forkTargetBranch: _replaced, ...rest } = merged;
  const value = Object.hasOwn(incoming, "forkTargetBranch")
    ? incoming.forkTargetBranch
    : stored?.forkTargetBranch;
  return value ? { ...rest, forkTargetBranch: value } : rest;
}

/** Fork: an omitted key is kept by the server, so clearing `forkTargetBranch` must send `""`. */
export function markForkTargetBranchCleared(
  current: ProjectSettingsOverrides,
  next: ProjectSettingsOverrides,
  keys: readonly ProjectScopedServerSettingKey[],
): ProjectSettingsOverrides {
  return keys.includes("forkTargetBranch") && current.forkTargetBranch !== undefined
    ? { ...next, forkTargetBranch: "" }
    : next;
}
