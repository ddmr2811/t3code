// @effect-diagnostics nodeBuiltinImport:off -- realpath names what the kernel mounts, and only open flags refuse a link.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { antigravityManagedPath } from "./acp/AntigravityProfilePaths.ts";

/** The places no `agy` process may see, and the one exception among them. */
export interface AntigravitySandboxArea {
  /** T3's own data. A workspace folder inside it is refused; one that holds it has it emptied. */
  readonly state: ReadonlyArray<string>;
  /** A workspace folder holding the home directory would show every other program's files. */
  readonly homeDirectory: string;
  /** T3's worktrees: a thread's own checkout is the only workspace folder allowed inside `state`. */
  readonly worktreesDirectory: string;
}

/**
 * What one `agy` process may see. The agent's own tools read the disk without asking T3, so the
 * limit is a mount namespace that starts empty: the kernel shows only what is listed here.
 */
export interface AntigravitySandboxSpec {
  readonly area: AntigravitySandboxArea;
  /** Workspace folders besides the working directory, writable. */
  readonly extraRoots: ReadonlyArray<string>;
  /** T3-owned files and folders this process needs. */
  readonly grants: ReadonlyArray<{ readonly path: string; readonly writable: boolean }>;
  /** The process's HOME, inside a writable grant. */
  readonly home: string;
  /** A writable grant only this process uses, removed when it ends. */
  readonly temp: string;
}

/** Canonical paths. Where they nest, the deepest one decides what a path below it shows. */
export interface AntigravitySandboxView {
  readonly roots: ReadonlyArray<string>;
  readonly masks: ReadonlyArray<string>;
  readonly grants: ReadonlyArray<{ readonly path: string; readonly writable: boolean }>;
}

/** Fixed paths, not PATH: the AppArmor profile that allows user namespaces names the binary. */
export const BubblewrapCandidates = Context.Reference<ReadonlyArray<string>>(
  "t3/provider/antigravitySandbox/BubblewrapCandidates",
  { defaultValue: () => ["/usr/bin/bwrap", "/usr/local/bin/bwrap", "/bin/bwrap"] },
);

export const ANTIGRAVITY_SANDBOX_UNAVAILABLE =
  "Antigravity runs inside a bubblewrap sandbox, and bubblewrap (bwrap) is missing or not allowed to create user namespaces on this machine. Install bubblewrap: on Linux Antigravity does not run without it.";

export const ANTIGRAVITY_SANDBOX_LINUX_ONLY =
  "Antigravity's sandbox only exists on Linux. On this platform, turn off Sandbox in the Antigravity provider settings to run it without isolation.";

export const ANTIGRAVITY_SANDBOX_REQUIRED =
  "On Linux Antigravity only runs inside its sandbox. Turn Sandbox back on in the Antigravity provider settings.";

/** A workspace folder the sandbox will not show; `detail` is written for the user. */
export class AntigravityWorkspaceRefused extends Schema.TaggedError<AntigravityWorkspaceRefused>()(
  "AntigravityWorkspaceRefused",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

// The operating system, read-only. No home directory, no /run, no /var: sockets there lead outside.
const SYSTEM_DIRECTORIES = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32",
  "/etc",
  "/sys",
];
// Other programs install here, so these are mounted only when `agy` itself lives in one.
const EXECUTABLE_DIRECTORIES = ["/opt", "/nix"];
// What the sandbox mounts for itself. A workspace folder mounted over, under or in place of one
// would put the host's back: its /tmp sockets, its /proc, a writable piece of the system.
const RESERVED_DIRECTORIES = [...SYSTEM_DIRECTORIES, "/dev", "/proc", "/tmp"];

/** Where T3 makes a setup or helper process's working folder: one under /tmp is refused. */
export const antigravityHelperFolder = (platform: NodeJS.Platform, prefix: string) => ({
  prefix,
  ...(platform === "linux" ? { directory: "/var/tmp" } : {}),
});

