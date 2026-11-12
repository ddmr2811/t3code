import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ForkExtensionsSnapshot,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../../config.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ForkExtensions from "./ForkExtensions.ts";

const MCP_LIST = `Checking MCP server health…

claude.ai MCP Gestion/Patricia: https://n8n.example.com/mcp/MCPPatricia/sse - ✔ Connected
claude.ai Stripe: https://mcp.stripe.com - ! Needs authentication
plugin:cloudflare:cloudflare: https://mcp.cloudflare.com/mcp (HTTP) - ! Needs authentication
plugin:playwright:playwright: npx @playwright/mcp@latest - ✔ Connected
ghost: npx ghost - ✗ Failed to connect
`;

const decodeSnapshot = Schema.decodeUnknownSync(ForkExtensionsSnapshot);

/** Plugins as `claude plugin list --json` prints them: only some carry `mcpServers`. */
const pluginList = (pluginsDir: string, join: (...parts: Array<string>) => string) =>
  JSON.stringify([
    {
      id: "superpowers@claude-plugins-official",
      scope: "user",
      enabled: true,
      installPath: join(pluginsDir, "superpowers"),
    },
    // Declares its servers only in <installPath>/.mcp.json (bare object form).
    { id: "design@synced", scope: "user", enabled: true, installPath: join(pluginsDir, "design") },
    // Same, in the { mcpServers } form.
    { id: "ops@synced", scope: "user", enabled: true, installPath: join(pluginsDir, "ops") },
    // Unparsable .mcp.json: no servers, no failure.
    { id: "broken@synced", scope: "user", enabled: true, installPath: join(pluginsDir, "broken") },
  ]);

/** "listedRemote": also a remote server Codex has no sign-in for (`auth_status`). */
type CodexBehavior = "missing" | "failing" | "listed" | "listedRemote";

/**
 * Login terminal of `claude mcp login --no-browser`: prints its link, exits 0 once a line is
 * typed. Records each spawn's argv and what was typed.
 */
const loginPty = (logins: Array<{ argv: Array<string>; typed: Array<string> }>) =>
  Layer.succeed(
    PtyAdapter.PtyAdapter,
    PtyAdapter.PtyAdapter.of({
      spawn: (input) =>
        Effect.sync(() => {
          const record = { argv: [input.shell, ...(input.args ?? [])], typed: [] as string[] };
          logins.push(record);
          const exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
          return {
            pid: 1,
            write: (data) => {
              record.typed.push(data);
              for (const listener of exitListeners) listener({ exitCode: 0, signal: null });
            },
            resize: () => {},
            kill: () => {},
            onData: (callback) => {
              callback("Open this URL: https://example.com/oauth?x=1\r\n");
              return () => {};
            },
            onExit: (callback) => {
              exitListeners.add(callback);
              return () => exitListeners.delete(callback);
            },
          } satisfies PtyAdapter.PtyProcess;
        }),
    }),
  );

type RunnerResult = Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>;
/** Replaces the answer to `claude mcp list` (the 10 s health command). */
type ClaudeMcpList = (input: ProcessRunner.ProcessRunInput) => RunnerResult;

const output = (stdout: string): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

/** ProcessRunner that records every call; `codex` is missing or exits 1. */
const recordingRunner = (
  calls: Ref.Ref<ReadonlyArray<ReadonlyArray<string>>>,
  plugins: string,
  codex: CodexBehavior,
  claudeMcpList: ClaudeMcpList | undefined,
) =>
  Layer.succeed(
    ProcessRunner.ProcessRunner,
    ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Ref.update(calls, (all) => [...all, [input.command, ...input.args]]).pipe(
          Effect.andThen(() => {
            if (
              claudeMcpList !== undefined &&
              input.command === "claude" &&
              input.args.join(" ") === "mcp list"
            ) {
              return claudeMcpList(input);
            }
            if (input.command === "codex" && (codex === "listed" || codex === "listedRemote")) {
              return Effect.succeed(
                output(
                  JSON.stringify([
                    { name: "docs", enabled: true, transport: { type: "stdio", command: "docs" } },
                    { name: "off", enabled: false, transport: { type: "stdio", command: "off" } },
                    ...(codex === "listedRemote"
                      ? [
                          {
                            name: "linear",
                            enabled: true,
                            auth_status: "notLoggedIn",
                            transport: {
                              type: "streamable_http",
                              url: "https://mcp.linear.app/mcp",
                            },
                          },
                        ]
                      : []),
                  ]),
                ),
              );
            }
            if (input.command === "codex" && codex === "failing") {
              return Effect.succeed({
                ...output(""),
                stderr: "Error: invalid config.toml",
                code: ChildProcessSpawner.ExitCode(1),
              });
            }
            if (input.command === "codex") {
              return Effect.fail(
                new ProcessRunner.ProcessSpawnError({
                  command: input.command,
                  argumentCount: input.args.length,
                  cause: PlatformError.systemError({
                    _tag: "NotFound",
                    module: "ChildProcess",
                    method: "spawn",
                  }),
                }),
              );
            }
            return Effect.succeed(
              input.args.join(" ") === "plugin list --json" ? output(plugins) : output(""),
            );
          }),
        ),
    }),
  );

