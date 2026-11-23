// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type AntigravitySettings,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { HttpClient } from "effect/http";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as AntigravityInstallation from "../AntigravityInstallation.ts";
import {
  ANTIGRAVITY_AUTH_STDOUT_PREFIX,
  resolveAntigravityInstanceDirectories,
} from "../antigravityAuthSupport.ts";
import {
  BubblewrapCandidates,
  antigravityHelperFolder,
  antigravityThreadProfileDirectory,
} from "../antigravitySandbox.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ModelManifest from "../ModelManifest.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { knownProviderFailureMessage } from "@t3tools/provider-core/server/failure";
import { resolveProviderCompatibility } from "../providerCompatibility.ts";
import { AntigravityDriver } from "./AntigravityDriver.ts";
import * as ProviderHostLive from "../ProviderHostLive.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";

const hostPlatform = HostProcess.Platform.defaultValue();
const windowsHost = hostPlatform === "win32";
const decodeRequest = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      method: Schema.optional(Schema.String),
      params: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
);
const blockedCredentialKeys = new Set([
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_GENAI_USE_VERTEXAI",
]);

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const makeHarness = Effect.fn("makeAntigravityDriverHarness")(function* (
  options: {
    readonly config?: Partial<AntigravitySettings>;
    readonly enabled?: boolean;
    /** Extra instance variables, such as ones a parent T3 turn already exported. */
    readonly environment?: ReadonlyArray<{ readonly name: string; readonly value: string }>;
    /** What the server process itself inherited, besides PATH. */
    readonly hostEnvironment?: NodeJS.ProcessEnv;
    readonly platform?: NodeJS.Platform;
    /**
     * The only `bwrap` candidate. By default a stand-in that runs the command unconfined: the
     * stand-in agent is a script in this checkout, which a real sandbox hides unless a test names
     * the checkout as a workspace folder.
     */
    readonly bubblewrap?: "real" | { readonly exitCode: number };
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const nodePath = yield* HostProcess.ExecutablePath;
  const baseEnv = yield* HostProcess.Environment;
  const root = yield* fs.makeTempDirectoryScoped(
    antigravityHelperFolder(hostPlatform, "t3-antigravity-driver-"),
  );
  const instanceId = ProviderInstanceId.make(path.basename(root));
  const mockAgentPath = yield* path.fromFileUrl(
    new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
  );
  const requestLog = path.join(root, "requests.jsonl");
  const directories = yield* resolveAntigravityInstanceDirectories(config.stateDir, instanceId);
  const profileDirectory = directories.profile;
  const instancePath = `${path.join(root, "instance-bin")}:${baseEnv.PATH ?? ""}`;

  const agentExecutables = new Set<string>();
  const makeExecutable = Effect.fn("AntigravityDriverTest.makeExecutable")(function* (
    name: string,
    options: {
      readonly loginRequired?: boolean;
      /** `data` of the agent's "Internal error" response to `session/new`. */
      readonly newSessionErrorData?: unknown;
      readonly initialMode?: string;
      readonly agentVersion?: string;
    } = {},
  ) {
    const directory = path.join(root, name);
    const executablePath = path.join(directory, "agy");
    yield* fs.makeDirectory(directory, { recursive: true });
    const authorizationUrl =
      "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2F&state=fixture-state";
    yield* fs.writeFileString(
      executablePath,
      [
        "#!/bin/sh",
        ...(options.loginRequired
          ? [`printf '%s\\n' ${shellQuote(ANTIGRAVITY_AUTH_STDOUT_PREFIX + authorizationUrl)}`]
          : []),
        ...(options.newSessionErrorData === undefined
          ? []
          : [
              `export T3_ACP_NEW_SESSION_ERROR_DATA=${shellQuote(JSON.stringify(options.newSessionErrorData))}`,
            ]),
        ...(options.initialMode === undefined
          ? []
          : [`export T3_ACP_INITIAL_MODE=${shellQuote(options.initialMode)}`]),
        `export T3_ACP_AGENT_VERSION=${shellQuote(options.agentVersion ?? "1.5.12")}`,
        `exec ${shellQuote(nodePath)} ${shellQuote(mockAgentPath)} "$@"`,
        "",
      ].join("\n"),
    );
    yield* fs.chmod(executablePath, 0o755);
    agentExecutables.add(executablePath);
    return {
      executablePath,
      source: "managed",
      version: name,
      managedVersionDirectory: directory,
    } satisfies AntigravityInstallation.AntigravityExecutable;
  });

  const bubblewrap = options.bubblewrap === "real" ? "/usr/bin/bwrap" : path.join(root, "bwrap");
  if (options.bubblewrap !== "real") {
    yield* fs.writeFileString(
      bubblewrap,
      options.bubblewrap === undefined
        ? '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n'
        : `#!/bin/sh\nexit ${options.bubblewrap.exitCode}\n`,
    );
    yield* fs.chmod(bubblewrap, 0o755);
  }
  const homeDirectory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-antigravity-home-" });
  const first = yield* makeExecutable("runtime 'one");
  const second = yield* makeExecutable("runtime two");
  const signedOut = yield* makeExecutable("runtime signed-out", { loginRequired: true });
  const controls: {
    selected: AntigravityInstallation.AntigravityExecutable;
    failResolution: boolean;
    beforeAcquire: Effect.Effect<void>;
  } = { selected: first, failResolution: false, beforeAcquire: Effect.void };
  const acquisitions: Array<{ binaryPath: string | undefined; path: string | undefined }> = [];
  const releases: Array<string | null> = [];
  const launches: Array<{
    /** The program run, and its arguments, without the sandbox in front of them. */
    command: string;
    args: ReadonlyArray<string>;
    /** The sandbox's own arguments, for a launch that went through it. */
    sandbox: ReadonlyArray<string> | undefined;
    /** Names of the variables the started process itself got: `bwrap`'s, for a sandboxed launch. */
    ownEnvironment: ReadonlyArray<string>;
    cwd: string | undefined;
    extendEnv: boolean | undefined;
    environment: Record<string, string | undefined>;
    profileDirectory: string | undefined;
    forceFileStorage: string | undefined;
    credentialKeys: ReadonlyArray<string>;
    geminiApiKey: string | undefined;
    tempDirectory: string | undefined;
    handle: ChildProcessSpawner.ChildProcessHandle;
  }> = [];

  const layerInstallation = Layer.mock(AntigravityInstallation.AntigravityInstallation)({
    managedDirectory: root,
    compatibility: (version) =>
      Effect.succeed(
        resolveProviderCompatibility(
          ModelManifest.BUNDLED_MODEL_MANIFEST.compatibility,
          ProviderDriverKind.make("antigravity"),
          version,
        ),
      ),
    resolve: () =>
      Effect.gen(function* () {
        if (controls.failResolution) {
          return yield* new AntigravityInstallation.AntigravityInstallationError({
            operation: "resolve",
            detail: "Fixture resolution failed.",
          });
        }
        return controls.selected;
      }),
    acquire: (binaryPath, environment) =>
      Effect.gen(function* () {
        acquisitions.push({ binaryPath, path: environment?.PATH });
        yield* controls.beforeAcquire;
        if (controls.failResolution) {
          return yield* new AntigravityInstallation.AntigravityInstallationError({
            operation: "resolve",
            detail: "Fixture resolution failed.",
          });
        }
        const selected = controls.selected;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            releases.push(selected.version);
          }),
        );
        return selected;
      }),
  });
  const observedSpawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand")
        return yield* Effect.die("Unexpected process pipeline.");
      const all = command.args.map(String);
      const split = command.command === bubblewrap ? all.indexOf("--") : -1;
      // In the sandbox a shell reads the agent's variables from a file it then removes:
      // `/bin/sh -c <script> <file> <program> ...`. The sandbox check runs `/bin/sh -c :`.
      const inner = split === -1 ? [command.command, ...all] : all.slice(split + 1);
      const wrapped = split !== -1 && inner.length > 4;
      const [program = command.command, ...args] = wrapped ? inner.slice(4) : inner;
      const own = command.options.env ?? {};
      const environment: typeof own = wrapped
        ? Object.fromEntries(
            [
              ...NodeFS.readFileSync(inner[3]!, "utf8").matchAll(
                /^export (\w+)='((?:[^']|'"'"')*)'$/gmu,
              ),
            ].map((line) => [line[1]!, line[2]!.replaceAll(`'"'"'`, "'")]),
          )
        : own;
      const handle = yield* spawner.spawn(command);
      const env = (name: string) => {
        const value = environment[name];
        return Redacted.isRedacted(value) ? Redacted.value(value) : value;
      };
      launches.push({
        command: program,
        args,
        sandbox: split === -1 ? undefined : all.slice(0, split),
        ownEnvironment: Object.keys(own),
        cwd: command.options.cwd,
        extendEnv: command.options.extendEnv,
        environment: Object.fromEntries(Object.keys(environment).map((name) => [name, env(name)])),
        profileDirectory: env("GEMINI_HOME"),
        forceFileStorage: env("AGY_ACP_FORCE_FILE_STORAGE"),
        credentialKeys: Object.keys(environment).filter((key) =>
          blockedCredentialKeys.has(key.toUpperCase()),
        ),
        geminiApiKey: env("GEMINI_API_KEY"),
        tempDirectory: agentExecutables.has(program) ? env("TMPDIR") : undefined,
        handle,
      });
      return handle;
    }),
  );
  const instance = yield* AntigravityDriver.create({
    instanceId,
    displayName: "Google test account",
    enabled: options.enabled ?? true,
    // Tests that open several sessions are not about the session limit.
    config: {
      ...AntigravityDriver.defaultConfig(),
      // Only Linux has the sandbox; elsewhere turning it off is the one way to run.
      sandbox: (options.platform ?? hostPlatform) === "linux",
      maxSessionProcesses: 16,
      ...options.config,
    },
    environment: [
      { name: "PATH", value: instancePath },
      { name: "T3_ACP_ANTIGRAVITY", value: "1" },
      { name: "T3_ACP_REQUEST_LOG_PATH", value: requestLog },
      { name: "GEMINI_API_KEY", value: "must-not-be-used" },
      { name: "google_api_key", value: "must-not-be-used" },
      { name: "GOOGLE_APPLICATION_CREDENTIALS", value: "/must-not-be-used.json" },
      { name: "GOOGLE_GENAI_USE_VERTEXAI", value: "true" },
      { name: "GEMINI_HOME", value: "/must-not-be-used" },
      { name: "BROWSER", value: "must-not-run" },
      ...(options.environment ?? []),
    ].map((variable) => ({ ...variable, sensitive: false })),
  }).pipe(
    Effect.provide(layerInstallation),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observedSpawner),
    Effect.provideService(HostProcess.Platform, options.platform ?? hostPlatform),
    Effect.provideService(HostProcess.HomeDirectory, homeDirectory),
    Effect.provideService(HostProcess.Environment, {
      PATH: baseEnv.PATH,
      ...options.hostEnvironment,
    }),
    Effect.provideService(BubblewrapCandidates, [bubblewrap]),
  );
  const refresh = instance.refreshModels;
  if (!refresh) return yield* Effect.die("Antigravity does not expose model refresh.");
  const readRequests = Effect.gen(function* () {
    if (!(yield* fs.exists(requestLog))) return [];
    const text = yield* fs.readFileString(requestLog);
    return yield* Effect.forEach(text.split(/\r?\n/u).filter(Boolean), (line) =>
      decodeRequest(line),
    );
  });
  const assertClosed = Effect.gen(function* () {
    for (const launch of launches) {
      yield* launch.handle.exitCode.pipe(Effect.ignore);
      expect(yield* launch.handle.isRunning).toBe(false);
      if (launch.cwd) expect(yield* fs.exists(launch.cwd)).toBe(false);
      if (launch.tempDirectory) expect(yield* fs.exists(launch.tempDirectory)).toBe(false);
    }
  });
  return {
    instance,
    refresh,
    makeExecutable,
    fs,
    path,
    profileDirectory,
    threadProfile: (threadId: string) =>
      antigravityThreadProfileDirectory(profileDirectory, threadId),
    directories,
    instancePath,
    first,
    second,
    signedOut,
    controls,
    acquisitions,
    releases,
    launches,
    readRequests,
    assertClosed,
    root,
    nodePath,
    mockAgentPath,
  };
});

