/**
 * Fork desktop builds are versioned x.y.(z*100+n) so the updater moves forward
 * (see .github/workflows/fork-desktop-windows.yml). Anything that names an
 * upstream release, or compares with an upstream-numbered server, needs x.y.z.
 */
export function forkBaseVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (match === null) return version;
  const [, major, minor, patch] = match;
  const patchNumber = Number(patch);
  if (patchNumber < 100) return version;
  return `${major}.${minor}.${Math.floor(patchNumber / 100)}`;
}
