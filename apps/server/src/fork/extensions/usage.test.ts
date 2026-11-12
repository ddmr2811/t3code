import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ServerConfig } from "../../config.ts";
import { mcpToolPrefix } from "./claudeMcpList.ts";
import {
  makeMutableTally,
  scanUsage,
  tallyClaudeTranscriptLine,
  tallyCodexSessionLine,
  usageKeyForMcp,
} from "./usage.ts";

const claudeLine = (timestamp: string, ...blocks: ReadonlyArray<object>) =>
  JSON.stringify({ type: "assistant", timestamp, message: { role: "assistant", content: blocks } });

const mcpUse = (name: string) => ({ type: "tool_use", id: "t1", name, input: {} });
const skillUse = (skill: string) => ({
  type: "tool_use",
  id: "t2",
  name: "Skill",
  input: { skill },
});

// Shape of a real Codex MCP call: payload.namespace is `mcp__<server>`, payload.name the tool.
const codexLine = (timestamp: string, namespace: string, name: string) =>
  JSON.stringify({
    timestamp,
    ordinal: 7,
    type: "response_item",
    payload: { type: "function_call", status: "completed", name, namespace, arguments: "{}" },
  });

describe("tallyClaudeTranscriptLine", () => {
  it("counts an MCP tool_use under its server prefix with the record timestamp", () => {
    const tally = makeMutableTally();
    tallyClaudeTranscriptLine(
      claudeLine("2026-11-01T10:00:00.000Z", mcpUse("mcp__claude_ai_Supabase__execute_sql")),
      tally,
    );
    expect(tally.mcp.get("mcp__claude_ai_Supabase__")).toEqual({
      count: 1,
      lastUsedAt: "2026-11-01T10:00:00.000Z",
    });
    expect(tally.skills.size).toBe(0);
  });

  it("counts Skill tool_use by skill name and keeps the latest timestamp", () => {
    const tally = makeMutableTally();
    tallyClaudeTranscriptLine(
      claudeLine("2026-11-02T00:00:00.000Z", skillUse("superpowers:brainstorming")),
      tally,
    );
    tallyClaudeTranscriptLine(
      claudeLine("2026-11-01T00:00:00.000Z", skillUse("superpowers:brainstorming")),
      tally,
    );
    expect(tally.skills.get("superpowers:brainstorming")).toEqual({
      count: 2,
      lastUsedAt: "2026-11-02T00:00:00.000Z",
    });
  });

  it("matches sanitised names such as 'claude.ai MCP Gestion/Patricia' via mcpToolPrefix", () => {
    const tally = makeMutableTally();
    tallyClaudeTranscriptLine(
      claudeLine("2026-11-01T00:00:00.000Z", mcpUse("mcp__claude_ai_MCP_Gestion_Patricia__list")),
      tally,
    );
    expect(tally.mcp.get(mcpToolPrefix("claude.ai MCP Gestion/Patricia"))?.count).toBe(1);
    expect(usageKeyForMcp("claude", "claude.ai MCP Gestion/Patricia")).toBe(
      "mcp__claude_ai_MCP_Gestion_Patricia__",
    );
  });

  it("ignores malformed lines, other tools and text blocks", () => {
    const tally = makeMutableTally();
    tallyClaudeTranscriptLine("{not json tool_use", tally);
    tallyClaudeTranscriptLine("", tally);
    tallyClaudeTranscriptLine(
      claudeLine("2026-11-01T00:00:00.000Z", { type: "text", text: "mcp__x__y" }, mcpUse("Bash")),
      tally,
    );
    tallyClaudeTranscriptLine(
      claudeLine("2026-11-01T00:00:00.000Z", { type: "tool_use", name: "Skill", input: {} }),
      tally,
    );
    expect(tally.mcp.size).toBe(0);
    expect(tally.skills.size).toBe(0);
  });
});

describe("tallyCodexSessionLine", () => {
  it("counts a function_call by its mcp__<server> namespace", () => {
    const tally = makeMutableTally();
    tallyCodexSessionLine(
      codexLine("2026-11-03T00:00:00.000Z", "mcp__t3_code", "html_preview"),
      tally,
    );
    expect(tally.mcp.get("mcp__t3_code__")).toEqual({
      count: 1,
      lastUsedAt: "2026-11-03T00:00:00.000Z",
    });
    expect(usageKeyForMcp("codex", "t3-code")).toBe("mcp__t3-code__");
    expect(usageKeyForMcp("codex", "t3 code")).toBe("mcp__t3_code__");
  });

  it("ignores non-MCP function calls and malformed lines", () => {
    const tally = makeMutableTally();
    tallyCodexSessionLine(
      codexLine("2026-11-03T00:00:00.000Z", "functions", "exec_command"),
      tally,
    );
    tallyCodexSessionLine("nope function_call", tally);
    expect(tally.mcp.size).toBe(0);
  });
});

