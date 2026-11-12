import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { codexNeedsLogin, decodeClaudePluginList, decodeCodexMcpList } from "./cliJson.ts";

it.effect("decodeCodexMcpList keeps transport", () =>
  Effect.gen(function* () {
    const servers = yield* decodeCodexMcpList(
      '[{"name":"codex_app","enabled":false,"disabled_reason":null,"transport":{"type":"stdio","command":"cmd.exe","args":["/d"]}}]',
    );
    assert.deepStrictEqual(servers, [
      {
        name: "codex_app",
        enabled: false,
        transport: { type: "stdio", command: "cmd.exe", args: ["/d"] },
      },
    ]);
  }),
);

it.effect("decodeCodexMcpList reads auth_status; not logged in needs a login", () =>
  Effect.gen(function* () {
    // `unsupported` is what codex prints for stdio servers; the remote values are the ones the
    // codex binary carries (camelCase), with the snake_case spelling accepted too.
    const servers = yield* decodeCodexMcpList(
      JSON.stringify([
        { name: "a", enabled: true, auth_status: "unsupported", transport: { type: "stdio" } },
        {
          name: "b",
          enabled: true,
          auth_status: "notLoggedIn",
          transport: { type: "streamable_http", url: "https://b" },
        },
        {
          name: "c",
          enabled: true,
          auth_status: "not_logged_in",
          transport: { type: "streamable_http", url: "https://c" },
        },
        {
          name: "d",
          enabled: true,
          auth_status: "oAuth",
          transport: { type: "streamable_http", url: "https://d" },
        },
        { name: "e", enabled: true, transport: { type: "stdio" } },
      ]),
    );
    assert.strictEqual(servers[1]!.authStatus, "notLoggedIn");
    assert.deepStrictEqual(servers.map(codexNeedsLogin), [false, true, true, false, false]);
  }),
);

it.effect("decodeCodexMcpList fails with ForkExtensionsError on bad output", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(decodeCodexMcpList("  oops  "));
    assert.isTrue(Exit.isFailure(exit));
    const error = yield* decodeCodexMcpList("  oops  ").pipe(Effect.flip);
    assert.strictEqual(error._tag, "ForkExtensionsError");
    assert.strictEqual(error.problem.rawOutput, "oops");
  }),
);

it.effect("decodeClaudePluginList decodes the plugin list", () =>
  Effect.gen(function* () {
    const plugins = yield* decodeClaudePluginList(
      '[{"id":"cloudflare@claude-plugins","version":"1.0.0","scope":"user","enabled":true,"installPath":"C:/p","mcpServers":{"cloudflare":{"type":"http","url":"https://mcp.cloudflare.com/mcp"}}},' +
        '{"id":"superpowers@claude-plugins","scope":"user","enabled":false,"installPath":"C:/s"}]',
    );
    assert.deepStrictEqual(plugins, [
      {
        id: "cloudflare@claude-plugins",
        enabled: true,
        scope: "user",
        installPath: "C:/p",
        mcpServers: { cloudflare: { type: "http", url: "https://mcp.cloudflare.com/mcp" } },
      },
      { id: "superpowers@claude-plugins", enabled: false, scope: "user", installPath: "C:/s" },
    ]);
  }),
);
