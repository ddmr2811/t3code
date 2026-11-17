// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

// Spawned processes lack shell expansion and would treat literal ~/ paths as relative.
export function expandHomePath(value: string, home: string): string {
  if (!value) return value;
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return NodePath.join(home, value.slice(2));
  }
  return value;
}

/**
 * A configured provider home with `~` expanded. Any other relative path resolves from the
 * user's home, never the server's cwd, so T3 and the spawned CLI read the same folder.
 */
export function resolveAbsoluteHomePath(value: string, home: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? NodePath.resolve(home, expandHomePath(trimmed, home)) : undefined;
}

const HOME_PATH_VARIABLES = new Set(["CODEX_HOME", "CLAUDE_CONFIG_DIR", "GROK_HOME"]);

export function expandHomeVariable(name: string, value: string, home: string): string {
  if (!HOME_PATH_VARIABLES.has(name)) return value;
  return resolveAbsoluteHomePath(value, home) ?? value;
}