describe("scanUsage", () => {
  const withEnv = <A, E, R>(
    body: (input: {
      readonly fs: FileSystem.FileSystem;
      readonly path: Path.Path;
      readonly home: string;
      readonly baseDir: string;
      readonly reads: { count: number };
    }) => Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-usage-home-" });
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-usage-base-" });
      const reads = { count: 0 };
      const countingFs = FileSystem.FileSystem.of({
        ...fs,
        stream: (...args: Parameters<FileSystem.FileSystem["stream"]>) => {
          reads.count += 1;
          return fs.stream(...args);
        },
      });
      return yield* body({ fs, path, home, baseDir, reads }).pipe(
        Effect.provide(
          ServerConfig.layerTest(home, baseDir).pipe(
            Layer.provideMerge(Layer.succeed(FileSystem.FileSystem, countingFs)),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

  const writeTranscript = (
    fs: FileSystem.FileSystem,
    path: Path.Path,
    home: string,
    name: string,
    lines: ReadonlyArray<string>,
  ) =>
    Effect.gen(function* () {
      const dir = path.join(home, ".claude", "projects", "proj");
      yield* fs.makeDirectory(dir, { recursive: true });
      const file = path.join(dir, name);
      yield* fs.writeFileString(file, lines.join("\n") + "\n");
      return file;
    });

  it.effect("counts, caches, and only re-reads files whose mtime or size changed", () =>
    withEnv(({ fs, path, home, reads }) =>
      Effect.gen(function* () {
        const file = yield* writeTranscript(fs, path, home, "a.jsonl", [
          claudeLine("2026-11-01T00:00:00.000Z", mcpUse("mcp__claude_ai_Supabase__execute_sql")),
          "garbage line with tool_use",
          claudeLine("2026-11-02T00:00:00.000Z", skillUse("superpowers:brainstorming")),
        ]);
        yield* writeTranscript(fs, path, home, "b.jsonl", [
          claudeLine("2026-11-03T00:00:00.000Z", mcpUse("mcp__claude_ai_Supabase__list_tables")),
        ]);

        const first = yield* scanUsage("claude", home);
        expect(first.mcp.get("mcp__claude_ai_Supabase__")).toEqual({
          count: 2,
          lastUsedAt: "2026-11-03T00:00:00.000Z",
        });
        expect(first.skills.get("superpowers:brainstorming")?.count).toBe(1);
        expect(reads.count).toBe(2);

        const second = yield* scanUsage("claude", home);
        expect(reads.count).toBe(2);
        expect(second.mcp.get("mcp__claude_ai_Supabase__")?.count).toBe(2);

        // Append a use: size changes, so only that file is re-read.
        yield* fs.writeFileString(
          file,
          [
            claudeLine("2026-11-01T00:00:00.000Z", mcpUse("mcp__claude_ai_Supabase__execute_sql")),
            claudeLine("2026-11-04T00:00:00.000Z", mcpUse("mcp__claude_ai_Supabase__execute_sql")),
          ].join("\n") + "\n",
        );
        const third = yield* scanUsage("claude", home);
        expect(reads.count).toBe(3);
        expect(third.mcp.get("mcp__claude_ai_Supabase__")).toEqual({
          count: 3,
          lastUsedAt: "2026-11-04T00:00:00.000Z",
        });
        expect(third.skills.size).toBe(0);
      }),
    ),
  );

  it.effect("re-reads a file whose mtime changed with the same size", () =>
    withEnv(({ fs, path, home, reads }) =>
      Effect.gen(function* () {
        const file = yield* writeTranscript(fs, path, home, "a.jsonl", [
          claudeLine("2026-11-01T00:00:00.000Z", mcpUse("mcp__x__t")),
        ]);
        yield* scanUsage("claude", home);
        yield* fs.utimes(file, 1_900_000_000, 1_900_000_000);
        yield* scanUsage("claude", home);
        expect(reads.count).toBe(2);
      }),
    ),
  );

  it.effect(
    "scans Codex sessions and survives a corrupt or missing cache and missing folders",
    () =>
      withEnv(({ fs, path, home, baseDir }) =>
        Effect.gen(function* () {
          expect((yield* scanUsage("codex", home)).mcp.size).toBe(0);
          const dir = path.join(home, ".codex", "sessions", "2026", "11", "03");
          yield* fs.makeDirectory(dir, { recursive: true });
          yield* fs.writeFileString(
            path.join(dir, "rollout.jsonl"),
            codexLine("2026-11-03T00:00:00.000Z", "mcp__t3_code", "html_preview") + "\n",
          );
          yield* fs.makeDirectory(path.join(baseDir, "fork-extensions"), { recursive: true });
          yield* fs.writeFileString(
            path.join(baseDir, "fork-extensions", "usage-cache.json"),
            "{{",
          );
          const tally = yield* scanUsage("codex", home);
          expect(tally.mcp.get(usageKeyForMcp("codex", "t3_code"))?.count).toBe(1);
          const cache = yield* fs.readFileString(
            path.join(baseDir, "fork-extensions", "usage-cache.json"),
          );
          expect(JSON.parse(cache).version).toBe(1);
        }),
      ),
  );
});