const sandboxHost =
  hostPlatform === "linux" && NodeFS.existsSync("/usr/bin/bwrap") && process.getuid !== undefined;

const openThreadSession = Effect.fn("AntigravityDriverTest.openThreadSession")(function* (
  h: Effect.Success<ReturnType<typeof makeHarness>>,
  name: string,
  extraRoots: ReadonlyArray<string> = [],
) {
  const threadId = ThreadId.make(`thread-antigravity-${name}`);
  const workspace = yield* h.fs.makeTempDirectoryScoped(
    antigravityHelperFolder(hostPlatform, `t3-ag-${name}-`),
  );
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd: workspace,
    workspace: { folders: [], extraRoots: [...extraRoots] },
  });
  const modelSelection = { instanceId: h.instance.instanceId, model: "gemini-test-low" };
  const session = yield* h.instance.orchestrationAdapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make(`provider-session-antigravity-${name}`),
    modelSelection,
    runtimePolicy,
  });
  yield* session.ensureThread({ threadId, modelSelection, runtimePolicy });
  return { threadId, workspace };
});

const layerDeps = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-antigravity-driver-config-",
}).pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Unexpected quota request")),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(ModelManifest.layerTest),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
);
const layerTest = ProviderHostLive.layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(layerDeps),
);

it.layer(layerTest)("AntigravityDriver", (it) => {
  it.effect.skipIf(windowsHost)(
    "refreshes the selected executable and limits form capabilities to chat",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* h.refresh();
        const snapshot = yield* h.instance.snapshot.getSnapshot;
        expect(snapshot.status).toBe("ready");
        expect(snapshot.auth.status).toBe("authenticated");
        expect(snapshot.models.map((model) => model.slug)).toEqual([
          "gemini-test-low",
          "gemini-test-high",
        ]);
        expect(snapshot.models[0]?.aliases).toContain(ANTIGRAVITY_DEFAULT_MODEL);
        expect(snapshot.models.every((model) => model.isLegacy !== true)).toBe(true);
        expect(snapshot.slashCommands.map((command) => command.name)).toEqual(["plan", "logout"]);
        expect(snapshot.supportsTextGeneration).toBe(true);
        h.controls.selected = h.second;
        yield* h.refresh();

        expect(h.acquisitions).toEqual([
          { binaryPath: "", path: h.instancePath },
          { binaryPath: "", path: h.instancePath },
        ]);
        const agentLaunches = h.launches.filter((launch) => launch.tempDirectory !== undefined);
        expect(agentLaunches.map((launch) => launch.command)).toEqual([
          h.first.executablePath,
          h.second.executablePath,
        ]);
        for (const launch of agentLaunches) {
          expect(launch.args).toEqual([
            "acp",
            "--gemini-dir",
            h.profileDirectory,
            "--app-data-dir",
            "antigravity-acp",
          ]);
          expect(launch.profileDirectory).toBe(h.profileDirectory);
          expect(launch.forceFileStorage).toBe("1");
          expect(launch.extendEnv).toBe(false);
        }
        for (const launch of h.launches) expect(launch.credentialKeys).toEqual([]);
        expect(h.releases).toEqual([h.first.version, h.second.version]);
        const requests = yield* h.readRequests;
        expect(requests.map((request) => request.method)).toEqual([
          "initialize",
          "auth/login",
          "session/new",
          "initialize",
          "auth/login",
          "session/new",
        ]);
        expect(
          requests
            .filter((request) => request.method === "auth/login")
            .map((request) => request.params?.methodId),
        ).toEqual(["oauth-personal", "oauth-personal"]);
        expect(
          requests
            .filter((request) => request.method === "session/new")
            .map((request) => request.params?.mcpServers),
        ).toEqual([[], []]);
        yield* h.assertClosed;
        yield* h.instance.textGeneration
          .generateThreadTitle({
            cwd: h.profileDirectory,
            message: "Name this thread",
            modelSelection: { instanceId: h.instance.instanceId, model: "gemini-test-low" },
          })
          .pipe(Effect.ignore);
        const workspace = yield* h.fs.makeTempDirectoryScoped(
          antigravityHelperFolder(hostPlatform, "t3-ag-chat-"),
        );
        const threadId = ThreadId.make("thread-antigravity-capabilities");
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "approval-required",
          interactionMode: "default",
          cwd: workspace,
        });
        const modelSelection = { instanceId: h.instance.instanceId, model: "gemini-test-low" };
        const session = yield* h.instance.orchestrationAdapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-antigravity-capabilities"),
          modelSelection,
          runtimePolicy,
        });
        yield* session.ensureThread({ threadId, modelSelection, runtimePolicy });

        const helper = {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          session: { notices: {}, compaction: {} },
        };
        expect(
          (yield* h.readRequests)
            .filter((request) => request.method === "initialize")
            .map((request) => request.params?.clientCapabilities),
        ).toEqual([
          // Two model refreshes, then thread title generation.
          helper,
          helper,
          helper,
          {
            fs: { readTextFile: true, writeTextFile: false },
            terminal: false,
            session: { notices: {}, compaction: {} },
            elicitation: { form: {} },
          },
        ]);

        // The agy CLI rejects `yolo` and `auto_edit`; it stays in `default` and T3 answers its requests.
        h.controls.selected = yield* h.makeExecutable("runtime cli", { initialMode: "auto_edit" });
        for (const runtimeMode of ["full-access", "auto-accept-edits"] as const) {
          const requestsBefore = (yield* h.readRequests).length;
          const cliThreadId = ThreadId.make(`thread-antigravity-cli-${runtimeMode}`);
          const cliPolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode,
            interactionMode: "default",
            cwd: workspace,
          });
          const cliSession = yield* h.instance.orchestrationAdapter.openSession({
            threadId: cliThreadId,
            providerSessionId: ProviderSessionId.make(`provider-session-cli-${runtimeMode}`),
            modelSelection,
            runtimePolicy: cliPolicy,
          });
          yield* cliSession.ensureThread({
            threadId: cliThreadId,
            modelSelection,
            runtimePolicy: cliPolicy,
          });
          expect(h.launches.at(-1)?.args).toEqual([
            "acp",
            "--gemini-dir",
            h.threadProfile(cliThreadId),
            "--app-data-dir",
            "antigravity-acp",
          ]);
          expect(
            (yield* h.readRequests)
              .slice(requestsBefore)
              .filter(
                (request) =>
                  request.method === "session/set_config_option" &&
                  request.params?.configId === "mode",
              )
              .map((request) => request.params?.value),
          ).toEqual(["default"]);
        }
      }),
  );

  it.effect.skipIf(windowsHost)(
    "gives the agent no T3 MCP server or credential, and nothing other programs left in the server's environment",
    () =>
      Effect.gen(function* () {
        // What a server started from another agent's shell, or beside other providers, inherits.
        const foreign = {
          OPENAI_API_KEY: "sk-other-provider",
          CODEX_HOME: "/home/someone/.codex",
          T3CODE_THREAD_ID: "thread-antigravity-ambient",
          T3_ACP_MCP_ENDPOINT: "http://127.0.0.1:9/ambient",
          T3_ACP_MCP_AUTHORIZATION: "Bearer ambient-token",
        };
        const h = yield* makeHarness({ hostEnvironment: foreign });
        yield* h.refresh();
        const threadId = ThreadId.make("thread-antigravity-process-environment");
        // The session every other ACP agent would be handed as its `t3-code` MCP server.
        yield* (yield* McpProviderSessions.McpProviderSessions).set({
          environmentId: EnvironmentId.make("environment-antigravity-process-environment"),
          threadId,
          providerSessionId: "mcp-session-antigravity-process-environment",
          providerInstanceId: h.instance.instanceId,
          endpoint: "http://127.0.0.1:43126/mcp",
          authorizationHeader: "Bearer antigravity-thread-token",
          browserToolsAvailable: false,
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const workspace = yield* h.fs.makeTempDirectoryScoped(
              antigravityHelperFolder(hostPlatform, "t3-ag-environment-"),
            );
            const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: workspace,
            });
            const modelSelection = { instanceId: h.instance.instanceId, model: "gemini-test-low" };
            const session = yield* h.instance.orchestrationAdapter.openSession({
              threadId,
              providerSessionId: ProviderSessionId.make(
                "provider-session-antigravity-process-environment",
              ),
              modelSelection,
              runtimePolicy,
            });
            yield* session.ensureThread({ threadId, modelSelection, runtimePolicy });
          }),
        );

        expect(
          h.launches.filter((launch) => launch.command === h.first.executablePath),
        ).toHaveLength(2);
        // Every process the driver starts: the sandbox check, the browser check and the agent.
        for (const launch of h.launches) {
          expect(launch.extendEnv).toBe(false);
          expect(
            Object.keys(launch.environment).filter(
              (name) =>
                name in foreign || name.startsWith("T3_ACP_MCP_") || name === "T3CODE_THREAD_ID",
            ),
          ).toEqual([]);
        }
        if (hostPlatform === "linux") {
          // What runs outside the sandbox gets none of the instance's variables: `bwrap` nothing
          // at all, the browser check only what makes its Node a Node. The agent reads its own
          // inside, or it would not have found the request log the next lines read.
          expect(
            h.launches
              .map((launch) => launch.ownEnvironment)
              .filter((names) => names.some((name) => name !== "ELECTRON_RUN_AS_NODE")),
          ).toEqual([]);
        }
        expect(
          (yield* h.readRequests)
            .filter((request) => request.method === "session/new")
            .map((request) => request.params?.mcpServers),
        ).toEqual([[], []]);
        yield* h.assertClosed;
      }),
  );

  it.effect.skipIf(windowsHost)(
    "fails a session past the limit with a clear error and frees the slot when one closes",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness({ config: { maxSessionProcesses: 2 } });
        const limit =
          "Antigravity is already running 2 sessions, the limit for this provider instance. Wait for one to finish or stop one, then retry; maxSessionProcesses in the Antigravity provider settings raises the limit.";
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* openThreadSession(h, "limit-one");
            yield* Effect.scoped(
              Effect.gen(function* () {
                yield* openThreadSession(h, "limit-two");
                const refused = yield* Effect.scoped(openThreadSession(h, "limit-three")).pipe(
                  Effect.flip,
                );
                expect(knownProviderFailureMessage(refused)).toBe(limit);
                // The refused session never started a process.
                expect(
                  h.launches.filter((launch) => launch.command === h.first.executablePath),
                ).toHaveLength(2);
                // A helper is not a session: it runs on its own slot while both are taken.
                yield* h.refresh();
              }),
            );
            yield* Effect.scoped(openThreadSession(h, "limit-three"));
          }),
        );
        yield* h.assertClosed;
      }),
  );

  it.effect.skipIf(!sandboxHost)(
    "runs each thread's session in the sandbox, on that thread's own profile and its own copy of the sign-in",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness({ bubblewrap: "real" });
        const token = h.path.join(h.profileDirectory, "antigravity-acp", "antigravity-oauth-token");
        yield* h.fs.makeDirectory(h.path.dirname(token), { recursive: true });
        yield* h.fs.writeFileString(token, "sign-in");
        // The stand-in agent's script, its Node and its request log must be in workspace folders.
        const roots = [
          h.path.resolve(h.path.dirname(h.mockAgentPath), "..", "..", ".."),
          // Already there, read-only, when it is the system's own.
          ...(h.nodePath.startsWith("/usr/") ? [] : [h.path.dirname(h.nodePath)]),
          h.root,
        ];
        const launched = yield* Effect.scoped(
          Effect.gen(function* () {
            const one = yield* openThreadSession(h, "sandbox-one", roots);
            const two = yield* openThreadSession(h, "sandbox-two", roots);
            return [one, two];
          }),
        );
        const sessions = h.launches.filter(
          (launch) => launch.sandbox !== undefined && launch.command === h.first.executablePath,
        );
        const profiles = launched.map((thread) => h.threadProfile(thread.threadId));
        expect(sessions.map((launch) => launch.profileDirectory)).toEqual(profiles);
        for (const [index, launch] of sessions.entries()) {
          const profile = profiles[index]!;
          expect(launch.cwd).toBe(launched[index]?.workspace);
          expect(launch.environment.HOME).toBe(h.path.join(profile, "home"));
          const mounts = launch.sandbox?.join(" ") ?? "";
          expect(mounts).toContain(`--bind ${profile} ${profile}`);
          expect(mounts).not.toContain(profiles[1 - index]);
          // Neither the instance's profile nor its sign-in is mounted: the thread has a copy.
          expect(mounts).not.toContain(`${h.profileDirectory} `);
          expect(mounts).not.toContain(token);
          expect(
            yield* h.fs.readFileString(
              h.path.join(profile, "antigravity-acp", "antigravity-oauth-token"),
            ),
          ).toBe("sign-in");
        }
        // Both stand-in agents answered from inside the sandbox.
        const methods = (yield* h.readRequests).map((request) => request.method);
        expect(methods.filter((method) => method === "session/new")).toHaveLength(2);
      }),
  );

  for (const { name, options, message } of [
    {
      name: "with Sandbox on, on a platform without the sandbox",
      options: { platform: "darwin", config: { sandbox: true } },
      message:
        "Antigravity's sandbox only exists on Linux. On this platform, turn off Sandbox in the Antigravity provider settings to run it without isolation.",
    },
    {
      name: "on Linux where bubblewrap is refused its user namespace",
      options: { platform: "linux", bubblewrap: { exitCode: 1 } },
      message:
        "Antigravity runs inside a bubblewrap sandbox, and bubblewrap (bwrap) is missing or not allowed to create user namespaces on this machine. Install bubblewrap: on Linux Antigravity does not run without it.",
    },
    {
      name: "on Linux with Sandbox turned off",
      options: { platform: "linux", config: { sandbox: false } },
      message:
        "On Linux Antigravity only runs inside its sandbox. Turn Sandbox back on in the Antigravity provider settings.",
    },
  ] as const) {
    it.effect.skipIf(windowsHost)(`starts no agent ${name}`, () =>
      Effect.gen(function* () {
        const h = yield* makeHarness(options);
        const session = yield* Effect.scoped(openThreadSession(h, "no-sandbox")).pipe(Effect.flip);
        expect(knownProviderFailureMessage(session)).toBe(message);
        // Model refresh stands for every helper: sign-in and titles launch through the same step.
        expect((yield* h.refresh().pipe(Effect.flip)).detail).toBe(message);
        expect(h.acquisitions).toEqual([]);
        expect(
          h.launches.filter(
            (launch) => launch.command === h.first.executablePath || launch.args.includes("acp"),
          ),
        ).toEqual([]);
        expect(yield* h.fs.exists(h.profileDirectory)).toBe(false);
      }),
    );
  }

  it.effect.skipIf(windowsHost)(
    "refuses to open a session on a PATH executable older than 1.5",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const old = yield* h.makeExecutable("runtime old", { agentVersion: "1.4.5" });
        h.controls.selected = { ...old, source: "path", version: null };
        const threadId = ThreadId.make("thread-antigravity-old-runtime");
        const modelSelection = { instanceId: h.instance.instanceId, model: "gemini-test-low" };
        const error = yield* Effect.scoped(
          Effect.gen(function* () {
            const workspace = yield* h.fs.makeTempDirectoryScoped(
              antigravityHelperFolder(hostPlatform, "t3-ag-old-runtime-"),
            );
            const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
              runtimeMode: "approval-required",
              interactionMode: "default",
              cwd: workspace,
            });
            const session = yield* h.instance.orchestrationAdapter.openSession({
              threadId,
              providerSessionId: ProviderSessionId.make("provider-session-antigravity-old-runtime"),
              modelSelection,
              runtimePolicy,
            });
            yield* session.ensureThread({ threadId, modelSelection, runtimePolicy });
          }),
        ).pipe(Effect.flip);
        const message = `Antigravity 1.4.5 does not work with this T3 Code release. Update the Antigravity executable at ${old.executablePath} to >=1.5.12 <2, then retry.`;
        expect(knownProviderFailureMessage(error)).toBe(message);
        expect((yield* h.refresh().pipe(Effect.flip)).detail).toBe(message);
        const methods = (yield* h.readRequests).map((request) => request.method);
        expect(methods).toContain("initialize");
        expect(methods).not.toContain("session/new");
        yield* h.assertClosed;
      }),
  );

  it.effect.skipIf(windowsHost)(
    "closes refresh processes and clears account metadata when Google sign-in is required",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* h.refresh();
        h.controls.selected = h.signedOut;
        const error = yield* h.refresh().pipe(Effect.flip);
        expect(error.detail).toContain("Sign in to Antigravity");
        const snapshot = yield* h.instance.snapshot.getSnapshot;
        expect(snapshot.auth.status).toBe("unauthenticated");
        expect(snapshot.models).toEqual([]);
        expect(snapshot.slashCommands).toEqual([]);
        expect(snapshot.supportsTextGeneration).toBe(false);
        expect(h.acquisitions).toHaveLength(2);
        expect(h.releases).toEqual([h.first.version, h.signedOut.version]);
        yield* h.assertClosed;
      }),
  );

  it.effect.skipIf(windowsHost)("keeps the previous catalog when executable resolution fails", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.refresh();
      const before = yield* h.instance.snapshot.getSnapshot;
      h.controls.failResolution = true;
      const error = yield* h.refresh().pipe(Effect.flip);
      expect(error.detail).toContain("previous model list is unchanged");
      const after = yield* h.instance.snapshot.getSnapshot;
      expect(after.models).toEqual(before.models);
      expect(after.auth).toEqual(before.auth);
      expect(h.acquisitions).toHaveLength(2);
      expect(h.releases).toEqual([h.first.version]);
      yield* h.assertClosed;
    }),
  );

  it.effect.skipIf(windowsHost)(
    "reports the missing SOCKS dependency when session creation fails and keeps the catalog",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* h.refresh();
        const before = yield* h.instance.snapshot.getSnapshot;
        h.controls.selected = yield* h.makeExecutable("runtime socks", {
          newSessionErrorData: { details: "python-socks is required to use a SOCKS proxy" },
        });
        const error = yield* h.refresh().pipe(Effect.flip);
        expect(error.detail).toBe(
          "Could not refresh Antigravity models. The previous model list is unchanged. Antigravity reported: python-socks is required to use a SOCKS proxy",
        );
        const after = yield* h.instance.snapshot.getSnapshot;
        expect(after.models).toEqual(before.models);
        expect(after.auth).toEqual(before.auth);
        yield* h.assertClosed;
      }),
  );

  it.effect.skipIf(windowsHost)(
    "never copies unrecognized agent error details into the refresh error",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* h.refresh();
        const before = yield* h.instance.snapshot.getSnapshot;
        const generic =
          "Could not refresh Antigravity models. The previous model list is unchanged.";
        const secret = "https://accounts.example.test/o/oauth2?code=sk-secret-123";
        h.controls.selected = yield* h.makeExecutable("runtime socks with extra", {
          newSessionErrorData: {
            details: `Traceback (most recent call last):\n  proxy ${secret}\npython-socks is required to use a SOCKS proxy`,
          },
        });
        const known = yield* h.refresh().pipe(Effect.flip);
        expect(known.detail).toBe(
          `${generic} Antigravity reported: python-socks is required to use a SOCKS proxy`,
        );

        for (const [name, data] of [
          ["runtime unknown details", { details: `Token refresh failed for ${secret}` }],
          ["runtime object details", { details: { stack: "secret frame", env: { HOME: "/" } } }],
          ["runtime no details", ["python-socks is required to use a SOCKS proxy"]],
        ] as const) {
          h.controls.selected = yield* h.makeExecutable(name, { newSessionErrorData: data });
          const error = yield* h.refresh().pipe(Effect.flip);
          expect(error.detail).toBe(generic);
        }
        const after = yield* h.instance.snapshot.getSnapshot;
        expect(after.models).toEqual(before.models);
        expect(after.auth).toEqual(before.auth);
        expect(JSON.stringify(after)).not.toContain("sk-secret-123");
        yield* h.assertClosed;
      }),
  );

  it.effect.skipIf(windowsHost)(
    "removes runtime temp directories left by a previous server on create",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        const instanceId = ProviderInstanceId.make("antigravity-orphan-sweep");
        const directories = yield* resolveAntigravityInstanceDirectories(
          config.stateDir,
          instanceId,
        );
        // The agent writes its profile, so its data folder may be a link to someone else's.
        const outside = yield* fs.makeTempDirectoryScoped();
        yield* fs.makeDirectory(directories.profile, { recursive: true });
        yield* fs.symlink(outside, path.join(directories.profile, "antigravity-acp"));
        const legacyRoot = path.join(outside, "tmp");
        for (const root of [directories.runtimeTemp, legacyRoot]) {
          const orphan = path.join(root, "run-orphan", "_MEI123", "google3");
          yield* fs.makeDirectory(orphan, { recursive: true });
          yield* fs.writeFileString(path.join(orphan, "payload.bin"), "stale");
        }
        yield* AntigravityDriver.create({
          instanceId,
          displayName: "Sweep",
          enabled: false,
          config: AntigravityDriver.defaultConfig(),
          environment: [],
        }).pipe(
          Effect.provide(
            Layer.mock(AntigravityInstallation.AntigravityInstallation)({
              managedDirectory: config.stateDir,
              resolve: () => Effect.die("unused"),
              acquire: () => Effect.die("unused"),
            }),
          ),
        );
        expect(yield* fs.exists(directories.runtimeTemp)).toBe(false);
        // On Linux nothing is swept by a name inside the profile.
        expect(yield* fs.exists(legacyRoot)).toBe(hostPlatform === "linux");
      }),
  );
});
