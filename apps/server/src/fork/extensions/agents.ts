import {
  ClaudeSettings,
  CodexSettings,
  ForkExtensionsError,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type ForkExtensionAgent,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { isCommandMissingCause } from "@t3tools/provider-core/server/snapshotProbe";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../../processRunner.ts";
import {
  makeClaudeEnvironment,
  mergeClaudeProcessEnvironment,
  resolveClaudeHomePath,
} from "../../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../../provider/Drivers/CodexHomeLayout.ts";
import * as ServerSettings from "../../serverSettings.ts";

/** One agent of this machine, resolved from its first enabled provider instance. */
export interface ResolvedAgent {
  readonly agent: ForkExtensionAgent;
  readonly binaryPath: string;
  /** Claude config dir (`~/.claude` or CLAUDE_CONFIG_DIR) / Codex shared home (`~/.codex`). */
  readonly home: string;
  /** Environment every CLI call of this agent runs with. */
  readonly env: NodeJS.ProcessEnv;
  readonly skillsDir: string;
  /** Claude: its `.claude.json`; Codex: `<home>/config.toml`. */
  readonly configFile: string;
}

const DRIVERS = { claude: "claudeAgent", codex: "codex" } as const satisfies Record<
  ForkExtensionAgent,
  string
>;

const AGENT_DISPLAY_NAMES: Record<ForkExtensionAgent, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);

/** Enabled instances of a driver, the default slot first (as AgentSessionScanner orders them). */
const enabledInstances = (
  providerInstances: Record<string, ProviderInstanceConfig>,
  driver: string,
): ReadonlyArray<{ readonly instanceId: string; readonly config: ProviderInstanceConfig }> => {
  const instances = Object.entries(providerInstances)
    .filter(
      ([, instance]) => instance.driver === driver && resolveProviderInstanceEnabled(instance),
    )
    .map(([instanceId, config]) => ({ instanceId, config }));
  if (!Object.hasOwn(providerInstances, driver)) {
    const config: ProviderInstanceConfig = { driver: ProviderDriverKind.make(driver) };
    if (resolveProviderInstanceEnabled(config)) {
      instances.push({ instanceId: ProviderInstanceId.make(driver), config });
    }
  }
  return instances.toSorted(
    (left, right) => (left.instanceId === driver ? 0 : 1) - (right.instanceId === driver ? 0 : 1),
  );
};

const resolveClaude = Effect.fn("ForkExtensions.resolveClaude")(function* (
  instance: ProviderInstanceConfig,
  hostEnvironment: NodeJS.ProcessEnv,
) {
  const config = decodeClaudeSettings(instance.config ?? {});
  if (Option.isNone(config)) return Option.none<ResolvedAgent>();
  const path = yield* Path.Path;
  const userHome = yield* HostProcess.HomeDirectory;
  const processEnv = yield* mergeClaudeProcessEnvironment(
    config.value,
    instance.environment,
    hostEnvironment,
  );
  const env = yield* makeClaudeEnvironment(config.value, processEnv);
  const home = yield* resolveClaudeHomePath(config.value, env);
  const customConfigDir = (env.CLAUDE_CONFIG_DIR?.trim() ?? "").length > 0;
  return Option.some<ResolvedAgent>({
    agent: "claude",
    binaryPath: config.value.binaryPath,
    home,
    env,
    skillsDir: path.join(home, "skills"),
    // With CLAUDE_CONFIG_DIR, Claude keeps `.claude.json` inside it; otherwise in the user's home.
    configFile: customConfigDir
      ? path.join(home, ".claude.json")
      : path.join(userHome, ".claude.json"),
  });
});

const resolveCodex = Effect.fn("ForkExtensions.resolveCodex")(function* (
  instance: ProviderInstanceConfig,
  hostEnvironment: NodeJS.ProcessEnv,
) {
  const config = decodeCodexSettings(instance.config ?? {});
  if (Option.isNone(config)) return Option.none<ResolvedAgent>();
  const path = yield* Path.Path;
  const processEnv = yield* mergeProviderInstanceEnvironment(instance.environment, hostEnvironment);
  const environmentHome = processEnv.CODEX_HOME?.trim();
  const settings =
    config.value.homePath.trim().length === 0 &&
    config.value.shadowHomePath.trim().length === 0 &&
    environmentHome
      ? { ...config.value, homePath: environmentHome }
      : config.value;
  const layout = yield* resolveCodexHomeLayout(settings);
  return Option.some<ResolvedAgent>({
    agent: "codex",
    binaryPath: config.value.binaryPath,
    home: layout.sharedHomePath,
    // The layout's homes are already expanded and absolute (spawn would pass a literal ~).
    env: layout.effectiveHomePath
      ? { ...processEnv, CODEX_HOME: layout.effectiveHomePath }
      : processEnv,
    skillsDir: path.join(layout.sharedHomePath, "skills"),
    configFile: path.join(layout.sharedHomePath, "config.toml"),
  });
});

const settingsUnreadable = (cause: unknown) =>
  new ForkExtensionsError({
    problem: {
      reason: "commandFailed",
      summary: "Could not read T3's provider settings.",
      nextStep: "Check Settings → Providers on this machine, then retry.",
      rawOutput: String(cause),
    },
  });

