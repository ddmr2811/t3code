// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  buildAntigravityAcpSpawnInput,
  type AntigravityProfile,
} from "./antigravityAuthSupport.ts";
import {
  antigravityProcessSandboxSpec,
  antigravityProfileDataDirectories,
  antigravitySessionProfileDirectory,
  antigravitySandboxArgs,
  antigravitySandboxMasks,
  antigravityThreadProfileDirectory,
  findUsableBubblewrap,
  linkAntigravityThreadCredentials,
  sandboxAntigravitySpawn,
} from "./antigravitySandbox.ts";

describe("Antigravity sandbox arguments", () => {
  const mounts = (args: ReadonlyArray<string>) => {
    const start = args.indexOf("/proc") + 1;
    return args.slice(start, args.indexOf("--chdir")).join(" ");
  };

  it("empties T3's state, then shows only this process's own paths on top", () => {
    const args = antigravitySandboxArgs(
      {
        masks: ["/home/ada/.t3", "/home/ada/.t3/userdata", "/tmp"],
        roots: ["/home/ada/project", "/tmp/scratch", "/home/ada/.t3/worktrees/one"],
        grants: [
          { path: "/home/ada/.t3/userdata/providers/antigravity/i/threads/t", writable: true },
          { path: "/home/ada/.t3/userdata/attachments-by-thread/t", writable: false },
        ],
        hidden: [],
      },
      "/home/ada/project",
    );
    expect(args.slice(0, 9)).toEqual([
      "--die-with-parent",
      "--unshare-pid",
      "--bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
    ]);
    expect(mounts(args)).toBe(
      [
        "--tmpfs /tmp --tmpfs /home/ada/.t3",
        "--bind /tmp/scratch /tmp/scratch",
        "--bind /home/ada/.t3/worktrees/one /home/ada/.t3/worktrees/one",
        "--ro-bind /home/ada/.t3/userdata/attachments-by-thread/t /home/ada/.t3/userdata/attachments-by-thread/t",
        "--bind /home/ada/.t3/userdata/providers/antigravity/i/threads/t /home/ada/.t3/userdata/providers/antigravity/i/threads/t",
      ].join(" "),
    );
    expect(args.slice(-3)).toEqual(["--chdir", "/home/ada/project", "--"]);
  });

  it("empties a mask again when a workspace folder holds it, and never grants a folder that does", () => {
    const args = antigravitySandboxArgs(
      {
        // A dev server keeps its state inside the worktree it runs from.
        masks: ["/home/ada/.t3", "/home/ada/.t3/worktrees/one/.t3"],
        roots: ["/home/ada/.t3/worktrees/one", "/home/ada/.t3"],
        grants: [
          { path: "/home/ada", writable: false },
          { path: "/usr/bin/agy", writable: false },
          { path: "/home/ada/.t3/worktrees/one/.t3/tools/agy", writable: false },
        ],
        hidden: ["/home/ada/.t3/worktrees/one/.t3/providers/antigravity/i/threads"],
      },
      "/home/ada/.t3/worktrees/one",
    );
    expect(mounts(args)).toBe(
      [
        "--tmpfs /home/ada/.t3",
        "--bind /home/ada/.t3 /home/ada/.t3",
        "--bind /home/ada/.t3/worktrees/one /home/ada/.t3/worktrees/one",
        "--tmpfs /home/ada/.t3 --tmpfs /home/ada/.t3/worktrees/one/.t3",
        "--ro-bind /home/ada/.t3/worktrees/one/.t3/tools/agy /home/ada/.t3/worktrees/one/.t3/tools/agy",
        "--tmpfs /home/ada/.t3/worktrees/one/.t3/providers/antigravity/i/threads",
      ].join(" "),
    );
  });
});

const sandboxHost =
  HostProcess.Platform.defaultValue() === "linux" &&
  NodeFS.existsSync("/usr/bin/bwrap") &&
  process.getuid !== undefined;

