// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { makeAntigravityAcpAdapterFlavor } from "../orchestration-v2/Adapters/AntigravityAdapterV2.ts";
import {
  buildAntigravityAcpSpawnInput,
  prepareAntigravityProfile,
  type AntigravityProfile,
} from "./antigravityAuthSupport.ts";
import {
  AntigravityWorkspaceRefused,
  BubblewrapCandidates,
  antigravityConversationDirectories,
  antigravityProcessSandboxSpec,
  antigravitySandboxArea,
  antigravitySessionProfileDirectory,
  antigravityThreadProfileDirectory,
  copyAntigravityThreadCredentials,
  findUsableBubblewrap,
  removeAntigravityThreadCredentials,
  sandboxAntigravitySpawn,
  type AntigravitySandboxArea,
} from "./antigravitySandbox.ts";

const linuxHost = HostProcess.Platform.defaultValue() === "linux";
const sandboxHost = linuxHost && NodeFS.existsSync("/usr/bin/bwrap");
// Any file another program keeps under /opt on this machine, if one does.
const otherProgramFile = linuxHost
  ? NodeFS.globSync("/opt/*/*").find((path) => NodeFS.statSync(path).isFile())
  : undefined;

// A stand-in for `agy`: launched exactly as the driver launches it, it uses its own tools on each
// path it is given, the way the real agent reads and writes the disk without asking T3.
const FAKE_AGY = `#!/bin/sh
[ "$1" = acp ] && [ "$2" = --gemini-dir ] || exit 64
[ -z "$FAKE_AGY_WAIT" ] || read -r _ < "$FAKE_AGY_WAIT"
for target in $FAKE_AGY_READS; do
  if cat "$target" >/dev/null 2>&1; then echo "read $target"; else echo "denied $target"; fi
done
for target in $FAKE_AGY_WRITES; do
  if (echo agent > "$target") 2>/dev/null; then echo "wrote $target"; else echo "unwritable $target"; fi
done
[ -z "$FAKE_AGY_ENV" ] || env
`;
const FAKE_AGY_VARIABLES = ["FAKE_AGY_WAIT", "FAKE_AGY_READS", "FAKE_AGY_WRITES", "FAKE_AGY_ENV"];

