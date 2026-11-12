import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProjectId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../../config.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ForkExtensions from "./ForkExtensions.ts";

type RunnerResult = Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>;

interface Call {
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string | undefined;
}

const output = (stdout: string, code = 0, stderr = ""): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr,
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const CONTEXT7 = { type: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp"] };

const CODEX_TOML = `# my codex config
model = "gpt-5"

[mcp_servers.docs]
command = "docs-mcp" # keep me
args = ["--fast"]
`;

interface Harness {
  readonly service: ForkExtensions.ForkExtensions["Service"];
  readonly calls: Ref.Ref<ReadonlyArray<Call>>;
  readonly root: string;
  readonly claudeJsonFile: string;
  readonly codexToml: string;
  readonly claudeSkills: string;
  readonly codexSkills: string;
  readonly stashFile: string;
  readonly baseDir: string;
  /** T3 project path (OS separators); ~/.claude.json keys it with forward slashes. */
  readonly appPath: string;
  readonly appKey: string;
  readonly readJson: (file: string) => Effect.Effect<any, never, never>;
}

interface Options {
  /** Answers a call; return undefined for the default (fake CLI) behavior. */
  readonly respond?: (
    argv: ReadonlyArray<string>,
    input: ProcessRunner.ProcessRunInput,
    /** The default fake CLI, to run before answering differently. */
    fake: (argv: ReadonlyArray<string>) => RunnerResult,
  ) => RunnerResult | undefined;
  /** `<app>/.mcp.json` (Claude project scope). */
  readonly appMcpJson?: unknown;
  /** `claude` resolves to an npm script shim (`.cmd`), as on Windows with an npm install. */
  readonly claudeScriptShim?: boolean;
  readonly claudeJson?: (paths: { appKey: string; otherKey: string }) => unknown;
  readonly stash?: Record<string, unknown>;
  /** After the first read of this file (by basename), rewrite it with this text. */
  readonly tamper?: { readonly basename: string; readonly text: string };
}

const withHarness = <A, E>(
  body: (harness: Harness) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
  options: Options = {},
) =>
  Effect.gen(function* () {
    const realFs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* realFs.makeTempDirectoryScoped({ prefix: "t3-fork-ext-mut-" });
    const claudeHome = path.join(root, "claude");
    const codexHome = path.join(root, "codex");
    const baseDir = path.join(root, "base");
    const appPath = path.join(root, "app");
    const appKey = appPath.replaceAll("\\", "/");
    const otherKey = path.join(root, "other").replaceAll("\\", "/");
    yield* realFs.makeDirectory(claudeHome, { recursive: true });
    yield* realFs.makeDirectory(codexHome, { recursive: true });
    yield* realFs.makeDirectory(appPath, { recursive: true });
    const claudeJsonFile = path.join(claudeHome, ".claude.json");
    const codexToml = path.join(codexHome, "config.toml");
    const stashFile = path.join(baseDir, "fork-extensions", "disabled-claude-mcp.json");
    yield* realFs.writeFileString(
      claudeJsonFile,
      `${JSON.stringify(
        options.claudeJson?.({ appKey, otherKey }) ?? {
          numStartups: 12,
          mcpServers: { context7: CONTEXT7 },
          claudeAiMcpEverConnected: ["claude.ai Supabase"],
          projects: {
            [appKey]: { allowedTools: ["Bash"], mcpServers: {} },
            [otherKey]: { allowedTools: [], mcpServers: {} },
          },
        },
        null,
        2,
      )}\n`,
    );
    yield* realFs.writeFileString(codexToml, CODEX_TOML);
    if (options.appMcpJson !== undefined) {
      yield* realFs.writeFileString(
        path.join(appPath, ".mcp.json"),
        JSON.stringify(options.appMcpJson),
      );
    }
    if (options.stash !== undefined) {
      yield* realFs.makeDirectory(path.dirname(stashFile), { recursive: true });
      yield* realFs.writeFileString(
        stashFile,
        JSON.stringify(
          Object.fromEntries(
            Object.entries(options.stash).map(([name, definition]) => [
              name,
              { definition, stashedAt: "2026-11-01T00:00:00.000Z" },
            ]),
          ),
        ),
      );
    }

    // A FileSystem that rewrites one file right after T3 first reads it: "changed from the
    // terminal between the read and the write".
    let tampered = false;
    const fs: FileSystem.FileSystem = {
      ...realFs,
      readFile: (file) =>
        realFs.readFile(file).pipe(
          Effect.tap(() => {
            if (tampered || options.tamper === undefined) return Effect.void;
            if (path.basename(file) !== options.tamper.basename) return Effect.void;
            tampered = true;
            return realFs.writeFileString(file, options.tamper.text);
          }),
        ),
    };

    const readJson = (file: string) =>
      realFs.readFileString(file).pipe(
        Effect.map((text) => JSON.parse(text)),
        Effect.orDie,
      );

    // Fake CLIs: `claude mcp remove -s user` / `add-json -s user` edit .claude.json like the real
    // ones; `git clone` writes a small repo; everything else succeeds with empty output.
    const fakeCli = (argv: ReadonlyArray<string>): RunnerResult => {
      const [command, ...args] = argv;
      const line = args.join(" ");
      if (command === "claude" && line === "plugin list --json") {
        return Effect.succeed(output("[]"));
      }
      if (command === "codex" && line === "mcp list --json") {
        return Effect.succeed(
          output(
            JSON.stringify([
              { name: "docs", enabled: true, transport: { type: "stdio", command: "docs-mcp" } },
            ]),
          ),
        );
      }
      if (command === "claude" && args[0] === "mcp" && args[1] === "remove" && args[3] === "user") {
        return readJson(claudeJsonFile).pipe(
          Effect.flatMap((json) => {
            delete json.mcpServers[args[4]!];
            return realFs.writeFileString(claudeJsonFile, JSON.stringify(json, null, 2));
          }),
          Effect.orDie,
          Effect.as(output("Removed")),
        );
      }
      if (command === "claude" && args[0] === "mcp" && args[1] === "add-json") {
        return readJson(claudeJsonFile).pipe(
          Effect.flatMap((json) => {
            json.mcpServers[args[4]!] = JSON.parse(args[5]!);
            return realFs.writeFileString(claudeJsonFile, JSON.stringify(json, null, 2));
          }),
          Effect.orDie,
          Effect.as(output("Added")),
        );
      }
      if (command === "git" && args[0] === "clone") {
        const target = args.at(-1)!;
        return Effect.all([
          realFs.makeDirectory(path.join(target, ".git"), { recursive: true }),
          realFs.makeDirectory(path.join(target, "skills", "pdf"), { recursive: true }),
        ]).pipe(
          Effect.andThen(realFs.writeFileString(path.join(target, ".git", "HEAD"), "ref")),
          Effect.andThen(
            realFs.writeFileString(path.join(target, "skills", "pdf", "SKILL.md"), "# PDF"),
          ),
          Effect.andThen(realFs.writeFileString(path.join(target, "README.md"), "repo")),
          Effect.orDie,
          Effect.as(output("")),
        );
      }
      return Effect.succeed(output(""));
    };

    const calls = yield* Ref.make<ReadonlyArray<Call>>([]);
    const runner = Layer.succeed(
      ProcessRunner.ProcessRunner,
      ProcessRunner.ProcessRunner.of({
        run: (input) => {
          const argv = [input.command, ...input.args];
          return Ref.update(calls, (all) => [...all, { argv, cwd: input.cwd }]).pipe(
            Effect.andThen(() => options.respond?.(argv, input, fakeCli) ?? fakeCli(argv)),
          );
        },
      }),
    );

    const layer = Layer.effect(ForkExtensions.ForkExtensions, ForkExtensions.make).pipe(
      Layer.provide(
        Layer.mergeAll(
          runner,
          ServerSettings.layerTest({
            providerInstances: {
              [ProviderInstanceId.make("claudeAgent")]: {
                driver: ProviderDriverKind.make("claudeAgent"),
                config: { homePath: claudeHome },
              },
              [ProviderInstanceId.make("codex")]: {
                driver: ProviderDriverKind.make("codex"),
                config: { homePath: codexHome },
              },
            },
          }),
          ServerConfig.layerTest(root, baseDir),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            listShells: () =>
              Effect.succeed([
                {
                  id: ProjectId.make("project-1"),
                  title: "App",
                  workspaceRoot: appPath,
                  defaultModelSelection: null,
                  scripts: [],
                  createdAt: "2026-01-01T00:00:00.000Z",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                },
              ]),
          }),
          Layer.succeed(HostProcess.HomeDirectory, root),
          Layer.succeed(HostProcess.Environment, {}),
          // @effect-diagnostics-next-line layerMergeAllWithDependencies:off -- only ForkExtensions gets the wrapped fs; the other layers keep the real one.
          Layer.succeed(FileSystem.FileSystem, fs),
          // Mutations never start a login terminal.
          Layer.succeed(
            PtyAdapter.PtyAdapter,
            PtyAdapter.PtyAdapter.of({ spawn: () => Effect.die("unexpected login terminal") }),
          ),
          // Hermetic spawn resolution: no real binary is looked up on this machine.
          Layer.succeed(SpawnExecutableResolution, (command: string) =>
            options.claudeScriptShim === true && command === "claude"
              ? "C:\\npm\\claude.cmd"
              : undefined,
          ),
          // Shims only exist on Windows; resolveSpawnCommand skips the resolver elsewhere.
          options.claudeScriptShim === true
            ? Layer.succeed(HostProcess.Platform, "win32")
            : Layer.empty,
        ),
      ),
    );
    return yield* Effect.gen(function* () {
      const service = yield* ForkExtensions.ForkExtensions;
      return yield* body({
        service,
        calls,
        root,
        claudeJsonFile,
        codexToml,
        claudeSkills: path.join(claudeHome, "skills"),
        codexSkills: path.join(codexHome, "skills"),
        stashFile,
        baseDir,
        appPath,
        appKey,
        readJson,
      });
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

/** Calls that are not the reads every operation may do. */
const writes = (calls: ReadonlyArray<Call>) =>
  calls.filter(
    (call) =>
      !(call.argv[0] === "codex" && call.argv.slice(1).join(" ") === "mcp list --json") &&
      !(call.argv[0] === "claude" && call.argv.slice(1).join(" ") === "plugin list --json"),
  );

const remoteMcp = {
  _tag: "mcp",
  name: "linear",
  agents: ["claude", "codex"],
  transport: "http",
  command: null,
  args: [],
  url: "https://mcp.linear.app/mcp",
  scope: "user",
  projectPath: null,
} as const;

describe("ForkExtensions.install", () => {
  it.effect("adds a remote MCP to Claude and Codex with the exact CLI arguments", () =>
    withHarness(({ service, calls }) =>
      Effect.gen(function* () {
        const results = yield* service.install(remoteMcp);
        expect(results).toEqual([
          { agent: "claude", ok: true, problem: null },
          { agent: "codex", ok: true, problem: null },
        ]);
        expect(writes(yield* Ref.get(calls)).map((call) => call.argv)).toEqual([
          ["claude", "mcp", "add", "-s", "user", "--transport", "http", "linear", remoteMcp.url],
          ["codex", "mcp", "add", "linear", "--url", remoteMcp.url],
        ]);
      }),
    ),
  );

  it.effect("a Codex failure does not stop Claude's install", () =>
    withHarness(
      ({ service }) =>
        Effect.gen(function* () {
          const [claude, codex] = yield* service.install(remoteMcp);
          expect(claude).toEqual({ agent: "claude", ok: true, problem: null });
          expect(codex).toMatchObject({
            agent: "codex",
            ok: false,
            problem: { reason: "commandFailed", rawOutput: "Error: config.toml is locked" },
          });
        }),
      {
        respond: (argv) =>
          argv[0] === "codex" && argv[2] === "add"
            ? Effect.succeed(output("", 1, "Error: config.toml is locked"))
            : undefined,
      },
    ),
  );

  it.effect("adds a local-scope command server from the project folder", () =>
    withHarness(({ service, calls, appPath }) =>
      Effect.gen(function* () {
        const results = yield* service.install({
          _tag: "mcp",
          name: "fs",
          agents: ["claude"],
          transport: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
          url: null,
          scope: "local",
          projectPath: appPath,
        });
        expect(results).toEqual([{ agent: "claude", ok: true, problem: null }]);
        expect(writes(yield* Ref.get(calls))).toEqual([
          {
            argv: [
              "claude",
              "mcp",
              "add",
              "-s",
              "local",
              "fs",
              "--",
              "npx",
              "-y",
              "@modelcontextprotocol/server-filesystem",
              ".",
            ],
            cwd: appPath,
          },
        ]);
      }),
    ),
  );

  it.effect("reports a duplicate name as alreadyExists, and Codex duplicates before adding", () =>
    withHarness(
      ({ service, calls }) =>
        Effect.gen(function* () {
          const [claude, codex] = yield* service.install({ ...remoteMcp, name: "docs" });
          expect(claude).toMatchObject({
            ok: false,
            problem: {
              reason: "alreadyExists",
              nextStep: "Pick another name or uninstall the existing one first.",
            },
          });
          expect(codex).toMatchObject({ ok: false, problem: { reason: "alreadyExists" } });
          // Codex would overwrite silently, so it is never asked to add a name it has.
          expect(writes(yield* Ref.get(calls)).filter((call) => call.argv[0] === "codex")).toEqual(
            [],
          );
        }),
      {
        respond: (argv) =>
          argv[0] === "claude" && argv[2] === "add"
            ? Effect.succeed(output("", 1, "MCP server docs already exists in user config"))
            : undefined,
      },
    ),
  );

  it.effect("adds the marketplace (already added is fine), then installs the plugin", () =>
    withHarness(
      ({ service, calls }) =>
        Effect.gen(function* () {
          const results = yield* service.install({
            _tag: "plugin",
            pluginRef: "superpowers@superpowers-marketplace",
            marketplaceSource: "obra/superpowers-marketplace",
          });
          expect(results).toEqual([{ agent: "claude", ok: true, problem: null }]);
          expect(writes(yield* Ref.get(calls)).map((call) => call.argv)).toEqual([
            ["claude", "plugin", "marketplace", "add", "obra/superpowers-marketplace"],
            ["claude", "plugin", "install", "superpowers@superpowers-marketplace"],
          ]);
        }),
      {
        respond: (argv) =>
          argv[2] === "marketplace"
            ? Effect.succeed(
                output("", 1, "Marketplace 'superpowers-marketplace' is already added"),
              )
            : undefined,
      },
    ),
  );

  it.effect("a plugin repo without a marketplace is unsupported (Ruling 11)", () =>
    withHarness(({ service, calls }) =>
      Effect.gen(function* () {
        const [result] = yield* service.install({
          _tag: "plugin",
          pluginRef: "owner/some-plugin",
          marketplaceSource: null,
        });
        expect(result).toMatchObject({
          agent: "claude",
          ok: false,
          problem: {
            reason: "unsupported",
            nextStep: "Add its marketplace instead (paste the marketplace repo).",
          },
        });
        expect(writes(yield* Ref.get(calls))).toEqual([]);
      }),
    ),
  );

  it.effect("installs a GitHub skill subfolder into each agent and cleans up", () =>
    withHarness(({ service, calls, claudeSkills, codexSkills, baseDir }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const results = yield* service.install({
          _tag: "skill",
          name: "pdf",
          agents: ["claude", "codex"],
          source: "anthropics/skills/skills/pdf",
        });
        expect(results).toEqual([
          { agent: "claude", ok: true, problem: null },
          { agent: "codex", ok: true, problem: null },
        ]);
        const clones = (yield* Ref.get(calls)).filter((call) => call.argv[0] === "git");
        expect(clones).toHaveLength(1);
        expect(clones[0]!.argv.slice(0, 5)).toEqual([
          "git",
          "clone",
          "--depth",
          "1",
          "https://github.com/anthropics/skills.git",
        ]);
        for (const dir of [claudeSkills, codexSkills]) {
          expect(yield* fs.readFileString(path.join(dir, "pdf", "SKILL.md"))).toBe("# PDF");
          expect(yield* fs.readDirectory(dir)).toEqual(["pdf"]);
        }
        const tmp = path.join(baseDir, "fork-extensions", "tmp");
        expect(yield* fs.readDirectory(tmp)).toEqual([]);

        // A second install of the same name is alreadyExists, not an overwrite.
        const again = yield* service.install({
          _tag: "skill",
          name: "pdf",
          agents: ["claude"],
          source: "anthropics/skills/skills/pdf",
        });
        expect(again[0]).toMatchObject({ ok: false, problem: { reason: "alreadyExists" } });
      }),
    ),
  );

  it.effect("rejects a skill name that is not a single folder name", () =>
    withHarness(({ service, calls }) =>
      Effect.gen(function* () {
        const [result] = yield* service.install({
          _tag: "skill",
          name: "../evil",
          agents: ["claude"],
          source: "anthropics/skills/skills/pdf",
        });
        expect(result).toMatchObject({ ok: false, problem: { reason: "invalidInput" } });
        expect(writes(yield* Ref.get(calls))).toEqual([]);
      }),
    ),
  );
});

describe("ForkExtensions.setEnabled (Claude MCP)", () => {
  it.effect("global off stashes the definition and removes it; on re-adds the same one", () =>
    withHarness(({ service, calls, claudeJsonFile, stashFile, readJson }) =>
      Effect.gen(function* () {
        const off = yield* service.setEnabled({
          itemId: "mcp:context7",
          agent: "claude",
          enabled: false,
          projectPath: null,
        });
        expect(off).toEqual({ agent: "claude", ok: true, problem: null });
        expect((yield* readJson(stashFile)).context7.definition).toEqual(CONTEXT7);
        expect((yield* readJson(claudeJsonFile)).mcpServers).toEqual({});
        expect(writes(yield* Ref.get(calls)).map((call) => call.argv)).toEqual([
          ["claude", "mcp", "remove", "-s", "user", "context7"],
        ]);

        const snapshot = yield* service.snapshot;
        expect(snapshot.items.find((item) => item.id === "mcp:context7")?.cells[0]).toMatchObject({
          state: "disabled",
          stashDiscarded: false,
        });

        yield* Ref.set(calls, []);
        const on = yield* service.setEnabled({
          itemId: "mcp:context7",
          agent: "claude",
          enabled: true,
          projectPath: null,
        });
        expect(on).toEqual({ agent: "claude", ok: true, problem: null });
        const addJson = writes(yield* Ref.get(calls)).map((call) => call.argv);
        expect(addJson).toHaveLength(1);
        expect(addJson[0]!.slice(0, 5)).toEqual(["claude", "mcp", "add-json", "-s", "user"]);
        expect(addJson[0]![5]).toBe("context7");
        expect(JSON.parse(addJson[0]![6]!)).toEqual(CONTEXT7);
        expect(yield* readJson(stashFile)).toEqual({});
        expect((yield* readJson(claudeJsonFile)).mcpServers.context7).toEqual(CONTEXT7);
      }),
    ),
  );

  it.effect("a failed re-add keeps the stashed definition (Ruling 10)", () =>
    withHarness(
      ({ service, stashFile, readJson }) =>
        Effect.gen(function* () {
          const result = yield* service.setEnabled({
            itemId: "mcp:saved",
            agent: "claude",
            enabled: true,
            projectPath: null,
          });
          expect(result).toMatchObject({ ok: false, problem: { reason: "commandFailed" } });
          expect((yield* readJson(stashFile)).saved.definition).toEqual(CONTEXT7);
        }),
      {
        stash: { saved: CONTEXT7 },
        respond: (argv) =>
          argv[2] === "add-json" ? Effect.succeed(output("", 1, "boom")) : undefined,
      },
    ),
  );

  it.effect("a stashed name that is live again is discarded by the snapshot", () =>
    withHarness(
      ({ service, stashFile, readJson }) =>
        Effect.gen(function* () {
          const snapshot = yield* service.snapshot;
          expect(snapshot.items.find((item) => item.id === "mcp:context7")?.cells[0]).toMatchObject(
            { state: "unknown", stashDiscarded: true },
          );
          // The discard runs in the write queue; queueing behind it waits for it.
          yield* Effect.yieldNow;
          yield* service.withWriteLock(Effect.void);
          expect(yield* readJson(stashFile)).toEqual({});
        }),
      { stash: { context7: { type: "stdio", command: "old" } } },
    ),
  );

  it.effect("the snapshot does not wait for a busy write queue to drop a revived copy", () =>
    withHarness(
      ({ service, stashFile, readJson }) =>
        Effect.gen(function* () {
          const held = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const holder = yield* service
            .withWriteLock(
              Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(held);
          const snapshot = yield* service.snapshot;
          expect(snapshot.items.find((item) => item.id === "mcp:context7")?.cells[0]).toMatchObject(
            { stashDiscarded: true },
          );
          expect(Object.keys(yield* readJson(stashFile))).toEqual(["context7"]);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(holder);
          yield* Effect.yieldNow;
          yield* service.withWriteLock(Effect.void);
          expect(yield* readJson(stashFile)).toEqual({});
        }),
      { stash: { context7: { type: "stdio", command: "old" } } },
    ),
  );

  it.effect("a remove that times out after removing keeps the only copy", () =>
    withHarness(
      ({ service, claudeJsonFile, stashFile, readJson }) =>
        Effect.gen(function* () {
          const result = yield* service.setEnabled({
            itemId: "mcp:context7",
            agent: "claude",
            enabled: false,
            projectPath: null,
          });
          expect(result).toMatchObject({ ok: false, problem: { reason: "timeout" } });
          expect((yield* readJson(claudeJsonFile)).mcpServers).toEqual({});
          expect((yield* readJson(stashFile)).context7.definition).toEqual(CONTEXT7);
        }),
      {
        respond: (argv, input, fake) =>
          argv[2] === "remove"
            ? fake(argv).pipe(
                Effect.andThen(
                  Effect.fail(
                    new ProcessRunner.ProcessTimeoutError({
                      command: input.command,
                      argumentCount: input.args.length,
                      timeoutMs: 60_000,
                    }),
                  ),
                ),
              )
            : undefined,
      },
    ),
  );

  it.effect("a refused remove (server still live) drops the new copy", () =>
    withHarness(
      ({ service, claudeJsonFile, stashFile, readJson }) =>
        Effect.gen(function* () {
          const result = yield* service.setEnabled({
            itemId: "mcp:context7",
            agent: "claude",
            enabled: false,
            projectPath: null,
          });
          expect(result).toMatchObject({ ok: false, problem: { reason: "commandFailed" } });
          expect((yield* readJson(claudeJsonFile)).mcpServers.context7).toEqual(CONTEXT7);
          expect(yield* readJson(stashFile)).toEqual({});
        }),
      {
        respond: (argv) =>
          argv[2] === "remove" ? Effect.succeed(output("", 1, "locked")) : undefined,
      },
    ),
  );

  it.effect("off then on restores a server defined both for the user and in a project", () =>
    withHarness(
      ({ service, calls, claudeJsonFile, stashFile, appKey, readJson }) =>
        Effect.gen(function* () {
          const off = yield* service.setEnabled({
            itemId: "mcp:context7",
            agent: "claude",
            enabled: false,
            projectPath: null,
          });
          expect(off).toEqual({ agent: "claude", ok: true, problem: null });
          const switchedOff = yield* readJson(claudeJsonFile);
          expect(switchedOff.mcpServers).toEqual({});
          expect(switchedOff.projects[appKey].disabledMcpServers).toEqual(["context7"]);

          const on = yield* service.setEnabled({
            itemId: "mcp:context7",
            agent: "claude",
            enabled: true,
            projectPath: null,
          });
          expect(on).toEqual({ agent: "claude", ok: true, problem: null });
          const restored = yield* readJson(claudeJsonFile);
          expect(restored.mcpServers.context7).toEqual(CONTEXT7);
          expect(restored.projects[appKey].disabledMcpServers).toEqual([]);
          expect(restored.projects[appKey].mcpServers.context7).toEqual({ command: "local-c7" });
          expect(yield* readJson(stashFile)).toEqual({});
          expect(writes(yield* Ref.get(calls)).map((call) => call.argv.slice(0, 5))).toEqual([
            ["claude", "mcp", "remove", "-s", "user"],
            ["claude", "mcp", "add-json", "-s", "user"],
          ]);
        }),
      {
        claudeJson: ({ appKey }) => ({
          mcpServers: { context7: CONTEXT7 },
          projects: { [appKey]: { mcpServers: { context7: { command: "local-c7" } } } },
        }),
      },
    ),
  );

  it.effect("global off skips a T3 project Claude never opened and says so", () =>
    withHarness(
      ({ service, claudeJsonFile, readJson }) =>
        Effect.gen(function* () {
          const result = yield* service.setEnabled({
            itemId: "mcp:shared",
            agent: "claude",
            enabled: false,
            projectPath: null,
          });
          expect(result).toMatchObject({
            agent: "claude",
            ok: true,
            problem: { reason: "notFound", summary: expect.stringContaining("App") },
          });
          const projects = (yield* readJson(claudeJsonFile)).projects;
          expect(Object.values(projects).map((p: any) => p.disabledMcpServers)).toEqual([
            ["shared"],
          ]);
        }),
      {
        claudeJson: ({ otherKey }) => ({
          mcpServers: {},
          projects: { [otherKey]: { mcpServers: { shared: { command: "shared-mcp" } } } },
        }),
        appMcpJson: { mcpServers: { shared: { command: "shared-mcp" } } },
      },
    ),
  );

  it.effect("an empty saved copy is invalidInput and nothing is run", () =>
    withHarness(
      ({ service, calls, stashFile, readJson }) =>
        Effect.gen(function* () {
          const result = yield* service.setEnabled({
            itemId: "mcp:saved",
            agent: "claude",
            enabled: true,
            projectPath: null,
          });
          expect(result).toMatchObject({
            ok: false,
            problem: {
              reason: "invalidInput",
              summary: "The saved copy of saved is empty.",
              nextStep: "Add the server again by hand.",
            },
          });
          expect(writes(yield* Ref.get(calls))).toEqual([]);
          expect(Object.keys(yield* readJson(stashFile))).toEqual(["saved"]);
        }),
      { stash: { saved: null } },
    ),
  );

  it.effect("add-json is refused when claude is an npm script shim (cmd.exe re-parsing)", () =>
    withHarness(
      ({ service, calls, stashFile, readJson }) =>
        Effect.gen(function* () {
          const result = yield* service.setEnabled({
            itemId: "mcp:saved",
            agent: "claude",
            enabled: true,
            projectPath: null,
          });
          expect(result).toMatchObject({ ok: false, problem: { reason: "unsupported" } });
          expect(writes(yield* Ref.get(calls))).toEqual([]);
          expect((yield* readJson(stashFile)).saved.definition).toEqual(CONTEXT7);
        }),
      { stash: { saved: CONTEXT7 }, claudeScriptShim: true },
    ),
  );

  it.effect("per-project off changes only projects[<that key>].disabledMcpServers", () =>
    withHarness(({ service, calls, claudeJsonFile, appPath, appKey, readJson }) =>
      Effect.gen(function* () {
        const before = yield* readJson(claudeJsonFile);
        const result = yield* service.setEnabled({
          itemId: "mcp:context7",
          agent: "claude",
          enabled: false,
          projectPath: appPath,
        });
        expect(result).toEqual({ agent: "claude", ok: true, problem: null });
        const after = yield* readJson(claudeJsonFile);
        expect(after.projects[appKey].disabledMcpServers).toEqual(["context7"]);
        const { disabledMcpServers: _changed, ...appRest } = after.projects[appKey];
        expect({ ...after, projects: { ...after.projects, [appKey]: appRest } }).toEqual(before);
        expect(writes(yield* Ref.get(calls))).toEqual([]);

        // Per project also works for a claude.ai connector.
        const connector = yield* service.setEnabled({
          itemId: "mcp:claude.ai Supabase",
          agent: "claude",
          enabled: false,
          projectPath: appPath,
        });
        expect(connector.ok).toBe(true);
        expect((yield* readJson(claudeJsonFile)).projects[appKey].disabledMcpServers).toEqual([
          "context7",
          "claude.ai Supabase",
        ]);
      }),
    ),
  );

  it.effect("a project Claude has never opened is notFound (no invented key)", () =>
    withHarness(({ service, root }) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const result = yield* service.setEnabled({
          itemId: "mcp:context7",
          agent: "claude",
          enabled: false,
          projectPath: path.join(root, "never-opened"),
        });
        expect(result).toMatchObject({ ok: false, problem: { reason: "notFound" } });
      }),
    ),
  );

  it.effect("global off of a local-scope server switches it off in every project that has it", () =>
    withHarness(
      ({ service, calls, claudeJsonFile, readJson }) =>
        Effect.gen(function* () {
          const result = yield* service.setEnabled({
            itemId: "mcp:db",
            agent: "claude",
            enabled: false,
            projectPath: null,
          });
          expect(result).toEqual({ agent: "claude", ok: true, problem: null });
          const projects = (yield* readJson(claudeJsonFile)).projects;
          expect(Object.values(projects).map((p: any) => p.disabledMcpServers)).toEqual([
            ["db"],
            ["db"],
            undefined,
          ]);
          expect(writes(yield* Ref.get(calls))).toEqual([]);
        }),
      {
        claudeJson: ({ appKey, otherKey }) => ({
          mcpServers: {},
          projects: {
            [appKey]: { mcpServers: { db: { command: "db-mcp" } } },
            [otherKey]: { mcpServers: { db: { command: "db-mcp" } } },
            "C:/unrelated": { mcpServers: {} },
          },
        }),
      },
    ),
  );

  it.effect("claude.ai connectors and plugin servers have no global switch here", () =>
    withHarness(({ service }) =>
      Effect.gen(function* () {
        const connector = yield* service.setEnabled({
          itemId: "mcp:claude.ai Supabase",
          agent: "claude",
          enabled: false,
          projectPath: null,
        });
        expect(connector).toMatchObject({
          ok: false,
          problem: {
            reason: "unsupported",
            nextStep: "Turn it off in claude.ai → Settings → Connectors.",
          },
        });
        const plugin = yield* service.setEnabled({
          itemId: "mcp:plugin:playwright:playwright",
          agent: "claude",
          enabled: false,
          projectPath: null,
        });
        expect(plugin).toMatchObject({
          ok: false,
          problem: { reason: "unsupported", nextStep: "Disable the plugin it comes from." },
        });
      }),
    ),
  );
});

describe("ForkExtensions.setEnabled (Codex, plugins, skills)", () => {
  it.effect("Codex: edits only `enabled` in config.toml", () =>
    withHarness(({ service, calls, codexToml }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const result = yield* service.setEnabled({
          itemId: "mcp:docs",
          agent: "codex",
          enabled: false,
          projectPath: null,
        });
        expect(result).toEqual({ agent: "codex", ok: true, problem: null });
        expect(yield* fs.readFileString(codexToml)).toBe(
          CODEX_TOML.replace("[mcp_servers.docs]\n", "[mcp_servers.docs]\nenabled = false\n"),
        );
        expect(writes(yield* Ref.get(calls))).toEqual([]);
      }),
    ),
  );

  it.effect(
    "Codex: config.toml changed between read and write → configChanged, nothing written",
    () =>
      withHarness(
        ({ service, codexToml }) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const result = yield* service.setEnabled({
              itemId: "mcp:docs",
              agent: "codex",
              enabled: false,
              projectPath: null,
            });
            expect(result).toMatchObject({
              agent: "codex",
              ok: false,
              problem: { reason: "configChanged" },
            });
            expect(yield* fs.readFileString(codexToml)).toBe(
              `${CODEX_TOML}# edited in a terminal\n`,
            );
          }),
        { tamper: { basename: "config.toml", text: `${CODEX_TOML}# edited in a terminal\n` } },
      ),
  );

  it.effect("plugins switch with `claude plugin enable|disable`", () =>
    withHarness(({ service, calls }) =>
      Effect.gen(function* () {
        yield* service.setEnabled({
          itemId: "plugin:superpowers@claude-plugins-official",
          agent: "claude",
          enabled: false,
          projectPath: null,
        });
        yield* service.setEnabled({
          itemId: "plugin:superpowers@claude-plugins-official",
          agent: "claude",
          enabled: true,
          projectPath: null,
        });
        expect(writes(yield* Ref.get(calls)).map((call) => call.argv)).toEqual([
          ["claude", "plugin", "disable", "superpowers@claude-plugins-official"],
          ["claude", "plugin", "enable", "superpowers@claude-plugins-official"],
        ]);
      }),
    ),
  );

  it.effect("loose skills move out of and back into the skills folder", () =>
    withHarness(({ service, claudeSkills, baseDir }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(path.join(claudeSkills, "notes"), { recursive: true });
        yield* fs.writeFileString(path.join(claudeSkills, "notes", "SKILL.md"), "# Notes");
        const off = yield* service.setEnabled({
          itemId: "skill:notes",
          agent: "claude",
          enabled: false,
          projectPath: null,
        });
        expect(off.ok).toBe(true);
        expect(yield* fs.exists(path.join(claudeSkills, "notes"))).toBe(false);
        expect(
          yield* fs.exists(
            path.join(baseDir, "fork-extensions", "disabled-skills", "claude", "notes", "SKILL.md"),
          ),
        ).toBe(true);
        const on = yield* service.setEnabled({
          itemId: "skill:notes",
          agent: "claude",
          enabled: true,
          projectPath: null,
        });
        expect(on.ok).toBe(true);
        expect(yield* fs.readFileString(path.join(claudeSkills, "notes", "SKILL.md"))).toBe(
          "# Notes",
        );
      }),
    ),
  );
});