const withService = <A, E>(
  body: (input: {
    readonly service: ForkExtensions.ForkExtensions["Service"];
    readonly calls: Ref.Ref<ReadonlyArray<ReadonlyArray<string>>>;
    readonly cacheFile: string;
  }) => Effect.Effect<A, E, FileSystem.FileSystem>,
  options: {
    readonly codex?: CodexBehavior;
    readonly claudeMcpList?: ClaudeMcpList;
    /** Text written to the health cache file before the service starts. */
    readonly seedCache?: string;
    /** Records the login terminals Authorize starts. */
    readonly logins?: Array<{ argv: Array<string>; typed: Array<string> }>;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fork-extensions-" });
    const claudeHome = path.join(root, "claude");
    const codexHome = path.join(root, "codex");
    yield* fs.makeDirectory(claudeHome, { recursive: true });
    yield* fs.writeFileString(
      path.join(claudeHome, ".claude.json"),
      JSON.stringify({
        mcpServers: { context7: { type: "stdio", command: "npx", args: ["-y", "context7"] } },
        claudeAiMcpEverConnected: ["claude.ai Supabase"],
      }),
    );
    const pluginsDir = path.join(root, "plugins");
    for (const [name, mcpJson] of [
      ["design", JSON.stringify({ figma: { type: "http", url: "https://mcp.figma.com/mcp" } })],
      ["ops", JSON.stringify({ mcpServers: { slack: { command: "npx", args: ["slack-mcp"] } } })],
      ["broken", "{ not json"],
    ] as const) {
      yield* fs.makeDirectory(path.join(pluginsDir, name), { recursive: true });
      yield* fs.writeFileString(path.join(pluginsDir, name, ".mcp.json"), mcpJson);
    }
    const cacheFile = path.join(root, "base", "fork-extensions", "health-cache.json");
    if (options.seedCache !== undefined) {
      yield* fs.makeDirectory(path.dirname(cacheFile), { recursive: true });
      yield* fs.writeFileString(cacheFile, options.seedCache);
    }
    const calls = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
    const layer = Layer.effect(ForkExtensions.ForkExtensions, ForkExtensions.make).pipe(
      Layer.provide(
        Layer.mergeAll(
          recordingRunner(
            calls,
            pluginList(pluginsDir, (...parts) => path.join(...parts)),
            options.codex ?? "missing",
            options.claudeMcpList,
          ),
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
          ServerConfig.layerTest(root, path.join(root, "base")),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            listShells: () =>
              Effect.succeed([
                {
                  id: ProjectId.make("project-1"),
                  title: "App",
                  workspaceRoot: path.join(root, "app"),
                  defaultModelSelection: null,
                  scripts: [],
                  createdAt: "2026-01-01T00:00:00.000Z",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                },
              ]),
          }),
          Layer.succeed(HostProcess.HomeDirectory, root),
          Layer.succeed(HostProcess.Environment, {}),
          loginPty(options.logins ?? []),
          // Hermetic spawn resolution: no real binary is looked up on this machine.
          Layer.succeed(SpawnExecutableResolution, () => undefined),
        ),
      ),
    );
    return yield* Effect.gen(function* () {
      const service = yield* ForkExtensions.ForkExtensions;
      return yield* body({ service, calls, cacheFile });
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("ForkExtensions.snapshot", () => {
  it.effect("reads config and list commands only, never `claude mcp list`", () =>
    withService(({ service, calls }) =>
      Effect.gen(function* () {
        const snapshot = decodeSnapshot(yield* service.snapshot);
        const recorded = yield* Ref.get(calls);
        expect(recorded).toContainEqual(["claude", "plugin", "list", "--json"]);
        expect(recorded).toContainEqual(["codex", "mcp", "list", "--json"]);
        expect(
          recorded.filter((call) => call[0] === "claude" && call.slice(1).join(" ") === "mcp list"),
        ).toEqual([]);
        expect(recorded.every((call) => call[0] !== "claude" || call[1] !== "mcp")).toBe(true);
        expect(snapshot.items.map((item) => item.id)).toEqual([
          "mcp:claude.ai Supabase",
          "mcp:context7",
          "mcp:plugin:design:figma",
          "mcp:plugin:ops:slack",
          "plugin:broken@synced",
          "plugin:design@synced",
          "plugin:ops@synced",
          "plugin:superpowers@claude-plugins-official",
        ]);
        // Servers declared only in the plugin's .mcp.json still get plugin rows.
        expect(snapshot.items.find((item) => item.id === "mcp:plugin:design:figma")).toMatchObject({
          transport: "plugin",
          pluginId: "design@synced",
          readOnly: true,
          source: "https://mcp.figma.com/mcp",
        });
        expect(snapshot.projects).toEqual([{ path: expect.stringMatching(/app$/), title: "App" }]);
        expect(snapshot.healthCheckedAt).toBeNull();
      }),
    ),
  );

  it.effect("keeps going when one agent's binary is missing", () =>
    withService(({ service }) =>
      Effect.gen(function* () {
        const snapshot = yield* service.snapshot;
        expect(snapshot.agents).toMatchObject([
          { agent: "claude", available: true },
          { agent: "codex", available: false, problem: { reason: "binaryNotFound" } },
        ]);
        for (const item of snapshot.items) {
          expect(item.cells.map((cell) => cell.agent)).toEqual(["claude"]);
        }
        expect(snapshot.items.find((item) => item.id === "mcp:context7")?.cells[0]).toMatchObject({
          state: "unknown",
          scopes: ["user"],
          usageCount: 0,
        });
      }),
    ),
  );
});

describe("ForkExtensions.snapshot with a failing agent", () => {
  it.effect("keeps the other agent when one agent's read fails", () =>
    withService(
      ({ service }) =>
        Effect.gen(function* () {
          const snapshot = decodeSnapshot(yield* service.snapshot);
          expect(snapshot.agents[0]).toEqual({ agent: "claude", available: true });
          expect(snapshot.agents[1]).toMatchObject({
            agent: "codex",
            available: false,
            problem: { reason: "commandFailed", rawOutput: "Error: invalid config.toml" },
          });
          expect(snapshot.items.map((item) => item.id)).toContain("mcp:context7");
          for (const item of snapshot.items) {
            expect(item.cells.map((cell) => cell.agent)).toEqual(["claude"]);
          }
        }),
      { codex: "failing" },
    ),
  );
});

describe("ForkExtensions.withWriteLock", () => {
  it.effect("runs writes one at a time", () =>
    withService(({ service }) =>
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const order = yield* Ref.make<ReadonlyArray<string>>([]);
        const first = yield* service
          .withWriteLock(
            Deferred.succeed(firstStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseFirst)),
              Effect.andThen(Ref.update(order, (all) => [...all, "first"])),
            ),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(firstStarted);
        const second = yield* service
          .withWriteLock(Ref.update(order, (all) => [...all, "second"]))
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect(yield* Ref.get(order)).toEqual([]);
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        expect(yield* Ref.get(order)).toEqual(["first", "second"]);
      }),
    ),
  );
});

