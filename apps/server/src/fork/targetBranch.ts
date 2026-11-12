import type { ProjectId, ServerSettings } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { Effect } from "effect";

import type { GitVcsDriver } from "../vcs/GitVcsDriver.ts";

/** Version of the target-branch capability announced to clients. */
export const FORK_TARGET_BRANCH_PROTOCOL_VERSION = 1;

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

/** Motivo por el que el auto pull no actúa sobre una carpeta; null si puede actuar. */
export function forkAutoPullSkipReason(
  status: {
    readonly isRepo: boolean;
    readonly branch: string | null;
    readonly isDefaultBranch: boolean;
    readonly hasUpstream: boolean;
    readonly hasWorkingTreeChanges: boolean;
    readonly aheadCount: number;
  },
  targetBranch: string | null,
): string | null {
  if (!status.isRepo) return "not-a-repository";
  if (
    !isForkAutoPullBranch({
      branch: status.branch,
      isDefaultBranch: status.isDefaultBranch,
      targetBranch,
    })
  ) {
    return targetBranch === null ? "not-on-default-branch" : "not-on-target-branch";
  }
  if (!status.hasUpstream) return "no-upstream";
  if (status.hasWorkingTreeChanges) return "working-tree-changes";
  if (status.aheadCount > 0) return "local-commits";
  return null;
}

/** La rama de destino como base de un PR, si no es la propia cabeza y existe en el remoto principal. */
export const forkPrBaseOnRemote = Effect.fn("forkPrBaseOnRemote")(function* (
  gitCore: Pick<GitVcsDriver["Service"], "resolvePrimaryRemoteName" | "remoteBranchExists">,
  input: {
    readonly cwd: string;
    readonly headBranch: string;
    readonly targetBranch: string | null;
  },
) {
  const candidate = forkPrBaseCandidate(input);
  if (candidate === null) return null;
  const exists = yield* gitCore.resolvePrimaryRemoteName(input.cwd).pipe(
    Effect.flatMap((remoteName) =>
      gitCore.remoteBranchExists({ cwd: input.cwd, remoteName, refName: candidate }),
    ),
    Effect.orElseSucceed(() => false),
  );
  return exists ? candidate : null;
});