describe("ForkExtensions.uninstall", () => {
  it.effect("a claude.ai connector is unsupported, with where to remove it", () =>
    withHarness(({ service, calls }) =>
      Effect.gen(function* () {
        const results = yield* service.uninstall({
          itemId: "mcp:claude.ai Supabase",
          agents: ["claude"],
        });
        expect(results).toEqual([
          {
            agent: "claude",
            ok: false,
            problem: expect.objectContaining({
              reason: "unsupported",
              nextStep: "Remove it in claude.ai → Settings → Connectors.",
            }),
          },
        ]);
        expect(writes(yield* Ref.get(calls))).toEqual([]);
      }),
    ),
  );

  it.effect("removes an MCP from Claude (user scope, and its stash) and Codex", () =>
    withHarness(
      ({ service, calls, stashFile, readJson }) =>
        Effect.gen(function* () {
          const results = yield* service.uninstall({
            itemId: "mcp:context7",
            agents: ["claude", "codex"],
          });
          expect(results).toEqual([
            { agent: "claude", ok: true, problem: null },
            { agent: "codex", ok: true, problem: null },
          ]);
          expect(writes(yield* Ref.get(calls)).map((call) => call.argv)).toEqual([
            ["claude", "mcp", "remove", "-s", "user", "context7"],
            ["codex", "mcp", "remove", "context7"],
          ]);
          expect(yield* readJson(stashFile)).toEqual({});
        }),
      { stash: { context7: CONTEXT7 } },
    ),
  );

  it.effect("plugin skills are unsupported; loose skills are deleted", () =>
    withHarness(({ service, codexSkills }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const [pluginSkill] = yield* service.uninstall({
          itemId: "skill:superpowers:brainstorming",
          agents: ["claude"],
        });
        expect(pluginSkill).toMatchObject({
          ok: false,
          problem: { reason: "unsupported", nextStep: "Uninstall the plugin it comes from." },
        });
        yield* fs.makeDirectory(path.join(codexSkills, "notes"), { recursive: true });
        yield* fs.writeFileString(path.join(codexSkills, "notes", "SKILL.md"), "# Notes");
        const [loose] = yield* service.uninstall({ itemId: "skill:notes", agents: ["codex"] });
        expect(loose).toEqual({ agent: "codex", ok: true, problem: null });
        expect(yield* fs.exists(path.join(codexSkills, "notes"))).toBe(false);
      }),
    ),
  );

  it.effect("skips local copies whose project folder is gone, and says so", () =>
    withHarness(
      ({ service, calls, appKey }) =>
        Effect.gen(function* () {
          const [result] = yield* service.uninstall({ itemId: "mcp:db", agents: ["claude"] });
          expect(result).toMatchObject({
            agent: "claude",
            ok: true,
            problem: {
              reason: "notFound",
              summary: expect.stringContaining("left in 1 project whose folder no longer exists"),
            },
          });
          expect(writes(yield* Ref.get(calls))).toEqual([
            { argv: ["claude", "mcp", "remove", "-s", "local", "db"], cwd: appKey },
          ]);
        }),
      {
        claudeJson: ({ appKey, otherKey }) => ({
          mcpServers: {},
          projects: {
            [appKey]: { mcpServers: { db: { command: "db-mcp" } } },
            [otherKey]: { mcpServers: { db: { command: "db-mcp" } } },
          },
        }),
      },
    ),
  );
});

