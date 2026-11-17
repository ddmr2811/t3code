// `/`, `~`, `~/` or `~\`, a drive letter with a separator, or a UNC share.
const ABSOLUTE_PATH = /^(?:\/|~(?:$|[\\/])|[A-Za-z]:[\\/]|\\\\)/;

/** The server ignores a relative directory: it would resolve against the server's own cwd. */
export function relativePathWarning(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length === 0 || ABSOLUTE_PATH.test(trimmed)
    ? undefined
    : "Use an absolute path, or ~ for your home folder.";
}