describe("ForkExtensions.checkHealth", () => {
  it.effect("streams a cell per `claude mcp list` line, then done, and caches them", () =>
    withService(
      ({ service, cacheFile }) =>
        Effect.gen(function* () {
          const events = Array.from(yield* Stream.runCollect(service.checkHealth));
          const cells = events.filter((event) => event._tag === "cell");
          expect(cells).toHaveLength(5);
          expect(events.at(-1)?._tag).toBe("done");
          expect(cells.find((cell) => cell.itemId === "mcp:claude.ai Stripe")).toMatchObject({
            agent: "claude",
            state: "needsAttention",
            problem: { reason: "needsAuthorization", nextStep: "Authorize it." },
          });
          expect(cells.find((cell) => cell.itemId === "mcp:ghost")).toMatchObject({
            state: "needsAttention",
            problem: {
              reason: "commandFailed",
              summary: "Failed to connect",
              nextStep: "Check the server's command or URL, then check status again.",
            },
          });
          expect(
            cells.find((cell) => cell.itemId === "mcp:plugin:playwright:playwright"),
          ).toMatchObject({ state: "working", problem: null });

          const snapshot = decodeSnapshot(yield* service.snapshot);
          const done = events.at(-1);
          expect(snapshot.healthCheckedAt).toBe(done?._tag === "done" ? done.checkedAt : null);
          // Only claude.ai connectors and plugin servers may come from health alone.
          const ids = snapshot.items.map((item) => item.id);
          expect(ids).toContain("mcp:claude.ai Stripe");
          expect(ids).toContain("mcp:plugin:cloudflare:cloudflare");
          expect(ids).not.toContain("mcp:ghost");
          expect(
            snapshot.items.find((item) => item.id === "mcp:claude.ai Stripe")?.cells[0],
          ).toMatchObject({ state: "needsAttention" });

          const fs = yield* FileSystem.FileSystem;
          expect(JSON.parse(yield* fs.readFileString(cacheFile)).checkedAt).toBe(
            snapshot.healthCheckedAt,
          );
        }),
      { claudeMcpList: () => Effect.succeed(output(MCP_LIST)) },
    ),
  );

  it.effect("loads the persisted cache at start", () =>
    withService(
      ({ service }) =>
        Effect.gen(function* () {
          const snapshot = yield* service.snapshot;
          expect(snapshot.healthCheckedAt).toBe("2026-11-12T10:00:00.000Z");
          expect(snapshot.items.find((item) => item.id === "mcp:context7")?.cells[0]).toMatchObject(
            { state: "needsAttention", problem: { reason: "timeout" } },
          );
        }),
      {
        seedCache: JSON.stringify({
          checkedAt: "2026-11-12T10:00:00.000Z",
          cells: {
            "mcp:context7|claude": {
              state: "needsAttention",
              problem: { reason: "timeout", summary: "s", nextStep: "n", rawOutput: null },
            },
          },
        }),
      },
    ),
  );

  it.effect("reads a corrupt cache file as empty", () =>
    withService(
      ({ service }) =>
        Effect.gen(function* () {
          expect((yield* service.snapshot).healthCheckedAt).toBeNull();
        }),
      { seedCache: "{ not json" },
    ),
  );

  it.effect("two simultaneous subscriptions share one `claude mcp list`", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* withService(
        ({ service, calls }) =>
          Effect.gen(function* () {
            const first = yield* Stream.runCollect(service.checkHealth).pipe(Effect.forkChild);
            const second = yield* Stream.runCollect(service.checkHealth).pipe(Effect.forkChild);
            yield* Deferred.await(started);
            yield* Effect.yieldNow;
            yield* Deferred.succeed(release, undefined);
            const one = Array.from(yield* Fiber.join(first));
            const two = Array.from(yield* Fiber.join(second));
            expect(one).toHaveLength(6);
            expect(two).toEqual(one);
            const recorded = yield* Ref.get(calls);
            expect(
              recorded.filter((call) => call[0] === "claude" && call[1] === "mcp"),
            ).toHaveLength(1);
          }),
        {
          claudeMcpList: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(output(MCP_LIST)),
            ),
        },
      );
    }),
  );

  it.effect("turns a timeout into needsAttention/timeout cells for the installed servers", () =>
    Effect.gen(function* () {
      // The health command is "running" (sleeping on TestClock) once this fires.
      const started = yield* Deferred.make<void>();
      yield* withService(
        ({ service }) =>
          Effect.gen(function* () {
            const fiber = yield* Stream.runCollect(service.checkHealth).pipe(Effect.forkChild);
            yield* Deferred.await(started);
            yield* TestClock.adjust("61 seconds");
            const events = Array.from(yield* Fiber.join(fiber));
            const cells = events.filter((event) => event._tag === "cell");
            expect(cells.map((cell) => cell.itemId)).toEqual([
              "mcp:claude.ai Supabase",
              "mcp:context7",
              "mcp:plugin:design:figma",
              "mcp:plugin:ops:slack",
            ]);
            expect(cells[0]).toMatchObject({
              agent: "claude",
              state: "needsAttention",
              problem: { reason: "timeout" },
            });
            expect(events.at(-1)?._tag).toBe("done");
          }),
        {
          claudeMcpList: (input) =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.sleep("60 seconds")),
              Effect.andThen(
                Effect.fail(
                  new ProcessRunner.ProcessTimeoutError({
                    command: input.command,
                    argumentCount: input.args.length,
                    timeoutMs: 60_000,
                  }),
                ),
              ),
            ),
        },
      );
    }),
  );

  it.effect("Codex: enabled false is disabled, anything else working (no probe)", () =>
    withService(
      ({ service }) =>
        Effect.gen(function* () {
          const cells = Array.from(yield* Stream.runCollect(service.checkHealth)).filter(
            (event) => event._tag === "cell" && event.agent === "codex",
          );
          expect(cells).toMatchObject([
            { itemId: "mcp:docs", state: "working", problem: null },
            { itemId: "mcp:off", state: "disabled", problem: null },
          ]);
        }),
      { codex: "listed", claudeMcpList: () => Effect.succeed(output("")) },
    ),
  );
});

