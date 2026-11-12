import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as TestClock from "effect/testing/TestClock";

import { classifyPastedText, resolveGithubRepo } from "./pasteSource.ts";

const winExe = String.raw`C:\Program Files\x\server.exe`;
const repo = (
  owner: string,
  name: string,
  path: string | null = null,
  ref: string | null = null,
) => ({
  _tag: "githubRepo",
  owner,
  repo: name,
  path,
  ref,
});

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
      "https://x.com/mcp?key=1",
      { _tag: "mcpRemote", url: "https://x.com/mcp?key=1", transport: "http", suggestedName: "x" },
    ],
    [
      "https://x.com/sse?key=1",
      { _tag: "mcpRemote", url: "https://x.com/sse?key=1", transport: "sse", suggestedName: "x" },
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
      "npx -y some-pkg",
      { _tag: "mcpCommand", command: "npx", args: ["-y", "some-pkg"], suggestedName: "some-pkg" },
    ],
    [
      "uvx mcp-server-git",
      { _tag: "mcpCommand", command: "uvx", args: ["mcp-server-git"], suggestedName: "git" },
    ],
    [
      "node server.js",
      { _tag: "mcpCommand", command: "node", args: ["server.js"], suggestedName: "server" },
    ],
    [winExe, { _tag: "mcpCommand", command: winExe, args: [], suggestedName: "server" }],
    [
      `"${winExe}" --stdio`,
      { _tag: "mcpCommand", command: winExe, args: ["--stdio"], suggestedName: "server" },
    ],
    ["./x", { _tag: "mcpCommand", command: "./x", args: [], suggestedName: "x" }],
    ["o/x", repo("o", "x")],
    [
      "superpowers@claude-plugins-official",
      { _tag: "plugin", pluginRef: "superpowers@claude-plugins-official" },
    ],
    ["anthropics/skills", repo("anthropics", "skills")],
    ["o/r.git", repo("o", "r")],
    ["https://github.com/o/r.git", repo("o", "r")],
    ["https://github.com/o/r/tree/main/skills/pdf", repo("o", "r", "skills/pdf", "main")],
    ["https://github.com/anthropics", { _tag: "unknown" }],
    ["https://github.com/login", { _tag: "unknown" }],
    ["https://a.com/mcp --transport http", { _tag: "unknown" }],
    ["https://a.com/mcp\nsome text", { _tag: "unknown" }],
    ["python is great", { _tag: "unknown" }],
    ["npx is great", { _tag: "unknown" }],
    ["https://claude.ai/settings/connectors", { _tag: "claudeAiConnector" }],
    ["claude.ai", { _tag: "claudeAiConnector" }],
    ["hola", { _tag: "unknown" }],
  ];
  it.each(cases)("classifies %j", (input, expected) => {
    expect(classifyPastedText(input)).toEqual(expected);
  });
});

const requests: HttpClientRequest.HttpClientRequest[] = [];

const clientFor = (files: Record<string, unknown>, rawContent?: () => string) =>
  HttpClient.make((request) => {
    requests.push(request);
    const url = new URL(request.url);
    const file = decodeURIComponent(url.pathname.split("/contents/")[1] ?? "");
    const body = files[file];
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        body === undefined
          ? new Response("{}", { status: 404 })
          : Response.json({
              content: rawContent
                ? rawContent()
                : Buffer.from(JSON.stringify(body)).toString("base64"),
            }),
      ),
    );
  });

const statusClient = (status: number) =>
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status }))),
  );

const ref = { owner: "o", repo: "r", path: null, ref: null };
const run = (client: HttpClient.HttpClient, input = ref) =>
  resolveGithubRepo(input).pipe(Effect.provideService(HttpClient.HttpClient, client));

