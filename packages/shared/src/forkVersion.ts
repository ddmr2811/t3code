/**
 * Fork desktop builds are numbered x.y.(z*100+n) so the updater moves forward, and record the
 * upstream release x.y.z they are built on (fork-desktop-windows.yml). What this app asks of
 * upstream, such as a server update or its SSH runtime, names that release. Other builds record
 * none, and their base is their own version.
 */
export function resolveBaseVersion(
  appVersion: string,
  buildBaseVersion: string | undefined,
): string {
  return buildBaseVersion?.trim() || appVersion;
}