describe("ForkExtensions.checkHealth (Codex sign-in)", () => {
  it.effect("a remote Codex server that is not logged in needs authorization", () =>
    withService(
      ({ service }) =>
        Effect.gen(function* () {
          const cells = Array.from(yield* Stream.runCollect(service.checkHealth)).filter(
            (event) => event._tag === "cell" && event.agent === "codex",
          );
          expect(cells).toMatchObject([
            { itemId: "mcp:docs", state: "working", problem: null },
            {
              itemId: "mcp:linear",
              state: "needsAttention",
              problem: { reason: "needsAuthorization" },
            },
            { itemId: "mcp:off", state: "disabled", problem: null },
          ]);
        }),
      { codex: "listedRemote", claudeMcpList: () => Effect.succeed(output("")) },
    ),
  );
});

describe("ForkExtensions.authorize", () => {
  it.effect("logs in through the agent's CLI and marks the cached cell for a re-check", () => {
    const logins: Array<{ argv: Array<string>; typed: Array<string> }> = [];
    return withService(
      ({ service, cacheFile }) =>
        Effect.gen(function* () {
          const events = yield* service.authorize({ itemId: "mcp:context7", agent: "claude" }).pipe(
            Stream.tap((event) =>
              event._tag === "authUrl"
                ? service.authorizeComplete({
                    sessionId: event.sessionId,
                    redirectUrl: "http://localhost:5000/callback?code=abc&state=s",
                  })
                : Effect.void,
            ),
            Stream.runCollect,
          );
          expect(events.map((event) => event._tag)).toEqual(["authUrl", "done"]);
          expect(events[0]).toMatchObject({ url: "https://example.com/oauth?x=1" });
          expect(logins.map((login) => login.argv.slice(1))).toEqual([
            ["mcp", "login", "--no-browser", "context7"],
          ]);
          expect(logins[0]?.typed).toEqual(["http://localhost:5000/callback?code=abc&state=s\r"]);

          const snapshot = yield* service.snapshot;
          const cell = snapshot.items.find((item) => item.id === "mcp:context7")?.cells[0];
          expect(cell).toMatchObject({ agent: "claude", state: "unknown", problem: null });
          const fs = yield* FileSystem.FileSystem;
          expect(JSON.parse(yield* fs.readFileString(cacheFile)).cells).toEqual({
            "mcp:context7|claude": { state: "unknown", problem: null },
          });
        }),
      {
        logins,
        seedCache: JSON.stringify({
          checkedAt: "2026-11-12T10:00:00.000Z",
          cells: {
            "mcp:context7|claude": {
              state: "needsAttention",
              problem: {
                reason: "needsAuthorization",
                summary: "Needs authentication",
                nextStep: "Authorize it.",
                rawOutput: null,
              },
            },
          },
        }),
      },
    );
  });
});
