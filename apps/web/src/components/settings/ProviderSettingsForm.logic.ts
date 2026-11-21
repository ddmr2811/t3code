import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";

// `/`, `~`, `~/` or `~\`, a drive letter with a separator, or a UNC share.
const ABSOLUTE_PATH = /^(?:\/|~(?:$|[\\/])|[A-Za-z]:[\\/]|\\\\)/;

/** The server resolves a relative directory from the user's home, which may not be what they meant. */
export function relativePathWarning(
  value: string,
  resolve: MessageResolver = m,
): string | undefined {
  const trimmed = value.trim();
  return trimmed.length === 0 || ABSOLUTE_PATH.test(trimmed)
    ? undefined
    : resolve(msg("Relative paths are taken from your home folder; use an absolute path or ~/…"));
}
