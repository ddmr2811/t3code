import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings as ContractServerSettings,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../../processRunner.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { resolveAgents, runCli, type ResolvedAgent } from "./agents.ts";

/** An absolute fake home on every platform. */
const fakeHome = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.resolve("/fake-home/me");
});

const resolveWith = (
  home: string,
  providerInstances: ContractServerSettings["providerInstances"],
) =>
  resolveAgents().pipe(
    Effect.provide(ServerSettings.layerTest({ providerInstances })),
    Effect.provideService(HostProcess.HomeDirectory, home),
    Effect.provideService(HostProcess.Environment, {}),
  );

const claudeAgent: ResolvedAgent = {
  agent: "claude",
  binaryPath: "claude",
  home: "/h/.claude",
  env: {},
  skillsDir: "/h/.claude/skills",
  configFile: "/h/.claude.json",
};

const runnerReturning = (
  result: Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>,
) =>
  Layer.succeed(ProcessRunner.ProcessRunner, ProcessRunner.ProcessRunner.of({ run: () => result }));

const failedOutput = (stdout: string, stderr: string): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr,
  code: ChildProcessSpawner.ExitCode(1),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

describe("resolveAgents", () => {
  it.effect("uses the default instances when none are configured", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const HOME = yield* fakeHome;
      const agents = yield* resolveWith(HOME, {});
      expect(agents.map((agent) => agent.agent)).toEqual(["claude", "codex"]);
      const [claude, codex] = agents;
      expect(claude).toMatchObject({
        binaryPath: "claude",
        home: path.join(HOME, ".claude"),
        skillsDir: path.join(HOME, ".claude", "skills"),
        configFile: path.join(HOME, ".claude.json"),
      });
      expect(claude?.env.CLAUDE_CONFIG_DIR).toBeUndefined();
      expect(codex).toMatchObject({
        binaryPath: "codex",
        home: path.join(HOME, ".codex"),
        skillsDir: path.join(HOME, ".codex", "skills"),
        configFile: path.join(HOME, ".codex", "config.toml"),
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("follows custom homes and leaves out a disabled agent", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const HOME = yield* fakeHome;
      const claudeHome = path.join(HOME, "work-claude");
      const agents = yield* resolveWith(HOME, {
        [ProviderInstanceId.make("claudeAgent")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          config: { homePath: claudeHome, binaryPath: "/opt/claude" },
        },
        [ProviderInstanceId.make("codex")]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: false,
        },
      });
      expect(agents).toHaveLength(1);
      expect(agents[0]).toMatchObject({
        agent: "claude",
        binaryPath: "/opt/claude",
        home: claudeHome,
        skillsDir: path.join(claudeHome, "skills"),
        // With CLAUDE_CONFIG_DIR, Claude keeps .claude.json inside the config dir.
        configFile: path.join(claudeHome, ".claude.json"),
      });
      expect(agents[0]?.env.CLAUDE_CONFIG_DIR).toBe(claudeHome);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("runs Codex with its shadow home but reads the shared home", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const HOME = yield* fakeHome;
      const shared = path.join(HOME, "codex-shared");
      const shadow = path.join(HOME, "codex-shadow");
      const [codex] = yield* resolveWith(HOME, {
        [ProviderInstanceId.make("claudeAgent")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: false,
        },
        [ProviderInstanceId.make("codex")]: {
          driver: ProviderDriverKind.make("codex"),
          config: { homePath: shared, shadowHomePath: shadow },
        },
      });
      expect(codex).toMatchObject({
        agent: "codex",
        home: shared,
        configFile: path.join(shared, "config.toml"),
      });
      expect(codex?.env.CODEX_HOME).toBe(shadow);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("runCli", () => {
  it.effect("reports a missing binary with the install hint", () =>
    Effect.gen(function* () {
      const error = yield* runCli(claudeAgent, ["plugin", "list", "--json"]).pipe(
        Effect.provide(
          runnerReturning(
            Effect.fail(
              new ProcessRunner.ProcessSpawnError({
                command: "claude",
                argumentCount: 3,
                cause: PlatformError.systemError({
                  _tag: "NotFound",
                  module: "ChildProcess",
                  method: "spawn",
                }),
              }),
            ),
          ),
        ),
        Effect.flip,
      );
      expect(error.problem).toMatchObject({
        reason: "binaryNotFound",
        nextStep: "Install Claude Code on this machine or set its path in Settings → Providers.",
      });
    }),
  );

  it.effect("fails a non-zero exit with stderr+stdout trimmed to 8 KB", () =>
    Effect.gen(function* () {
      const error = yield* runCli(claudeAgent, ["mcp", "remove", "x"]).pipe(
        Effect.provide(runnerReturning(Effect.succeed(failedOutput("x".repeat(20_000), "boom")))),
        Effect.flip,
      );
      expect(error.problem.reason).toBe("commandFailed");
      expect(error.problem.summary).toBe("`claude mcp remove x` failed (exit code 1).");
      expect(error.problem.rawOutput?.startsWith("boom\nxxx")).toBe(true);
      expect(
        new TextEncoder().encode(error.problem.rawOutput ?? "").byteLength,
      ).toBeLessThanOrEqual(8 * 1024 + 4);
    }),
  );

  it.effect("maps a timeout to the timeout reason", () =>
    Effect.gen(function* () {
      const error = yield* runCli(claudeAgent, ["plugin", "list"], { timeoutMs: 5_000 }).pipe(
        Effect.provide(
          runnerReturning(
            Effect.fail(
              new ProcessRunner.ProcessTimeoutError({
                command: "claude",
                argumentCount: 2,
                timeoutMs: 5_000,
              }),
            ),
          ),
        ),
        Effect.flip,
      );
      expect(error.problem).toMatchObject({
        reason: "timeout",
        summary: "`claude plugin list` did not finish within 5 s.",
      });
    }),
  );
});