/**
 * The agents this machine has: the first enabled `claudeAgent` / `codex` instance each.
 * An agent with no enabled instance is left out (it gets no column).
 */
export const resolveAgents = Effect.fn("ForkExtensions.resolveAgents")(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const settings = yield* settingsService.getSettings.pipe(Effect.mapError(settingsUnreadable));
  const hostEnvironment = yield* HostProcess.Environment;
  const resolved: Array<ResolvedAgent> = [];
  for (const agent of ["claude", "codex"] as const) {
    for (const { config } of enabledInstances(settings.providerInstances, DRIVERS[agent])) {
      const candidate =
        agent === "claude"
          ? yield* resolveClaude(config, hostEnvironment)
          : yield* resolveCodex(config, hostEnvironment);
      if (Option.isSome(candidate)) {
        resolved.push(candidate.value);
        break;
      }
    }
  }
  return resolved as ReadonlyArray<ResolvedAgent>;
});

const RAW_OUTPUT_LIMIT_BYTES = 8 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** stderr then stdout, trimmed to 8 KB. */
const rawOutputOf = (output: { readonly stdout: string; readonly stderr: string }): string => {
  const text = [output.stderr.trim(), output.stdout.trim()]
    .filter((part) => part !== "")
    .join("\n");
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= RAW_OUTPUT_LIMIT_BYTES) return text;
  // A cut multi-byte character decodes as U+FFFD; drop it.
  return `${decoder.decode(bytes.subarray(0, RAW_OUTPUT_LIMIT_BYTES)).replace(/�$/, "")}\n…`;
};

const SUBCOMMAND_WORDS = new Set([
  "mcp",
  "plugin",
  "marketplace",
  "add",
  "add-json",
  "remove",
  "get",
  "list",
  "login",
  "logout",
  "install",
  "uninstall",
  "enable",
  "disable",
  "update",
]);

// Argument values (`-e KEY=…`, `--header "Authorization: …"`, JSON) can carry secrets, so a
// summary names only the leading subcommand words, e.g. "claude mcp add".
const commandLabel = (agent: ResolvedAgent, args: ReadonlyArray<string>): string => {
  const end = args.findIndex((arg) => !SUBCOMMAND_WORDS.has(arg));
  return [agent.agent, ...args.slice(0, end === -1 ? args.length : end)].join(" ");
};

const binaryNotFound = (agent: ResolvedAgent, cause: unknown = null) =>
  new ForkExtensionsError({
    problem: {
      reason: "binaryNotFound",
      summary: `${AGENT_DISPLAY_NAMES[agent.agent]} was not found on this machine (${agent.binaryPath}).`,
      nextStep: `Install ${AGENT_DISPLAY_NAMES[agent.agent]} on this machine or set its path in Settings → Providers.`,
      rawOutput: cause === null ? null : String(cause),
    },
  });

/**
 * Runs the agent's CLI with its resolved environment. Missing binary → `binaryNotFound`;
 * non-zero exit → `commandFailed` with stderr+stdout; no answer in time → `timeout`.
 * Writes must go through `ForkExtensions.withWriteLock`.
 */
export const runCli = Effect.fn("ForkExtensions.runCli")(function* (
  agent: ResolvedAgent,
  args: ReadonlyArray<string>,
  opts?: { readonly stdin?: string; readonly timeoutMs?: number; readonly cwd?: string },
) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const label = commandLabel(agent, args);
  const output = yield* runner
    .run({
      command: agent.binaryPath,
      args,
      env: agent.env,
      timeout: Duration.millis(timeoutMs),
      // A shim of a native binary is spawned directly: no cmd.exe re-parsing of arguments.
      bypassNpmShim: true,
      ...(opts?.stdin === undefined ? {} : { stdin: opts.stdin }),
      ...(opts?.cwd === undefined ? {} : { cwd: opts.cwd }),
    })
    .pipe(
      Effect.mapError((error) => {
        if (error._tag === "ProcessSpawnError" && isCommandMissingCause(error.cause)) {
          return binaryNotFound(agent, error.cause);
        }
        if (error._tag === "ProcessTimeoutError") {
          return new ForkExtensionsError({
            problem: {
              reason: "timeout",
              summary: `\`${label}\` did not finish within ${Math.round(timeoutMs / 1000)} s.`,
              nextStep:
                "Retry; if it keeps happening, run the command in a terminal to see where it hangs.",
              rawOutput: null,
            },
          });
        }
        return new ForkExtensionsError({
          problem: {
            reason: "commandFailed",
            summary: `Could not run \`${label}\`.`,
            nextStep: "Run the command in a terminal on this machine to see the error, then retry.",
            rawOutput: error.message,
          },
        });
      }),
    );
  if (output.code !== 0) {
    return yield* new ForkExtensionsError({
      problem: {
        reason: "commandFailed",
        summary: `\`${label}\` failed${output.code === null ? "" : ` (exit code ${output.code})`}.`,
        nextStep: "Read the output below; run the command in a terminal on this machine to retry.",
        rawOutput: rawOutputOf(output),
      },
    });
  }
  return output;
});