function makeHome() {
  // Not under /tmp: the sandbox has its own, which would hide everything here by itself.
  const root = NodeFS.realpathSync(NodeFS.mkdtempSync("/var/tmp/t3-antigravity-sandbox-"));
  const temporary = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-antigravity-sandbox-"));
  NodeFS.writeFileSync(NodePath.join(temporary, "tmux-socket"), "socket");
  const file = (...segments: ReadonlyArray<string>) => {
    const path = NodePath.join(root, ...segments);
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, segments.at(-1) ?? "");
    return path;
  };
  const userHome = NodePath.join(root, "home");
  const baseDir = NodePath.join(userHome, ".t3");
  const stateDir = NodePath.join(baseDir, "userdata");
  const instanceProfile = NodePath.join(stateDir, "providers", "antigravity", "instance");
  const own = antigravityThreadProfileDirectory(instanceProfile, "thread-own");
  const other = antigravityThreadProfileDirectory(instanceProfile, "thread-other");
  const state = (...segments: ReadonlyArray<string>) =>
    file("home", ".t3", "userdata", ...segments);
  const executablePath = state("tools", "antigravity-acp", "versions", "1", "agy");
  NodeFS.writeFileSync(executablePath, FAKE_AGY);
  NodeFS.chmodSync(executablePath, 0o755);
  const paths = {
    root,
    userHome,
    area: antigravitySandboxArea({ baseDir, stateDir, homeDirectory: userHome }),
    stateDir,
    instanceProfile,
    own,
    executablePath,
    runtimeTemp: NodePath.dirname(state("antigravity-tmp", "instance", "run-1", "keep")),
    cwd: NodePath.dirname(file("home", "projects", "work", "source.ts")),
    extraRoot: NodePath.dirname(file("home", "projects", "extra", "extra.ts")),
    checkout: NodePath.dirname(file("home", ".t3", "worktrees", "project", "own", "own.ts")),
    ownFolder: NodePath.dirname(state("attachments-by-thread", "thread-own", "own.png")),
    token: NodePath.join(instanceProfile, "antigravity-acp", "antigravity-oauth-token"),
    allowed: {
      workspace: NodePath.join(userHome, "projects", "work", "source.ts"),
      extraRoot: NodePath.join(userHome, "projects", "extra", "extra.ts"),
      ownAttachment: NodePath.join(stateDir, "attachments-by-thread", "thread-own", "own.png"),
      ownConversation: NodePath.join(own, "antigravity-acp", "conversations", "own.db"),
      ownToken: NodePath.join(own, "antigravity-acp", "antigravity-oauth-token"),
    },
    forbidden: {
      attachmentStore: state("attachments", "other.png"),
      otherThreadAttachment: state("attachments-by-thread", "thread-other", "other.png"),
      database: state("statev2.sqlite"),
      secret: state("secrets", "provider.key"),
      otherProvider: state("providers", "codex", "auth.json"),
      otherThreadConversation: NodePath.join(other, "antigravity-acp", "conversations", "other.db"),
      otherThreadBrain: NodePath.join(other, "antigravity-acp", "brain", "s", "notes.md"),
      instanceConversation: NodePath.join(
        instanceProfile,
        "antigravity-acp",
        "conversations",
        "helper.db",
      ),
      instanceToken: NodePath.join(instanceProfile, "antigravity-acp", "antigravity-oauth-token"),
      otherWorktree: file("home", ".t3", "worktrees", "project", "another", "private.ts"),
      userConfig: file("home", ".config", "gh", "hosts.yml"),
      userGemini: file("home", ".gemini", "antigravity", "conversations", "mine.db"),
      otherProviderHome: file("home", ".codex", "auth.json"),
      otherT3Home: file("other-t3-home", "userdata", "secrets", "provider.key"),
      temporarySocket: NodePath.join(temporary, "tmux-socket"),
      serverRoot: `/proc/${process.pid}/root/etc/hostname`,
    },
    [Symbol.dispose]: () => {
      NodeFS.rmSync(root, { recursive: true, force: true });
      NodeFS.rmSync(temporary, { recursive: true, force: true });
    },
  };
  for (const path of [
    paths.allowed.ownConversation,
    paths.forbidden.otherThreadConversation,
    paths.forbidden.otherThreadBrain,
    paths.forbidden.instanceConversation,
    paths.token,
  ]) {
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, "private");
  }
  return paths;
}

type Home = ReturnType<typeof makeHome>;

