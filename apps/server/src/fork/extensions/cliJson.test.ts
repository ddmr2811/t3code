import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { decodeClaudePluginList, decodeCodexMcpList } from "./cliJson.ts";

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
      '[{"id":"cloudflare@claude-plugins","version":"1.0.0","scope":"user","enabled":true,"installPath":"C:/p"}]',
    );
    assert.deepStrictEqual(plugins, [
      { id: "cloudflare@claude-plugins", enabled: true, scope: "user", installPath: "C:/p" },
    ]);
  }),
);