describe("resolveGithubRepo", () => {
  it.effect("detects a marketplace", () =>
    Effect.gen(function* () {
      const result = yield* run(
        clientFor({
          ".claude-plugin/marketplace.json": { plugins: [{ name: "a" }, { name: "b" }] },
        }),
      );
      expect(result).toEqual({ _tag: "marketplace", source: "o/r", plugins: ["a", "b"] });
    }),
  );
  it.effect("detects a plugin", () =>
    Effect.gen(function* () {
      const result = yield* run(clientFor({ ".claude-plugin/plugin.json": { name: "p" } }));
      expect(result).toEqual({ _tag: "plugin", pluginRef: "o/r" });
    }),
  );
  it.effect("detects a skill at a path and sends the ref, User-Agent and Accept", () =>
    Effect.gen(function* () {
      requests.length = 0;
      const result = yield* run(clientFor({ "skills/pdf/SKILL.md": { x: 1 } }), {
        ...ref,
        path: "skills/pdf",
        ref: "main",
      });
      expect(result).toEqual({ _tag: "skill", source: "o/r/skills/pdf", suggestedName: "pdf" });
      const last = requests.at(-1)!;
      expect(last.url).toBe(
        "https://api.github.com/repos/o/r/contents/skills/pdf/SKILL.md?ref=main",
      );
      expect(last.headers["user-agent"]).toBe("t3code-extensions");
      expect(last.headers["accept"]).toBe("application/vnd.github+json");
    }),
  );
  it.effect("decodes base64 content that GitHub wraps over several lines", () =>
    Effect.gen(function* () {
      const b64 = Buffer.from(JSON.stringify({ plugins: [{ name: "wrapped" }] })).toString(
        "base64",
      );
      const wrapped = b64.match(/.{1,10}/g)!.join("\n") + "\n";
      const result = yield* run(
        clientFor({ ".claude-plugin/marketplace.json": {} }, () => wrapped),
      );
      expect(result).toEqual({ _tag: "marketplace", source: "o/r", plugins: ["wrapped"] });
    }),
  );
  it.effect("treats an unparseable manifest as a marketplace without plugins", () =>
    Effect.gen(function* () {
      const result = yield* run(
        clientFor({ ".claude-plugin/marketplace.json": {} }, () =>
          Buffer.from("not json").toString("base64"),
        ),
      );
      expect(result).toEqual({ _tag: "marketplace", source: "o/r", plugins: [] });
    }),
  );
  it.effect("returns unknown when nothing matches", () =>
    Effect.gen(function* () {
      expect(yield* run(clientFor({}))).toEqual({ _tag: "unknown" });
    }),
  );
  it.effect.each([
    [403, "rate limiting"],
    [429, "rate limiting"],
    [500, "status 500"],
    [503, "status 503"],
  ] as const)("maps status %s to commandFailed", ([status, text]) =>
    Effect.gen(function* () {
      const error = yield* run(statusClient(status)).pipe(Effect.flip);
      expect(error.problem.reason).toBe("commandFailed");
      expect(error.problem.summary).toContain(text);
      expect(error.problem.nextStep).toContain("try again later");
    }),
  );
  it.effect("maps a network failure to commandFailed", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request }),
          }),
        ),
      );
      const error = yield* run(client).pipe(Effect.flip);
      expect(error.problem.reason).toBe("commandFailed");
      expect(error.problem.summary).toBe("Couldn't reach GitHub.");
    }),
  );
  it.effect("maps an invalid JSON answer to commandFailed", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response("<html>", { status: 200 })),
        ),
      );
      const error = yield* run(client).pipe(Effect.flip);
      expect(error.problem.reason).toBe("commandFailed");
      expect(error.problem.summary).toBe("GitHub sent an unreadable answer.");
    }),
  );
  it.effect("times out after 10 seconds with reason timeout", () =>
    Effect.gen(function* () {
      const fiber = yield* run(HttpClient.make(() => Effect.never)).pipe(
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust("10 seconds");
      const error = yield* Fiber.join(fiber);
      expect(error.problem.reason).toBe("timeout");
      expect(error.problem.summary).toBe("GitHub didn't answer in time.");
      expect(error.problem.nextStep).toBe("Check your connection and try again.");
    }),
  );
});
