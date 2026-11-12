import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { classifyPastedText, resolveGithubRepo } from "./pasteSource.ts";

describe("classifyPastedText", () => {
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    [
      "https://mcp.notion.com/mcp",
      {
        _tag: "mcpRemote",
        url: "https://mcp.notion.com/mcp",
        transport: "http",
        suggestedName: "notion",
      },
    ],
    [
      "https://x.example.com/mcp/sse",
      {
        _tag: "mcpRemote",
        url: "https://x.example.com/mcp/sse",
        transport: "sse",
        suggestedName: "example",
      },
    ],
    [
      "npx @playwright/mcp@latest",
      {
        _tag: "mcpCommand",
        command: "npx",
        args: ["@playwright/mcp@latest"],
        suggestedName: "playwright",
      },
    ],
    [
      "uvx mcp-server-git",
      { _tag: "mcpCommand", command: "uvx", args: ["mcp-server-git"], suggestedName: "git" },
    ],
    [
      "superpowers@claude-plugins-official",
      { _tag: "plugin", pluginRef: "superpowers@claude-plugins-official" },
    ],
    [
      "anthropics/skills",
      { _tag: "githubRepo", owner: "anthropics", repo: "skills", path: null, ref: null },
    ],
    [
      "https://github.com/o/r/tree/main/skills/pdf",
      { _tag: "githubRepo", owner: "o", repo: "r", path: "skills/pdf", ref: "main" },
    ],
    ["https://claude.ai/settings/connectors", { _tag: "claudeAiConnector" }],
    ["claude.ai", { _tag: "claudeAiConnector" }],
    ["hola", { _tag: "unknown" }],
  ];
  it.each(cases)("classifies %s", (input, expected) => {
    expect(classifyPastedText(input)).toEqual(expected);
  });
});

const clientFor = (files: Record<string, unknown>) =>
  HttpClient.make((request) => {
    const url = new URL(request.url);
    const file = decodeURIComponent(url.pathname.split("/contents/")[1] ?? "");
    const body = files[file];
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        body === undefined
          ? new Response("{}", { status: 404 })
          : Response.json({ content: Buffer.from(JSON.stringify(body)).toString("base64") }),
      ),
    );
  });

const ref = { owner: "o", repo: "r", path: null, ref: null };

describe("resolveGithubRepo", () => {
  it.effect("detects a marketplace", () =>
    Effect.gen(function* () {
      const result = yield* resolveGithubRepo(ref).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          clientFor({
            ".claude-plugin/marketplace.json": { plugins: [{ name: "a" }, { name: "b" }] },
          }),
        ),
      );
      expect(result).toEqual({ _tag: "marketplace", source: "o/r", plugins: ["a", "b"] });
    }),
  );
  it.effect("detects a plugin", () =>
    Effect.gen(function* () {
      const result = yield* resolveGithubRepo(ref).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          clientFor({ ".claude-plugin/plugin.json": { name: "p" } }),
        ),
      );
      expect(result).toEqual({ _tag: "plugin", pluginRef: "o/r" });
    }),
  );
  it.effect("detects a skill at a path", () =>
    Effect.gen(function* () {
      const result = yield* resolveGithubRepo({ ...ref, path: "skills/pdf", ref: "main" }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          clientFor({ "skills/pdf/SKILL.md": { x: 1 } }),
        ),
      );
      expect(result).toEqual({ _tag: "skill", source: "o/r/skills/pdf", suggestedName: "pdf" });
    }),
  );
  it.effect("returns unknown when nothing matches", () =>
    Effect.gen(function* () {
      const result = yield* resolveGithubRepo(ref).pipe(
        Effect.provideService(HttpClient.HttpClient, clientFor({})),
      );
      expect(result).toEqual({ _tag: "unknown" });
    }),
  );
  it.effect("maps rate limiting to commandFailed", () =>
    Effect.gen(function* () {
      const error = yield* resolveGithubRepo(ref).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 403 }))),
          ),
        ),
        Effect.flip,
      );
      expect(error.problem.reason).toBe("commandFailed");
      expect(error.problem.nextStep).toContain("try again later");
    }),
  );
});