function isWithin(path: string, parent: string): boolean {
  const relative = NodePath.relative(parent, path);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`) &&
      !NodePath.isAbsolute(relative))
  );
}

const canonical = (path: string) => NodeFSP.realpath(path).catch(() => undefined);

async function canonicalAll(paths: ReadonlyArray<string>): Promise<Array<string>> {
  return (await Promise.all(paths.map(canonical))).filter((path) => path !== undefined);
}

export function antigravitySandboxArea(input: {
  readonly baseDir: string;
  readonly stateDir: string;
  readonly homeDirectory: string;
}): AntigravitySandboxArea {
  return {
    // A dev server keeps its state elsewhere; the installed app's stays hidden from it too.
    state: [input.baseDir, input.stateDir, NodePath.join(input.homeDirectory, ".t3")],
    homeDirectory: input.homeDirectory,
    // The same join as the server's `worktreesDir`, which provider hosts are not told.
    worktreesDirectory: NodePath.join(input.baseDir, "worktrees"),
  };
}

/**
 * The workspace folders a session may have, after resolving links, and the parts of T3's state
 * they hold. Fails for a folder that would show what the sandbox exists to hide.
 */
export async function antigravityWorkspaceView(input: {
  readonly area: AntigravitySandboxArea;
  readonly cwd: string;
  readonly extraRoots: ReadonlyArray<string>;
  /** Further folders this launch mounts for itself. */
  readonly reserved?: ReadonlyArray<string>;
}): Promise<Pick<AntigravitySandboxView, "roots" | "masks">> {
  const cwd = await canonical(input.cwd);
  if (cwd === undefined) {
    throw new AntigravityWorkspaceRefused({
      detail: `Antigravity cannot work in ${input.cwd}: the folder does not exist.`,
    });
  }
  const state = await canonicalAll(input.area.state);
  const home = (await canonical(input.area.homeDirectory)) ?? input.area.homeDirectory;
  const worktrees = await canonical(input.area.worktreesDirectory);
  const roots = [...new Set([cwd, ...(await canonicalAll(input.extraRoots))])];
  const named = [...RESERVED_DIRECTORIES, ...(input.reserved ?? [])];
  // `/bin` is often a link into `/usr`; a root is compared with both names.
  const reserved = [...named, ...(await canonicalAll(named))];
  for (const root of roots) {
    const taken = reserved.find((mount) => isWithin(root, mount) || isWithin(mount, root));
    if (taken !== undefined) {
      throw new AntigravityWorkspaceRefused({
        detail: `Antigravity cannot work in ${root}: its sandbox keeps ${taken} for itself. Use a project folder elsewhere.`,
      });
    }
    if (isWithin(home, root)) {
      throw new AntigravityWorkspaceRefused({
        detail: `Antigravity cannot work in ${root}: it holds your home directory, and with it every other program's files. Use a project folder.`,
      });
    }
    // `worktrees/<project>/<checkout>`: the folder of one checkout, never the folder of them all.
    const ownCheckout =
      root === cwd &&
      worktrees !== undefined &&
      isWithin(root, worktrees) &&
      NodePath.relative(worktrees, root).split(NodePath.sep).length >= 2;
    if (!ownCheckout && state.some((directory) => isWithin(root, directory))) {
      throw new AntigravityWorkspaceRefused({
        detail: `Antigravity cannot work in ${root}: it is inside T3 Code's own data.`,
      });
    }
  }
  return {
    roots,
    masks: state.filter((directory) => roots.some((root) => isWithin(directory, root))),
  };
}

/** Whether a canonical path is one the view shows: the deepest folder holding it is not a mask. */
export function antigravityViewShows(
  view: Pick<AntigravitySandboxView, "roots" | "masks">,
  path: string,
): boolean {
  const deepest = (folders: ReadonlyArray<string>) =>
    Math.max(-1, ...folders.filter((folder) => isWithin(path, folder)).map((f) => f.length));
  return deepest(view.roots) > deepest(view.masks);
}

