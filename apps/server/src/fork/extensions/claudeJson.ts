import { ForkExtensionsError } from "@t3tools/contracts";

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

const invalidConfig = () =>
  new ForkExtensionsError({
    problem: {
      reason: "invalidInput",
      summary: "~/.claude.json is not a valid JSON object, so it was left untouched.",
      nextStep: "Fix or restore ~/.claude.json, then try again.",
      rawOutput: null,
    },
  });

/** Strict root parse for writes: empty text is a fresh object, anything else must be a JSON object. */
const parseRootStrict = (text: string): Record<string, unknown> => {
  if (text.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalidConfig();
  }
  if (!isRecord(parsed)) throw invalidConfig();
  return parsed;
};

/**
 * Changes only `projects[projectPath][CLAUDE_PROJECT_DISABLED_KEY]`; keeps the rest, 2-space indent. */
export const setClaudeProjectDisabled = (
  text: string,
  projectPath: string,
  serverName: string,
  disabled: boolean,
): string => {
  const root = parseRootStrict(text);
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
  // Known limit: JSON.parse/stringify loses precision for integers beyond 2^53.
  const output = JSON.stringify(
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
  return text.endsWith("\n") ? `${output}\n` : output;
};