// A stand-in for `agy`: launched exactly as the driver launches it, it tries to read each path it
// is given with its own tools, the way the real agent reads the disk without asking T3.
const FAKE_AGY = `#!/bin/sh
[ "$1" = acp ] && [ "$2" = --gemini-dir ] || exit 64
for target in $FAKE_AGY_READS; do
  if cat "$target" >/dev/null 2>&1; then echo "read $target"; else echo "denied $target"; fi
done
echo mine > "$GEMINI_HOME/antigravity-acp/conversations/mine.db" && echo "wrote own conversation"
echo renewed >> "$GEMINI_HOME/antigravity-acp/antigravity-oauth-token" && echo "renewed token"
`;

function makeHome() {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-antigravity-sandbox-")),
  );
  const file = (...segments: ReadonlyArray<string>) => {
    const path = NodePath.join(root, ...segments);
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
    NodeFS.writeFileSync(path, segments.at(-1) ?? "");
    return path;
  };
  const baseDir = NodePath.join(root, "home", ".t3");
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
    baseDir,
    stateDir,
    instanceProfile,
    own,
    executablePath,
    runtimeTemp: NodePath.dirname(state("antigravity-tmp", "instance", "run-1", "keep")),
    cwd: NodePath.dirname(file("work", "source.ts")),
    extraRoot: NodePath.dirname(file("home", ".t3", "worktrees", "extra", "extra.ts")),
    ownFolder: NodePath.dirname(state("attachments-by-thread", "thread-own", "own.png")),
    token: NodePath.join(instanceProfile, "antigravity-acp", "antigravity-oauth-token"),
    allowed: {
      workspace: NodePath.join(root, "work", "source.ts"),
      extraRoot: NodePath.join(baseDir, "worktrees", "extra", "extra.ts"),
      ownAttachment: NodePath.join(stateDir, "attachments-by-thread", "thread-own", "own.png"),
      ownConversation: NodePath.join(own, "antigravity-acp", "conversations", "own.db"),
      token: NodePath.join(own, "antigravity-acp", "antigravity-oauth-token"),
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
      otherWorktree: file("home", ".t3", "worktrees", "another", "private.ts"),
      temporarySocket: file("tmux-socket"),
      serverRoot: `/proc/${process.pid}/root/etc/hostname`,
    },
    [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true, force: true }),
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

