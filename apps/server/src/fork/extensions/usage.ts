import type { ForkExtensionAgent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { mcpToolPrefix } from "./claudeMcpList.ts";
import { readWithFingerprint, writeIfUnchanged } from "./safeFileEdit.ts";

export interface UsageEntry {
  readonly count: number;
  readonly lastUsedAt: string | null;
}

export interface UsageTally {
  /** Keyed by tool prefix, e.g. `mcp__claude_ai_Supabase__`. */
  readonly mcp: ReadonlyMap<string, UsageEntry>;
  /** Keyed by skill name, e.g. `superpowers:brainstorming`. */
  readonly skills: ReadonlyMap<string, UsageEntry>;
}

export interface MutableTally {
  readonly mcp: Map<string, UsageEntry>;
  readonly skills: Map<string, UsageEntry>;
}

export const makeMutableTally = (): MutableTally => ({ mcp: new Map(), skills: new Map() });

/** Same bound as AgentSessionScanner. */
const MAX_FILES_PER_AGENT = 5000;
/** Lines longer than this are skipped rather than parsed. */
const MAX_LINE_CHARS = 16 * 1024 * 1024;
const CACHE_VERSION = 1;

const bump = (map: Map<string, UsageEntry>, key: string, timestamp: string | null) => {
  const previous = map.get(key);
  const lastUsedAt =
    timestamp !== null && (previous?.lastUsedAt == null || timestamp > previous.lastUsedAt)
      ? timestamp
      : (previous?.lastUsedAt ?? null);
  map.set(key, { count: (previous?.count ?? 0) + 1, lastUsedAt });
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const parseLine = (line: string, needle: string): Record<string, unknown> | null => {
  if (line.length > MAX_LINE_CHARS || !line.includes(needle)) return null;
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return null;
  }
};

/** `mcp__server__tool` -> `mcp__server__`; null when the name has no tool part. */
const prefixOfMcpName = (name: string): string | null => {
  if (!name.startsWith("mcp__")) return null;
  const end = name.indexOf("__", "mcp__".length);
  return end === -1 ? null : name.slice(0, end + 2);
};

/** Counts `tool_use` blocks of one Claude transcript record. Malformed lines are ignored. */
export const tallyClaudeTranscriptLine = (line: string, into: MutableTally): void => {
  const record = parseLine(line, '"tool_use"');
  const content = asRecord(record?.message)?.content;
  if (record === null || !Array.isArray(content)) return;
  const timestamp = typeof record.timestamp === "string" ? record.timestamp : null;
  for (const raw of content) {
    const block = asRecord(raw);
    if (block === null || block.type !== "tool_use" || typeof block.name !== "string") continue;
    const prefix = prefixOfMcpName(block.name);
    if (prefix !== null) {
      bump(into.mcp, prefix, timestamp);
    } else if (block.name === "Skill") {
      const skill = asRecord(block.input)?.skill;
      if (typeof skill === "string" && skill !== "") bump(into.skills, skill, timestamp);
    }
  }
};

/**
 * Codex records an MCP call as a `response_item` whose payload is
 * `{ type: "function_call", namespace: "mcp__<server>", name: "<tool>" }`.
 * Codex has no skill tool, so only MCP calls are counted.
 */
export const tallyCodexSessionLine = (line: string, into: MutableTally): void => {
  const record = parseLine(line, '"function_call"');
  const payload = asRecord(record?.payload);
  if (record === null || payload === null || payload.type !== "function_call") return;
  const namespace = typeof payload.namespace === "string" ? payload.namespace : "";
  const name = typeof payload.name === "string" ? payload.name : "";
  const prefix =
    prefixOfMcpName(namespace.endsWith("__") ? namespace : `${namespace}__`) ??
    prefixOfMcpName(name);
  if (prefix === null) return;
  bump(into.mcp, prefix, typeof record.timestamp === "string" ? record.timestamp : null);
};

/** The key `scanUsage(agent)` uses for a configured MCP server of this agent. */
export const usageKeyForMcp = (agent: ForkExtensionAgent, serverName: string): string =>
  // Claude keeps "-" in tool names; Codex turns every character outside [A-Za-z0-9_] (including "-")
  // into "_" in its `mcp__<server>` namespace (server `t3-code` -> `mcp__t3_code`).
  agent === "claude"
    ? mcpToolPrefix(serverName)
    : "mcp__" + serverName.replace(/[^A-Za-z0-9_]/g, "_") + "__";

interface FileEntry {
  readonly size: number;
  readonly mtimeMs: number;
  readonly mcp: ReadonlyArray<readonly [string, UsageEntry]>;
  readonly skills: ReadonlyArray<readonly [string, UsageEntry]>;
}
type UsageCacheData = Record<string, Record<string, FileEntry>>;

const parseCache = (text: string): UsageCacheData => {
  try {
    const parsed = asRecord(JSON.parse(text));
    const agents = asRecord(parsed?.agents);
    return parsed?.version === CACHE_VERSION && agents !== null ? (agents as UsageCacheData) : {};
  } catch {
    return {};
  }
};

const serializeCache = (agents: UsageCacheData): string =>
  JSON.stringify({ version: CACHE_VERSION, agents });

const isFileEntry = (value: unknown): value is FileEntry => {
  const entry = asRecord(value);
  return (
    entry !== null &&
    typeof entry.size === "number" &&
    typeof entry.mtimeMs === "number" &&
    Array.isArray(entry.mcp) &&
    Array.isArray(entry.skills)
  );
};

const merge = (target: MutableTally, entry: FileEntry) => {
  for (const [source, destination] of [
    [entry.mcp, target.mcp],
    [entry.skills, target.skills],
  ] as const) {
    for (const [key, value] of source) {
      const previous = destination.get(key);
      const last = [previous?.lastUsedAt, value.lastUsedAt]
        .filter((v): v is string => typeof v === "string")
        .toSorted()
        .at(-1);
      destination.set(key, {
        count: (previous?.count ?? 0) + value.count,
        lastUsedAt: last ?? null,
      });
    }
  }
};

/**
 * Counts MCP and skill usage in the agent's transcripts, re-reading only files whose
 * size or mtime changed since the last scan (cache: `<baseDir>/fork-extensions/usage-cache.json`).
 * Unreadable folders, files and cache contents degrade to "no usage"; the scan never fails.
 */
export const scanUsage = Effect.fn("ForkExtensions.scanUsage")(function* (
  agent: ForkExtensionAgent,
  home: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { baseDir } = yield* ServerConfig;
  const cachePath = path.join(baseDir, "fork-extensions", "usage-cache.json");
  const tallyLine = agent === "claude" ? tallyClaudeTranscriptLine : tallyCodexSessionLine;

  const root =
    agent === "claude"
      ? path.join(home, ".claude", "projects")
      : path.join(home, ".codex", "sessions");
  const relative = yield* fs
    .readDirectory(root, { recursive: true })
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const stats = yield* Effect.forEach(
    relative.filter((name) => name.endsWith(".jsonl")),
    (name) =>
      fs.stat(path.join(root, name)).pipe(
        Effect.map((info) =>
          info.type === "File"
            ? Option.some({
                file: path.join(root, name),
                size: Number(info.size),
                mtimeMs: Option.match(info.mtime, { onNone: () => 0, onSome: (d) => d.getTime() }),
              })
            : Option.none(),
        ),
        Effect.orElseSucceed(Option.none),
      ),
    { concurrency: 16 },
  );
  const files = stats
    .flatMap((entry) => (Option.isSome(entry) ? [entry.value] : []))
    .toSorted((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_FILES_PER_AGENT);

  const snapshot = yield* readWithFingerprint(cachePath).pipe(
    Effect.orElseSucceed(() => ({ text: "", fingerprint: "absent" })),
  );
  const allAgents = parseCache(snapshot.text);
  const previous = allAgents[agent] ?? {};

  const nextFiles: Record<string, FileEntry> = {};
  const total = makeMutableTally();
  let changed = false;
  for (const file of files) {
    const cached = previous[file.file];
    if (isFileEntry(cached) && cached.size === file.size && cached.mtimeMs === file.mtimeMs) {
      nextFiles[file.file] = cached;
      merge(total, cached);
      continue;
    }
    changed = true;
    const local = makeMutableTally();
    yield* fs.stream(file.file).pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) => Effect.sync(() => tallyLine(line, local))),
      // An unreadable file counts as empty; it is retried when its size/mtime changes.
      Effect.ignore,
    );
    const entry: FileEntry = {
      size: file.size,
      mtimeMs: file.mtimeMs,
      mcp: [...local.mcp],
      skills: [...local.skills],
    };
    nextFiles[file.file] = entry;
    merge(total, entry);
  }

  if (changed || Object.keys(previous).length !== files.length) {
    allAgents[agent] = nextFiles;
    // A configChanged here only means another scan wrote the cache; the next scan recomputes.
    yield* writeIfUnchanged(
      cachePath,
      snapshot.fingerprint,
      serializeCache(allAgents),
      () => true,
    ).pipe(Effect.ignore);
  }
  return total satisfies UsageTally;
});
