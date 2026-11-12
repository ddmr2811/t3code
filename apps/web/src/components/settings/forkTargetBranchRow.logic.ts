/** Names of the environments in scope whose server does not announce the target-branch capability. */
export function environmentsWithoutForkTargetBranch(
  environments: ReadonlyArray<{
    readonly label: string;
    readonly capabilities: { readonly forkTargetBranch?: number } | undefined;
  }>,
): ReadonlyArray<string> {
  return environments
    .filter((environment) => environment.capabilities?.forkTargetBranch === undefined)
    .map((environment) => environment.label);
}