const launch = Effect.fn("AntigravitySandboxTest.launch")(function* (
  home: ReturnType<typeof makeHome>,
  thread: boolean,
  reads: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const hostEnvironment = yield* HostProcess.Environment;
  const bubblewrapPath = yield* findUsableBubblewrap();
  if (bubblewrapPath === undefined) return yield* Effect.die("bubblewrap is not usable here");
  const profileDirectory = thread ? home.own : home.instanceProfile;
  const sharedCredentials = thread
    ? yield* Effect.promise(() =>
        linkAntigravityThreadCredentials({
          instanceProfile: home.instanceProfile,
          threadProfile: home.own,
        }),
      )
    : [];
  const profile: AntigravityProfile = {
    platform: "linux",
    geminiHome: profileDirectory,
    acpDirectory: NodePath.join(profileDirectory, "antigravity-acp"),
    tokenPath: NodePath.join(profileDirectory, "antigravity-acp", "acp_token.json"),
    tempDirectory: home.runtimeTemp,
    browserCommand: "true",
  };
  const spawn = yield* Effect.promise(() =>
    sandboxAntigravitySpawn({
      bubblewrapPath,
      spawn: buildAntigravityAcpSpawnInput({
        installation: { executablePath: home.executablePath },
        profile,
        cwd: home.cwd,
        baseEnv: { PATH: hostEnvironment.PATH, FAKE_AGY_READS: reads.join(" ") },
        runtimeTempDirectory: home.runtimeTemp,
      }),
      spec: antigravityProcessSandboxSpec({
        masks: antigravitySandboxMasks({
          baseDir: home.baseDir,
          stateDir: home.stateDir,
          homeDirectory: NodePath.join(home.root, "home"),
          uid: process.getuid?.(),
          runtimeDirectory: undefined,
        }),
        executablePath: home.executablePath,
        instanceProfile: home.instanceProfile,
        profile: profileDirectory,
        runtimeTempDirectory: home.runtimeTemp,
        thread: thread
          ? { extraRoots: [home.extraRoot], attachmentsFolder: home.ownFolder, sharedCredentials }
          : undefined,
      }),
    }),
  );
  const child = yield* spawner.spawn(
    ChildProcess.make(spawn.command, [...spawn.args], {
      cwd: home.cwd,
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
    "a thread's process reads its own folders and none of T3's state or other threads'",
    () =>
      Effect.gen(function* () {
        using home = makeHome();
        const allowed = Object.values(home.allowed);
        const forbidden = Object.values(home.forbidden);
        // Outside the sandbox every one of these is readable, so a denial below is the sandbox's.
        for (const path of [...Object.values(home.forbidden).slice(0, -1), home.token]) {
          expect(NodeFS.readFileSync(path, "utf8")).not.toBe("");
        }
        const output = yield* launch(home, true, [...allowed, ...forbidden]);
        expect(output).toEqual([
          ...allowed.map((path) => `read ${path}`),
          ...forbidden.map((path) => `denied ${path}`),
          "wrote own conversation",
          "renewed token",
        ]);
        expect(
          NodeFS.readFileSync(
            NodePath.join(home.own, "antigravity-acp", "conversations", "mine.db"),
            "utf8",
          ),
        ).toBe("mine\n");
        // The sign-in is the one thing threads share: a renewal reaches the instance's file.
        expect(NodeFS.readFileSync(home.token, "utf8")).toBe("privaterenewed\n");
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live.skipIf(!sandboxHost)(
    "a setup or helper process sees the instance profile and no thread's conversations",
    () =>
      Effect.gen(function* () {
        using home = makeHome();
        const { instanceConversation, ...forbidden } = home.forbidden;
        const output = yield* launch(home, false, [
          home.allowed.workspace,
          instanceConversation,
          home.allowed.ownConversation,
          ...Object.values(forbidden),
        ]);
        expect(output.slice(0, -2)).toEqual([
          `read ${home.allowed.workspace}`,
          `read ${instanceConversation}`,
          `denied ${home.allowed.ownConversation}`,
          ...Object.values(forbidden).map((path) => `denied ${path}`),
        ]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("finds every thread's conversations for the usage history and child transcripts", () =>
    Effect.gen(function* () {
      using home = makeHome();
      const directories = yield* Effect.promise(() =>
        antigravityProfileDataDirectories(home.instanceProfile),
      );
      expect(directories.toSorted()).toEqual(
        [
          home.instanceProfile,
          home.own,
          antigravityThreadProfileDirectory(home.instanceProfile, "thread-other"),
        ]
          .map((profile) => NodePath.join(profile, "antigravity-acp"))
          .toSorted(),
      );
      const profileOf = (sessionId: string) =>
        antigravitySessionProfileDirectory({
          instanceProfile: home.instanceProfile,
          threadId: "thread-own",
          sessionId,
        });
      // A session that ran before the thread had its own profile is still read where it ran.
      expect(yield* Effect.promise(() => profileOf("own"))).toBe(home.own);
      expect(yield* Effect.promise(() => profileOf("helper"))).toBe(home.instanceProfile);
    }),
  );

  it.live.skipIf(!sandboxHost)("finds no sandbox where bubblewrap is missing", () =>
    Effect.gen(function* () {
      expect(yield* findUsableBubblewrap(["/nonexistent/bwrap", "/etc/hostname"])).toBeUndefined();
      expect(yield* findUsableBubblewrap()).toBe("/usr/bin/bwrap");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