const launch = Effect.fn("AntigravitySandboxTest.launch")(function* (
  home: Home,
  options: {
    readonly thread: boolean;
    readonly cwd?: string;
    readonly area?: AntigravitySandboxArea;
    readonly environment?: NodeJS.ProcessEnv;
  },
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const hostEnvironment = yield* HostProcess.Environment;
  const bubblewrapPath = yield* findUsableBubblewrap();
  if (bubblewrapPath === undefined) return yield* Effect.die("bubblewrap is not usable here");
  const profileDirectory = options.thread ? home.own : home.instanceProfile;
  if (options.thread) {
    yield* Effect.promise(() =>
      copyAntigravityThreadCredentials({
        instanceProfile: home.instanceProfile,
        threadProfile: home.own,
      }),
    );
  }
  const profile: AntigravityProfile = {
    platform: "linux",
    helperExecutable: "/bin/true",
    instanceVariables: new Set(FAKE_AGY_VARIABLES),
    geminiHome: profileDirectory,
    acpDirectory: NodePath.join(profileDirectory, "antigravity-acp"),
    tokenPath: NodePath.join(profileDirectory, "antigravity-acp", "acp_token.json"),
    tempDirectory: home.runtimeTemp,
    browserCommand: "true",
  };
  const cwd = options.cwd ?? home.cwd;
  const spawn = yield* Effect.promise(() =>
    sandboxAntigravitySpawn({
      bubblewrapPath,
      spawn: buildAntigravityAcpSpawnInput({
        installation: { executablePath: home.executablePath },
        profile,
        cwd,
        baseEnv: { PATH: hostEnvironment.PATH, ...options.environment },
        runtimeTempDirectory: home.runtimeTemp,
      }),
      spec: antigravityProcessSandboxSpec({
        area: options.area ?? home.area,
        profile: profileDirectory,
        runtimeTempDirectory: home.runtimeTemp,
        thread: options.thread
          ? { extraRoots: [home.extraRoot], attachmentsFolder: home.ownFolder }
          : undefined,
      }),
    }),
  );
  // bwrap runs outside the sandbox and gets no variable; the agent reads its own inside.
  expect(spawn.env).toEqual({});
  const child = yield* spawner.spawn(
    ChildProcess.make(spawn.command, [...spawn.args], {
      cwd,
      env: spawn.env ?? {},
      extendEnv: false,
      shell: false,
    }),
  );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectUint8StreamText({ stream: child.stdout, maxBytes: 65_536 }),
      collectUint8StreamText({ stream: child.stderr, maxBytes: 65_536 }),
      child.exitCode,
    ],
    { concurrency: "unbounded" },
  );
  expect({ exitCode: Number(exitCode), stderr: stderr.text }).toEqual({ exitCode: 0, stderr: "" });
  return stdout.text.trimEnd().split("\n");
}, Effect.scoped);

