export interface ClaudeMcpListEntry {
  readonly name: string;
  readonly target: string;
  readonly state: "working" | "needsAttention" | "failed";
  readonly detail: string;
}

const STATUS_SEPARATOR = " - ";

/** Tool-name prefix Claude Code gives to every tool of an MCP server. */
export const mcpToolPrefix = (serverName: string): string =>
  "mcp__" + serverName.replace(/[^A-Za-z0-9_-]/g, "_") + "__";

const classifyStatus = (status: string): Pick<ClaudeMcpListEntry, "state" | "detail"> => {
  const detail = status.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  if (status.startsWith("✔")) return { state: "working", detail };
  if (status.startsWith("!")) return { state: "needsAttention", detail };
  return { state: "failed", detail };
};

/**
 * Parses `claude mcp list` lines of the form `<name>: <target> - <status>`.
 * Names may contain ":" and "/", so split on the LAST " - " and on the FIRST ": "
 * that precedes a URL (falling back to the first ": ").
 */
export const parseClaudeMcpList = (stdout: string): ReadonlyArray<ClaudeMcpListEntry> => {
  const entries: ClaudeMcpListEntry[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const statusAt = line.lastIndexOf(STATUS_SEPARATOR);
    if (statusAt < 0) continue;
    const head = line.slice(0, statusAt);
    const status = line.slice(statusAt + STATUS_SEPARATOR.length);
    const urlSplit = head.search(/: (?=https?:\/\/)/);
    const splitAt = urlSplit >= 0 ? urlSplit : head.indexOf(": ");
    if (splitAt <= 0) continue;
    entries.push({
      name: head.slice(0, splitAt),
      target: head.slice(splitAt + 2),
      ...classifyStatus(status),
    });
  }
  return entries;
};
