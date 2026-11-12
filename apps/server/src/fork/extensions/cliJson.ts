import { ForkExtensionsError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export interface ClaudePluginListEntry {
  readonly id: string;
  readonly enabled: boolean;
  readonly scope: string;
  readonly installPath: string;
  /** Servers the plugin bundles; Claude names them `plugin:<plugin>:<server>`. */
  readonly mcpServers?: { readonly [name: string]: unknown } | undefined;
}

export interface CodexMcpListEntry {
  readonly name: string;
  readonly enabled: boolean;
  readonly transport: {
    readonly type: string;
    readonly command?: string | undefined;
    readonly args?: ReadonlyArray<string> | undefined;
    readonly url?: string | undefined;
  };
}

const ClaudePluginList = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      enabled: Schema.Boolean,
      scope: Schema.String,
      installPath: Schema.String,
      mcpServers: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
);

const CodexMcpList = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      name: Schema.String,
      enabled: Schema.Boolean,
      transport: Schema.Struct({
        type: Schema.String,
        command: Schema.optional(Schema.String),
        args: Schema.optional(Schema.Array(Schema.String)),
        url: Schema.optional(Schema.String),
      }),
    }),
  ),
);

const decodeFailure = (command: string, stdout: string) =>
  new ForkExtensionsError({
    problem: {
      reason: "commandFailed",
      summary: `Could not read the output of \`${command}\`.`,
      nextStep: "Update the CLI or run the command in a terminal to see what it prints.",
      rawOutput: stdout.trim(),
    },
  });

const decodePlugins = Schema.decodeEffect(ClaudePluginList);
const decodeCodexMcp = Schema.decodeEffect(CodexMcpList);

export const decodeClaudePluginList = (
  stdout: string,
): Effect.Effect<ReadonlyArray<ClaudePluginListEntry>, ForkExtensionsError> =>
  decodePlugins(stdout).pipe(
    Effect.mapError(() => decodeFailure("claude plugin list --json", stdout)),
  );

export const decodeCodexMcpList = (
  stdout: string,
): Effect.Effect<ReadonlyArray<CodexMcpListEntry>, ForkExtensionsError> =>
  decodeCodexMcp(stdout).pipe(
    Effect.mapError(() => decodeFailure("codex mcp list --json", stdout)),
  );