describe("Antigravity sandbox with real bubblewrap", () => {
  it.live.skipIf(!sandboxHost)(
    "a thread's process sees its own folders and nothing else of T3, the home directory or other threads",
    () =>
      Effect.gen(function* () {
        using home = makeHome();
        const allowed = Object.values(home.allowed);
        const forbidden = Object.values(home.forbidden);
        // Outside the sandbox every one of these is readable, so a denial below is the sandbox's.
        for (const path of forbidden.slice(0, -1)) {
          expect(NodeFS.readFileSync(path, "utf8")).not.toBe("");
        }
        const written = NodePath.join(home.cwd, "written.ts");
        const hostHomeFile = NodePath.join(home.userHome, ".bashrc");
        const output = yield* launch(home, {
          thread: true,
          environment: {
            FAKE_AGY_READS: [...allowed, ...forbidden].join(" "),
            FAKE_AGY_WRITES: [
              written,
              home.allowed.ownToken,
              home.allowed.ownAttachment,
              hostHomeFile,
            ].join(" "),
          },
        });
        expect(output).toEqual([
          ...allowed.map((path) => `read ${path}`),
          ...forbidden.map((path) => `denied ${path}`),
          `wrote ${written}`,
          `wrote ${home.allowed.ownToken}`,
          `unwritable ${home.allowed.ownAttachment}`,
          // The home directory it sees is an empty stand-in that ends with the process.
          `wrote ${hostHomeFile}`,
        ]);
        expect(NodeFS.readFileSync(written, "utf8")).toBe("agent\n");
        expect(NodeFS.existsSync(hostHomeFile)).toBe(false);
        // Renewing or replacing its own copy of the sign-in leaves every other thread's source.
        expect(NodeFS.readFileSync(home.token, "utf8")).toBe("private");
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live.skipIf(!sandboxHost)(
    "a thread working in its own T3 worktree sees that checkout and no other",
    () =>
      Effect.gen(function* () {
        using home = makeHome();
        const own = NodePath.join(home.checkout, "own.ts");
        const output = yield* launch(home, {
          thread: true,
          cwd: home.checkout,
          environment: {
            FAKE_AGY_READS: [own, home.forbidden.otherWorktree, home.forbidden.database].join(" "),
          },
        });
        expect(output).toEqual([
          `read ${own}`,
          `denied ${home.forbidden.otherWorktree}`,
          `denied ${home.forbidden.database}`,
        ]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live.skipIf(!sandboxHost)(
    "a workspace that holds T3's state, as a dev server's does, shows the workspace without it",
    () =>
      Effect.gen(function* () {
        using home = makeHome();
        const devState = NodePath.join(home.cwd, ".t3");
        const devSecret = NodePath.join(devState, "userdata", "secrets", "provider.key");
        NodeFS.mkdirSync(NodePath.dirname(devSecret), { recursive: true });
        NodeFS.writeFileSync(devSecret, "private");
        const output = yield* launch(home, {
          thread: true,
          area: { ...home.area, state: [...home.area.state, devState] },
          environment: { FAKE_AGY_READS: [home.allowed.workspace, devSecret].join(" ") },
        });
        expect(output).toEqual([`read ${home.allowed.workspace}`, `denied ${devSecret}`]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live.skipIf(!sandboxHost)(
    "a helper process started before any thread profile exists never sees one made later",
    () =>
      Effect.gen(function* () {
        using home = makeHome();
        NodeFS.rmSync(NodePath.dirname(home.own), { recursive: true });
        const gate = NodePath.join(home.cwd, "gate");
        NodeChildProcess.execFileSync("mkfifo", [gate]);
        const late = NodePath.join(
          antigravityThreadProfileDirectory(home.instanceProfile, "thread-late"),
          "antigravity-acp",
          "conversations",
          "late.db",
        );
        const releaseWriter = Effect.sync(() => {
          const { O_NONBLOCK, O_RDONLY } = NodeFS.constants;
          NodeFS.closeSync(NodeFS.openSync(gate, O_RDONLY | O_NONBLOCK));
        });
        const [output] = yield* Effect.all(
          [
            launch(home, {
              thread: false,
              environment: {
                FAKE_AGY_WAIT: gate,
                FAKE_AGY_READS: [home.forbidden.instanceConversation, late].join(" "),
              },
            }).pipe(Effect.onError(() => releaseWriter)),
            Effect.promise(async () => {
              // Opening the pipe returns once the agent, already in its namespace, reads it.
              const writer = await NodeFSP.open(gate, "w");
              NodeFS.mkdirSync(NodePath.dirname(late), { recursive: true });
              NodeFS.writeFileSync(late, "private");
              await writer.close();
            }),
          ],
          { concurrency: 2 },
        );
        expect(output).toEqual([`read ${home.forbidden.instanceConversation}`, `denied ${late}`]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live.skipIf(!sandboxHost)(
    "the agent gets a private HOME and none of the variables other programs left in the server's environment",
    () =>
      Effect.gen(function* () {
        using home = makeHome();
        const foreign = {
          OPENAI_API_KEY: "sk-other-provider",
          ANTHROPIC_API_KEY: "sk-ant-other-provider",
          CODEX_HOME: "/home/someone/.codex",
          T3CODE_HOME: "/home/someone/.t3",
          T3_ACP_MCP_ENDPOINT: "http://127.0.0.1:9/ambient",
          T3_ACP_MCP_AUTHORIZATION: "Bearer ambient-token",
          XDG_RUNTIME_DIR: "/run/user/1000",
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
          SSH_AUTH_SOCK: "/run/user/1000/agent.sock",
          HOME: home.userHome,
        };
        const output = yield* launch(home, {
          thread: true,
          environment: { ...foreign, LANG: "C.UTF-8", FAKE_AGY_ENV: "1" },
        });
        const variables = new Map(
          output.map((line) => [
            line.slice(0, line.indexOf("=")),
            line.slice(line.indexOf("=") + 1),
          ]),
        );
        const { HOME: _home, ...absent } = foreign;
        expect(Object.keys(absent).filter((name) => variables.has(name))).toEqual([]);
        expect(variables.get("HOME")).toBe(NodePath.join(home.own, "home"));
        expect(variables.get("LANG")).toBe("C.UTF-8");
        expect(variables.get("GEMINI_HOME")).toBe(home.own);
        // The file the variables were read from does not outlive the launch.
        expect(NodeFS.readdirSync(home.runtimeTemp)).toEqual(["keep"]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live.skipIf(!sandboxHost || otherProgramFile === undefined)(
    "shows nothing other programs installed under /opt",
    () =>
      Effect.gen(function* () {
        using home = makeHome();
        const output = yield* launch(home, {
          thread: true,
          environment: { FAKE_AGY_READS: `/etc/hostname ${otherProgramFile}` },
        });
        expect(output).toEqual(["read /etc/hostname", `denied ${otherProgramFile}`]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live.skipIf(!sandboxHost)("finds no sandbox where bubblewrap is missing or refused", () =>
    Effect.gen(function* () {
      using home = makeHome();
      // Installed, but refused its user namespace, as under an AppArmor policy.
      const refused = NodePath.join(home.root, "bwrap");
      NodeFS.writeFileSync(refused, "#!/bin/sh\nexit 1\n");
      NodeFS.chmodSync(refused, 0o755);
      const find = (candidates: ReadonlyArray<string>) =>
        findUsableBubblewrap().pipe(Effect.provideService(BubblewrapCandidates, candidates));
      expect(yield* find(["/nonexistent/bwrap", "/etc/hostname", refused])).toBeUndefined();
      expect(yield* find([refused, "/usr/bin/bwrap"])).toBe("/usr/bin/bwrap");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("Antigravity sandbox rules", () => {
  it.skipIf(!linuxHost)(
    "refuses a workspace folder inside T3's state or holding the home directory",
    async () => {
      using home = makeHome();
      const link = NodePath.join(home.cwd, "innocent");
      NodeFS.symlinkSync(NodePath.join(home.stateDir, "secrets"), link);
      const refuses = (cwd: string, extraRoots: ReadonlyArray<string> = []) =>
        expect(
          sandboxAntigravitySpawn({
            bubblewrapPath: "/usr/bin/bwrap",
            spawn: { command: home.executablePath, args: [], cwd },
            spec: {
              ...antigravityProcessSandboxSpec({
                area: home.area,
                profile: home.own,
                runtimeTempDirectory: home.runtimeTemp,
              }),
              extraRoots,
            },
          }),
        ).rejects.toBeInstanceOf(AntigravityWorkspaceRefused);
      await refuses(NodePath.join(home.stateDir, "providers", "codex"));
      await refuses(home.own);
      // A link is the folder it names.
      await refuses(link);
      await refuses(home.cwd, [link]);
      // Another thread's checkout, and the folder of every checkout of a project.
      await refuses(home.cwd, [NodePath.dirname(home.forbidden.otherWorktree)]);
      await refuses(NodePath.dirname(home.checkout));
      await refuses(home.userHome);
      await refuses(home.root);
      await refuses(NodePath.join(home.cwd, "missing"));
      // What the sandbox mounts for itself: a workspace there would put the host's back.
      const temporary = NodePath.dirname(home.forbidden.temporarySocket);
      for (const reserved of ["/", "/tmp", temporary, "/proc", "/dev", "/sys", "/etc", "/usr"]) {
        await refuses(reserved);
        await refuses(home.cwd, [reserved]);
      }
      await refuses(home.cwd, ["/usr/share"]);
      // `agy` has a private HOME only where T3 made that folder; the agent can write its parent.
      const privateHome = NodePath.join(home.own, "home");
      NodeFS.symlinkSync(home.userHome, privateHome);
      await refuses(home.cwd);
      NodeFS.rmSync(privateHome);
      NodeFS.writeFileSync(privateHome, "");
      await refuses(home.cwd);
    },
  );

  it.live.skipIf(!linuxHost)(
    "a client file read is refused wherever the sandbox would not show the file",
    () =>
      Effect.gen(function* () {
        using home = makeHome();
        const devState = NodePath.join(home.cwd, ".t3");
        const devSecret = NodePath.join(devState, "secrets", "provider.key");
        NodeFS.mkdirSync(NodePath.dirname(devSecret), { recursive: true });
        NodeFS.writeFileSync(devSecret, "private");
        const flavor = makeAntigravityAcpAdapterFlavor({
          instanceId: ProviderInstanceId.make("antigravity-test"),
          random: undefined as never,
          fileSystem: yield* FileSystem.FileSystem,
          path: yield* Path.Path,
          host: { paths: { attachmentsDir: NodePath.join(home.stateDir, "attachments") } } as never,
          selfInvocation: undefined as never,
          makeRuntime: () => Effect.succeed({} as never),
          withProcess: (_stop, task) => task,
          defaultModel: Effect.undefined,
          sandbox: {
            threadProfileDirectory: () => home.own,
            area: { ...home.area, state: [...home.area.state, devState] },
          },
        });
        const read = (cwd: string, path: string) =>
          flavor
            .clientFileSystem!.readTextFile(
              { sessionId: "session", path },
              cwd,
              ThreadId.make("thread-own"),
            )
            .pipe(
              Effect.map((response) => response.content),
              Effect.orElseSucceed(() => "refused"),
            );
        expect(yield* read(home.cwd, home.allowed.workspace)).toBe("source.ts");
        expect(yield* read(home.cwd, devSecret)).toBe("refused");
        // A further workspace folder is read once the thread's process was launched with it.
        expect(yield* read(home.cwd, home.allowed.extraRoot)).toBe("refused");
        yield* flavor
          .makeRuntime({
            threadId: ThreadId.make("thread-own"),
            cwd: home.cwd,
            extraRoots: [home.extraRoot],
            runtimePolicy: {},
          } as never)
          .pipe(Effect.provideService(SecureRandom.SecureRandom, undefined as never));
        expect(yield* read(home.cwd, home.allowed.extraRoot)).toBe("extra.ts");
        expect(yield* read(home.cwd, home.forbidden.userConfig)).toBe("refused");
        // A session whose working directory is the home directory is never launched; its reads
        // are not served either, least of all T3's own secrets below it.
        expect(yield* read(home.userHome, home.forbidden.secret)).toBe("refused");
        expect(yield* read(home.userHome, home.forbidden.userConfig)).toBe("refused");
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live.skipIf(!linuxHost)(
    "links the agent left in its profile never redirect what T3 writes or copies there",
    () =>
      Effect.gen(function* () {
        using home = makeHome();
        const victim = NodePath.join(home.root, "victim");
        NodeFS.mkdirSync(victim, { mode: 0o755 });
        NodeFS.writeFileSync(NodePath.join(victim, "settings.json"), "victim");
        NodeFS.writeFileSync(NodePath.join(victim, "keep"), "victim");
        const data = NodePath.join(home.own, "antigravity-acp");
        const prepare = prepareAntigravityProfile({
          profileDirectory: home.own,
          runtimeExecutablePath: process.execPath,
          platform: "linux",
          baseEnv: {},
          tempDirectory: home.runtimeTemp,
          isolated: true,
        });
        const copy = Effect.promise(() =>
          copyAntigravityThreadCredentials({
            instanceProfile: home.instanceProfile,
            threadProfile: home.own,
          }).then(
            () => "copied",
            () => "refused",
          ),
        );

        // Files T3 writes by name, replaced by links to another program's file and folder.
        NodeFS.symlinkSync(
          NodePath.join(victim, "settings.json"),
          NodePath.join(data, "settings.json"),
        );
        NodeFS.symlinkSync(
          NodePath.join(victim, "keep"),
          NodePath.join(data, "antigravity-oauth-token"),
        );
        // The instance's sign-in replaced by a link to a file no thread may read.
        NodeFS.symlinkSync(
          home.forbidden.secret,
          NodePath.join(home.instanceProfile, "antigravity-acp", "acp_token.json"),
        );
        yield* prepare;
        expect(yield* copy).toBe("copied");
        expect(NodeFS.lstatSync(NodePath.join(data, "settings.json")).isFile()).toBe(true);
        expect(NodeFS.readFileSync(NodePath.join(data, "antigravity-oauth-token"), "utf8")).toBe(
          "private",
        );
        expect(NodeFS.existsSync(NodePath.join(data, "acp_token.json"))).toBe(false);

        // The whole folder replaced by a link: nothing is written, chmodded or removed through it.
        NodeFS.rmSync(data, { recursive: true });
        NodeFS.symlinkSync(victim, data);
        expect((yield* prepare.pipe(Effect.flip))._tag).toBe("AcpTransportError");
        expect(yield* copy).toBe("refused");

        expect(NodeFS.readdirSync(victim).toSorted()).toEqual(["keep", "settings.json"]);
        expect(NodeFS.readFileSync(NodePath.join(victim, "settings.json"), "utf8")).toBe("victim");
        expect(NodeFS.readFileSync(NodePath.join(victim, "keep"), "utf8")).toBe("victim");
        expect(NodeFS.statSync(victim).mode & 0o777).toBe(0o755);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.skipIf(!linuxHost)(
    "a sign-out fails while one thread's copy of the sign-in is out of reach, and removes the rest",
    async () => {
      using home = makeHome();
      const other = antigravityThreadProfileDirectory(home.instanceProfile, "thread-other");
      const copyOf = (profile: string) =>
        NodePath.join(profile, "antigravity-acp", "antigravity-oauth-token");
      for (const threadProfile of [home.own, other]) {
        await copyAntigravityThreadCredentials({
          instanceProfile: home.instanceProfile,
          threadProfile,
        });
      }
      // One thread's agent moved its data folder and left a link: its copy cannot be removed.
      const moved = NodePath.join(home.own, "moved");
      NodeFS.renameSync(NodePath.dirname(copyOf(home.own)), moved);
      NodeFS.symlinkSync(moved, NodePath.dirname(copyOf(home.own)));

      await expect(removeAntigravityThreadCredentials(home.instanceProfile)).rejects.toThrow();
      expect(NodeFS.existsSync(copyOf(other))).toBe(false);
      expect(NodeFS.existsSync(NodePath.join(moved, "antigravity-oauth-token"))).toBe(true);
    },
  );

  it("reads a thread's conversations from its own profile, and no folder a link stands in for", async () => {
    using home = makeHome();
    const conversations = (profile: string) =>
      NodePath.join(profile, "antigravity-acp", "conversations");
    const other = antigravityThreadProfileDirectory(home.instanceProfile, "thread-other");
    const profileOf = (sessionId: string) =>
      antigravitySessionProfileDirectory({
        instanceProfile: home.instanceProfile,
        threadId: "thread-own",
        sessionId,
      });
    expect((await antigravityConversationDirectories(home.instanceProfile)).toSorted()).toEqual(
      [home.instanceProfile, home.own, other].map(conversations).toSorted(),
    );
    expect(await profileOf("own")).toBe(home.own);
    // The instance's own profile holds helper sessions: it is never read for a thread.
    expect(await profileOf("helper")).toBeUndefined();

    // The agent points its conversations at another thread's.
    NodeFS.rmSync(conversations(home.own), { recursive: true });
    NodeFS.symlinkSync(conversations(other), conversations(home.own));
    expect((await antigravityConversationDirectories(home.instanceProfile)).toSorted()).toEqual(
      [home.instanceProfile, other].map(conversations).toSorted(),
    );
    expect(await profileOf("other")).toBeUndefined();
  });
});