/** Arguments for `bwrap`, up to and including `--`. Every path must already be canonical. */
function antigravitySandboxArgs(
  view: AntigravitySandboxView,
  cwd: string,
  executableDirectories: ReadonlyArray<string> = [],
): ReadonlyArray<string> {
  const listed = [
    ...view.roots.map((path) => ({ path, args: ["--bind", path, path] })),
    ...view.masks.map((path) => ({ path, args: ["--tmpfs", path] })),
    ...view.grants.map(({ path, writable }) => ({
      path,
      args: [writable ? "--bind" : "--ro-bind", path, path],
    })),
  ];
  // A folder is mounted once, after the ones that hold it, so the deepest decides.
  const mounts = [
    ...new Map(listed.map((mount) => [mount.args.join("\0"), mount])).values(),
  ].toSorted((left, right) => left.path.length - right.path.length);
  return [
    "--die-with-parent",
    // Without its own session the agent could type into the terminal the server was started from.
    "--new-session",
    // A fresh /proc lists only the sandbox, so `/proc/<pid>/root` of an outside process is absent.
    "--unshare-pid",
    ...[...SYSTEM_DIRECTORIES, ...executableDirectories].flatMap((directory) => [
      "--ro-bind-try",
      directory,
      directory,
    ]),
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
    ...mounts.flatMap((mount) => mount.args),
    "--chdir",
    cwd,
    "--",
  ];
}

/** What one process may see: a thread's session, or a setup or helper process without `thread`. */
export function antigravityProcessSandboxSpec(input: {
  readonly area: AntigravitySandboxArea;
  /** This process's GEMINI_HOME: the thread's profile, or the instance's. */
  readonly profile: string;
  readonly runtimeTempDirectory: string;
  /** The Node that answers the agent's BROWSER command with the sign-in link. */
  readonly helperExecutable?: string;
  readonly thread?:
    | {
        readonly extraRoots: ReadonlyArray<string>;
        readonly attachmentsFolder: string | null;
      }
    | undefined;
}): AntigravitySandboxSpec {
  const { thread } = input;
  return {
    area: input.area,
    extraRoots: thread?.extraRoots ?? [],
    grants: [
      { path: input.profile, writable: true },
      { path: input.runtimeTempDirectory, writable: true },
      ...(input.helperExecutable ? [{ path: input.helperExecutable, writable: false }] : []),
      ...(thread?.attachmentsFolder ? [{ path: thread.attachmentsFolder, writable: false }] : []),
    ],
    home: NodePath.join(input.profile, "home"),
    temp: input.runtimeTempDirectory,
  };
}

/** The first bubblewrap that can build the sandbox here; AppArmor may forbid its user namespace. */
export const findUsableBubblewrap = Effect.fn("antigravitySandbox.findUsableBubblewrap")(
  function* () {
    const candidates = yield* BubblewrapCandidates;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    for (const candidate of candidates) {
      const info = yield* Effect.promise(() => NodeFSP.stat(candidate).catch(() => undefined));
      if (info?.isFile() !== true) continue;
      const usable = yield* spawner
        .spawn(
          ChildProcess.make(
            candidate,
            [
              ...antigravitySandboxArgs({ roots: [], masks: [], grants: [] }, "/"),
              "/bin/sh",
              "-c",
              ":",
            ],
            { shell: false, env: {}, extendEnv: false },
          ),
        )
        .pipe(
          Effect.flatMap((child) => child.exitCode),
          Effect.map((exitCode) => Number(exitCode) === 0),
          Effect.scoped,
          Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.succeed(false) }),
          Effect.orElseSucceed(() => false),
        );
      if (usable) return candidate;
    }
    return undefined;
  },
);

// Where `agy` keeps a Google sign-in: 1.4 and 1.5 use different files.
const SHARED_CREDENTIAL_FILES = ["acp_token.json", "antigravity-oauth-token"];
const CREDENTIAL_MAX_BYTES = 1024 * 1024;

// Beside the instance profile, not inside it: a helper process sees that whole profile.
const antigravityThreadProfilesDirectory = (instanceProfile: string) =>
  `${instanceProfile}.threads`;

/** One thread's GEMINI_HOME: its conversations and `brain` are the only ones its agent can see. */
export function antigravityThreadProfileDirectory(
  instanceProfile: string,
  threadId: string,
): string {
  const key = NodeCrypto.createHash("sha256").update(threadId).digest("hex").slice(0, 32);
  return NodePath.join(antigravityThreadProfilesDirectory(instanceProfile), key);
}

const conversationsOf = (profile: string) =>
  antigravityManagedPath(profile, ["antigravity-acp", "conversations"], "directory");

/**
 * The thread's profile, when it holds this session's native files. No other profile is tried: the
 * instance's own holds the helper sessions, which belong to no thread.
 */
