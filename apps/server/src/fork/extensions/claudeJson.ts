export interface ClaudeJsonProject {
  readonly path: string;
  readonly servers: Record<string, unknown>;
  readonly disabled: ReadonlyArray<string>;
}

export interface ClaudeJsonView {
  readonly userServers: Record<string, unknown>;
  readonly projects: ReadonlyArray<ClaudeJsonProject>;
  readonly claudeAiConnectors: ReadonlyArray<string>;
}

/**
 * Per-project "off" list for MCP servers in ~/.claude.json `projects[<path>]`.
 * Confirmed by inspecting the bundled Claude Code binary (`disabledMcpServers`).
 */
export const CLAUDE_PROJECT_DISABLED_KEY = "disabledMcpServers";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseRoot = (text: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const stringArray = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

export const readClaudeJson = (text: string): ClaudeJsonView => {
  const root = parseRoot(text);
  const projects = isRecord(root.projects) ? root.projects : {};
  return {
    userServers: isRecord(root.mcpServers) ? root.mcpServers : {},
    projects: Object.entries(projects).flatMap(([path, value]) =>
      isRecord(value)
        ? [
            {
              path,
              servers: isRecord(value.mcpServers) ? value.mcpServers : {},
              disabled: stringArray(value[CLAUDE_PROJECT_DISABLED_KEY]),
            },
          ]
        : [],
    ),
    claudeAiConnectors: stringArray(root.claudeAiMcpEverConnected),
  };
};

/** Changes only `projects[projectPath][CLAUDE_PROJECT_DISABLED_KEY]`; keeps the rest, 2-space indent. */
export const setClaudeProjectDisabled = (
  text: string,
  projectPath: string,
  serverName: string,
  disabled: boolean,
): string => {
  const root = parseRoot(text);
  const projects = isRecord(root.projects) ? root.projects : {};
  const project = isRecord(projects[projectPath]) ? projects[projectPath] : {};
  const current = stringArray(project[CLAUDE_PROJECT_DISABLED_KEY]);
  const has = current.includes(serverName);
  if (has === disabled && isRecord(projects[projectPath])) return text;
  const next = disabled
    ? has
      ? current
      : [...current, serverName]
    : current.filter((name) => name !== serverName);
  return JSON.stringify(
    {
      ...root,
      projects: {
        ...projects,
        [projectPath]: { ...project, [CLAUDE_PROJECT_DISABLED_KEY]: next },
      },
    },
    null,
    2,
  );
};