describe("ForkExtensions.install into a missing project folder", () => {
  it.effect("is invalidInput and runs nothing", () =>
    withHarness(({ service, calls, root }) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const [result] = yield* service.install({
          ...remoteMcp,
          agents: ["claude"],
          scope: "local",
          projectPath: path.join(root, "gone"),
        });
        expect(result).toMatchObject({
          ok: false,
          problem: { reason: "invalidInput", summary: expect.stringContaining("no longer exists") },
        });
        expect(writes(yield* Ref.get(calls))).toEqual([]);
      }),
    ),
  );
});

describe("ForkExtensions: nothing done is never reported as done", () => {
  it.effect("global off of a server only in a repo Claude never opened is notFound", () =>
    withHarness(
      ({ service, claudeJsonFile, readJson }) =>
        Effect.gen(function* () {
          const before = yield* readJson(claudeJsonFile);
          const result = yield* service.setEnabled({
            itemId: "mcp:shared",
            agent: "claude",
            enabled: false,
            projectPath: null,
          });
          expect(result).toMatchObject({
            ok: false,
            problem: {
              reason: "notFound",
              summary: "shared isn't active in any project Claude has opened yet.",
              nextStep: "Open the project in Claude Code once, then try again.",
            },
          });
          expect(yield* readJson(claudeJsonFile)).toEqual(before);
        }),
      {
        claudeJson: () => ({ mcpServers: {}, projects: {} }),
        appMcpJson: { mcpServers: { shared: { command: "shared-mcp" } } },
      },
    ),
  );

  it.effect("uninstall with only copies in folders that are gone fails and says why", () =>
    withHarness(
      ({ service, calls }) =>
        Effect.gen(function* () {
          const [result] = yield* service.uninstall({ itemId: "mcp:db", agents: ["claude"] });
          expect(result).toMatchObject({
            ok: false,
            problem: {
              reason: "notFound",
              summary: expect.stringContaining("Nothing was removed"),
              nextStep:
                "Remove the stale project entries from ~/.claude.json, or restore the folders.",
            },
          });
          expect(writes(yield* Ref.get(calls))).toEqual([]);
        }),
      {
        claudeJson: ({ otherKey }) => ({
          mcpServers: {},
          projects: { [otherKey]: { mcpServers: { db: { command: "db-mcp" } } } },
        }),
      },
    ),
  );

  it.effect("uninstall names both the repo .mcp.json and the folders that are gone", () =>
    withHarness(
      ({ service }) =>
        Effect.gen(function* () {
          const [result] = yield* service.uninstall({ itemId: "mcp:db", agents: ["claude"] });
          expect(result).toMatchObject({ ok: false, problem: { reason: "unsupported" } });
          expect(result!.problem!.summary).toContain(".mcp.json of App");
          expect(result!.problem!.summary).toContain(
            "left in 1 project whose folder no longer exists",
          );
          expect(result!.problem!.nextStep).toContain("~/.claude.json");
        }),
      {
        claudeJson: ({ otherKey }) => ({
          mcpServers: {},
          projects: { [otherKey]: { mcpServers: { db: { command: "db-mcp" } } } },
        }),
        appMcpJson: { mcpServers: { db: { command: "db-mcp" } } },
      },
    ),
  );
});