export async function antigravitySessionProfileDirectory(input: {
  readonly instanceProfile: string;
  readonly threadId: string;
  readonly sessionId: string;
}): Promise<string | undefined> {
  const threadProfile = antigravityThreadProfileDirectory(input.instanceProfile, input.threadId);
  // The agent names the session and writes the folder, so neither may lead out of the profile.
  const database = await antigravityManagedPath(
    threadProfile,
    ["antigravity-acp", "conversations", `${input.sessionId}.db`],
    "file",
  );
  return database === undefined ? undefined : threadProfile;
}

async function antigravityThreadProfiles(instanceProfile: string): Promise<ReadonlyArray<string>> {
  const threads = antigravityThreadProfilesDirectory(instanceProfile);
  const entries = await NodeFSP.readdir(threads).catch(() => []);
  return entries.map((entry) => NodePath.join(threads, entry));
}

/** Every conversation folder under an instance: its own and each thread's, links left out. */
export async function antigravityConversationDirectories(
  instanceProfile: string,
): Promise<ReadonlyArray<string>> {
  const profiles = [instanceProfile, ...(await antigravityThreadProfiles(instanceProfile))];
  const found = await Promise.all(profiles.map(conversationsOf));
  return found.flatMap((entry) => (entry === undefined ? [] : [entry.path]));
}

/**
 * Runs `use` on `<profile>/antigravity-acp`, which the agent writes and T3 keeps files in too.
 * `use` gets a path that names the opened folder itself, so a link the agent left in its place,
 * or swaps in meanwhile, is never followed. Linux only, like the sandbox.
 */
export async function withAntigravityDataDirectory<A>(
  profile: string,
  use: (directory: string) => Promise<A>,
): Promise<A> {
  const path = NodePath.join(profile, "antigravity-acp");
  await NodeFSP.mkdir(path, { recursive: true, mode: 0o700 });
  return withAntigravityFolder(path, use, 0o700);
}

/** Runs `use` on a folder opened without following a link at its name. Linux only. */
export async function withAntigravityFolder<A>(
  path: string,
  use: (directory: string) => Promise<A>,
  mode?: number,
): Promise<A> {
  const { O_DIRECTORY, O_NOFOLLOW, O_RDONLY } = NodeFS.constants;
  const handle = await NodeFSP.open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  try {
    if (mode !== undefined) await handle.chmod(mode);
    return await use(`/proc/self/fd/${handle.fd}`);
  } finally {
    await handle.close();
  }
}

/** Replaces one file by name, or removes it for `undefined`; a folder or link there is an error. */
export async function replaceAntigravityDataFile(
  directory: string,
  name: string,
  content: string | Uint8Array | undefined,
): Promise<void> {
  const { O_CREAT, O_EXCL, O_NOFOLLOW, O_WRONLY } = NodeFS.constants;
  const path = NodePath.join(directory, name);
  // unlink removes a link, never what it points at, and refuses a folder.
  await NodeFSP.unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (content === undefined) return;
  const handle = await NodeFSP.open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
}

/** A regular file's bytes, read without following a link at its name; `undefined` otherwise. */
export async function readAntigravityDataFile(
  directory: string,
  name: string,
): Promise<Uint8Array | undefined> {
  const { O_NOFOLLOW, O_NONBLOCK, O_RDONLY } = NodeFS.constants;
  const handle = await NodeFSP.open(
    NodePath.join(directory, name),
    O_RDONLY | O_NOFOLLOW | O_NONBLOCK,
  ).catch(() => undefined);
  if (handle === undefined) return undefined;
  try {
    const info = await handle.stat();
    return info.isFile() && info.size <= CREDENTIAL_MAX_BYTES ? await handle.readFile() : undefined;
  } finally {
    await handle.close();
  }
}

/**
 * Gives a thread's profile its own copy of the instance's sign-in files, the one thing threads
 * share, remade each launch. A copy, not a link or a read-only mount: however the agent renews a
 * token, it rewrites only its own file, never the one every other thread starts from.
 */
export async function copyAntigravityThreadCredentials(input: {
  readonly instanceProfile: string;
  readonly threadProfile: string;
}): Promise<void> {
  await withAntigravityDataDirectory(input.instanceProfile, (source) =>
    withAntigravityDataDirectory(input.threadProfile, async (target) => {
      for (const name of SHARED_CREDENTIAL_FILES) {
        await replaceAntigravityDataFile(target, name, await readAntigravityDataFile(source, name));
      }
    }),
  );
}

/**
 * After a sign-out no thread profile keeps the old account's copy. Every profile is tried, and a
 * copy that could not be removed fails the sign-out instead of staying behind unseen.
 */
export async function removeAntigravityThreadCredentials(instanceProfile: string): Promise<void> {
  const failures: Array<unknown> = [];
  for (const profile of await antigravityThreadProfiles(instanceProfile)) {
    await withAntigravityDataDirectory(profile, async (directory) => {
      for (const name of SHARED_CREDENTIAL_FILES) {
        await replaceAntigravityDataFile(directory, name, undefined);
      }
    }).catch((cause: unknown) => failures.push(cause));
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Antigravity sign-in copies could not be removed.");
  }
}

/** The same launch, run by `bwrap` inside the namespace `spec` describes, or a failure. */
export async function sandboxAntigravitySpawn(input: {
  readonly bubblewrapPath: string;
  readonly spawn: AcpSessionRuntime.AcpSpawnInput;
  readonly spec: AntigravitySandboxSpec;
}): Promise<AcpSessionRuntime.AcpSpawnInput> {
  const { spawn, spec } = input;
  // The file, not its folder: a folder could hold more than the executable.
  const executable = await NodeFSP.realpath(spawn.command);
  const executableDirectories = EXECUTABLE_DIRECTORIES.filter((directory) =>
    isWithin(executable, directory),
  );
  const view = await antigravityWorkspaceView({
    area: spec.area,
    cwd: spawn.cwd ?? "",
    extraRoots: spec.extraRoots,
    reserved: executableDirectories,
  });
  const cwd = view.roots[0]!;
  // mkdir never follows a link at the name it creates.
  await NodeFSP.mkdir(spec.home, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  // The agent writes the folder that holds its HOME, so what is there may not be what T3 made.
  const home = await NodeFSP.lstat(spec.home);
  const inHome = view.roots.find((root) => isWithin(root, spec.home));
  if (!home.isDirectory() || home.uid !== process.getuid?.() || inHome !== undefined) {
    throw new AntigravityWorkspaceRefused({
      detail:
        inHome === undefined
          ? `Antigravity cannot start: ${spec.home} is not the private home folder T3 Code made for it. Remove it and try again.`
          : `Antigravity cannot work in ${inHome}: its sandbox keeps ${spec.home} for itself. Use a project folder elsewhere.`,
    });
  }
  // Often a link into /run, which is not mounted.
  const resolver = await canonical("/etc/resolv.conf");
  const grants = await Promise.all(
    [
      { path: executable, writable: false },
      ...(resolver === undefined ? [] : [{ path: resolver, writable: false }]),
      ...spec.grants,
      // bwrap refuses a path that is missing, which stops the launch.
    ].map(async (grant) => ({ ...grant, path: (await canonical(grant.path)) ?? grant.path })),
  );
  // bwrap runs outside the sandbox and gets no variables at all. The agent's are read inside,
  // from a file and not from bwrap's arguments, which every user of the machine can list.
  const temp = (await canonical(spec.temp)) ?? spec.temp;
  const environmentFile = `environment-${NodeCrypto.randomUUID()}`;
  await replaceAntigravityDataFile(
    temp,
    environmentFile,
    Object.entries({ ...spawn.env, HOME: spec.home })
      .filter(([name, value]) => value !== undefined && /^[A-Za-z_]\w*$/.test(name))
      .map(([name, value]) => `export ${name}='${value!.replaceAll("'", `'"'"'`)}'\n`)
      .join(""),
  );
  return {
    ...spawn,
    command: input.bubblewrapPath,
    args: [
      ...antigravitySandboxArgs({ ...view, grants }, cwd, executableDirectories),
      "/bin/sh",
      "-c",
      '. "$0" && rm -f "$0" && exec "$@"',
      NodePath.join(temp, environmentFile),
      executable,
      ...spawn.args,
    ],
    env: {},
    extendEnv: false,
  };
}
