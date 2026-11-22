// @effect-diagnostics nodeBuiltinImport:off -- realpath names what the kernel mounts; a link would name something else.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

/**
 * What one `agy` process may see. The agent's own tools read the disk without asking T3, so the
 * limit is a mount namespace: the kernel hides the rest whatever the agent decides to do.
 */
export interface AntigravitySandboxSpec {
  /** Replaced by empty directories: T3's state, and the sockets a process could use to leave. */
  readonly masks: ReadonlyArray<string>;
  /** Workspace folders, shown again where a mask covers them. */
  readonly roots: ReadonlyArray<string>;
  /** T3-owned files and folders this process needs, shown on top of the masks. */
  readonly grants: ReadonlyArray<{ readonly path: string; readonly writable: boolean }>;
  /** Emptied last, inside a grant. */
  readonly hidden: ReadonlyArray<string>;
}

const BWRAP_CANDIDATES = ["/usr/bin/bwrap", "/usr/local/bin/bwrap", "/bin/bwrap"];

export const ANTIGRAVITY_SANDBOX_UNAVAILABLE =
  "Antigravity runs inside a bubblewrap sandbox, and bubblewrap (bwrap) is missing or not allowed to create user namespaces on this machine. Install bubblewrap, or turn off Sandbox in the Antigravity provider settings to run it without isolation.";

function isWithin(path: string, parent: string): boolean {
  const relative = NodePath.relative(parent, path);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`) &&
      !NodePath.isAbsolute(relative))
  );
}

const shallowFirst = (left: string, right: string) => left.length - right.length;

/** Arguments for `bwrap`, up to and including `--`. Every path must already be canonical. */
export function antigravitySandboxArgs(
  spec: AntigravitySandboxSpec,
  cwd: string,
): ReadonlyArray<string> {
  const masks = [...new Set(spec.masks)].toSorted(shallowFirst);
  const outerMasks = masks.filter(
    (mask) => !masks.some((other) => other !== mask && isWithin(mask, other)),
  );
  const roots = [...new Set(spec.roots)]
    .filter((root) => masks.some((mask) => isWithin(root, mask)))
    .toSorted(shallowFirst);
  // Showing a workspace folder again also shows any mask inside it, so those are emptied again.
  const coveredAgain = masks.filter((mask) => roots.some((root) => isWithin(mask, root)));
  // A grant outside every mask is already visible. One that holds a mask would show it again.
  const grants = spec.grants
    .filter(
      (grant) =>
        masks.some((mask) => isWithin(grant.path, mask)) &&
        !masks.some((mask) => isWithin(mask, grant.path)),
    )
    .toSorted((left, right) => shallowFirst(left.path, right.path));
  return [
    "--die-with-parent",
    // A fresh /proc lists only the sandbox, so `/proc/<pid>/root` of an outside process is absent.
    "--unshare-pid",
    "--bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    ...outerMasks.flatMap((mask) => ["--tmpfs", mask]),
    ...roots.flatMap((root) => ["--bind", root, root]),
    ...coveredAgain.flatMap((mask) => ["--tmpfs", mask]),
    ...grants.flatMap((grant) => [grant.writable ? "--bind" : "--ro-bind", grant.path, grant.path]),
    ...spec.hidden.flatMap((path) => ["--tmpfs", path]),
    "--chdir",
    cwd,
    "--",
  ];
}

/** T3's own state, and the places whose sockets (tmux, the session bus, ssh-agent) lead outside. */
export function antigravitySandboxMasks(input: {
  readonly baseDir: string;
  readonly stateDir: string;
  readonly homeDirectory: string;
  readonly uid: number | undefined;
  readonly runtimeDirectory: string | undefined;
}): ReadonlyArray<string> {
  return [
    input.baseDir,
    input.stateDir,
    // A dev server keeps its state elsewhere; the installed app's stays hidden from it too.
    NodePath.join(input.homeDirectory, ".t3"),
    "/tmp",
    "/var/tmp",
    ...(input.uid === undefined ? [] : [`/run/user/${input.uid}`]),
    ...(input.runtimeDirectory ? [input.runtimeDirectory] : []),
  ];
}

/** What one process may see: a thread's session, or a setup or helper process without `thread`. */
export function antigravityProcessSandboxSpec(input: {
  readonly masks: ReadonlyArray<string>;
  readonly executablePath: string;
  readonly instanceProfile: string;
  /** This process's GEMINI_HOME: the thread's profile, or the instance's. */
  readonly profile: string;
  readonly runtimeTempDirectory: string;
  readonly thread:
    | {
        readonly extraRoots: ReadonlyArray<string>;
        readonly attachmentsFolder: string | null;
        readonly sharedCredentials: ReadonlyArray<string>;
      }
    | undefined;
}): AntigravitySandboxSpec {
  const { thread } = input;
  return {
    masks: input.masks,
    roots: thread?.extraRoots ?? [],
    grants: [
      // The file, not its folder: a folder could hold more than the executable.
      { path: input.executablePath, writable: false },
      { path: input.profile, writable: true },
      { path: input.runtimeTempDirectory, writable: true },
      ...(thread?.attachmentsFolder ? [{ path: thread.attachmentsFolder, writable: false }] : []),
      ...(thread?.sharedCredentials ?? []).map((path) => ({ path, writable: true })),
    ],
    // Setup and helper processes use the instance profile, never a thread's.
    hidden: thread === undefined ? [antigravityThreadProfilesDirectory(input.instanceProfile)] : [],
  };
}

const canonical = (path: string) => NodeFSP.realpath(path).catch(() => undefined);

async function canonicalAll(paths: ReadonlyArray<string>): Promise<Array<string>> {
  return (await Promise.all(paths.map(canonical))).filter((path) => path !== undefined);
}

/** Drops what does not exist: bwrap would create a missing mount point on the real disk. */
async function canonicalAntigravitySandboxSpec(
  spec: AntigravitySandboxSpec,
): Promise<AntigravitySandboxSpec> {
  const grants = await Promise.all(
    spec.grants.map(async (grant) => ({ ...grant, path: await canonical(grant.path) })),
  );
  return {
    masks: await canonicalAll(spec.masks),
    roots: await canonicalAll(spec.roots),
    grants: grants.flatMap((grant) =>
      grant.path === undefined ? [] : [{ path: grant.path, writable: grant.writable }],
    ),
    hidden: await canonicalAll(spec.hidden),
  };
}

/** The first bubblewrap that can build the sandbox here; AppArmor may forbid its user namespace. */
export const findUsableBubblewrap = Effect.fn("antigravitySandbox.findUsableBubblewrap")(function* (
  candidates: ReadonlyArray<string> = BWRAP_CANDIDATES,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  for (const candidate of candidates) {
    const info = yield* Effect.promise(() => NodeFSP.stat(candidate).catch(() => undefined));
    if (info?.isFile() !== true) continue;
    const usable = yield* spawner
      .spawn(
        ChildProcess.make(
          candidate,
          [
            ...antigravitySandboxArgs({ masks: [], roots: [], grants: [], hidden: [] }, "/"),
            "/bin/sh",
            "-c",
            ":",
          ],
          { shell: false },
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
});

const THREAD_PROFILES_DIRECTORY = "threads";
// Where `agy` keeps a Google sign-in: 1.4 and 1.5 use different files.
const SHARED_CREDENTIAL_FILES = ["acp_token.json", "antigravity-oauth-token"];

const antigravityThreadProfilesDirectory = (instanceProfile: string) =>
  NodePath.join(instanceProfile, THREAD_PROFILES_DIRECTORY);

/** One thread's GEMINI_HOME: its conversations and `brain` are the only ones its agent can see. */
export function antigravityThreadProfileDirectory(
  instanceProfile: string,
  threadId: string,
): string {
  const key = NodeCrypto.createHash("sha256").update(threadId).digest("hex").slice(0, 32);
  return NodePath.join(antigravityThreadProfilesDirectory(instanceProfile), key);
}

/** The profile holding a session's native files: the thread's own when it ran there. */
export async function antigravitySessionProfileDirectory(input: {
  readonly instanceProfile: string;
  readonly threadId: string;
  readonly sessionId: string;
}): Promise<string> {
  const threadProfile = antigravityThreadProfileDirectory(input.instanceProfile, input.threadId);
  const database = NodePath.join(
    threadProfile,
    "antigravity-acp",
    "conversations",
    `${input.sessionId}.db`,
  );
  return (await NodeFSP.lstat(database).catch(() => undefined))?.isFile()
    ? threadProfile
    : input.instanceProfile;
}

/** Every app-data folder under an instance profile: its own and each thread's. */
export async function antigravityProfileDataDirectories(
  instanceProfile: string,
): Promise<ReadonlyArray<string>> {
  const threads = antigravityThreadProfilesDirectory(instanceProfile);
  const entries = await NodeFSP.readdir(threads).catch(() => []);
  return [instanceProfile, ...entries.map((entry) => NodePath.join(threads, entry))].map(
    (profile) => NodePath.join(profile, "antigravity-acp"),
  );
}

/**
 * Points the thread profile's sign-in files at the instance's, the one thing threads share.
 * Returns the ones that exist. Links are remade each launch, so a copy the agent left in their
 * place does not outlive a sign-out.
 */
export async function linkAntigravityThreadCredentials(input: {
  readonly instanceProfile: string;
  readonly threadProfile: string;
}): Promise<ReadonlyArray<string>> {
  const shared: Array<string> = [];
  const directory = NodePath.join(input.threadProfile, "antigravity-acp");
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  for (const name of SHARED_CREDENTIAL_FILES) {
    const target = NodePath.join(input.instanceProfile, "antigravity-acp", name);
    const link = NodePath.join(directory, name);
    await NodeFSP.rm(link, { recursive: true, force: true });
    await NodeFSP.symlink(target, link, "file");
    if ((await NodeFSP.lstat(target).catch(() => undefined))?.isFile()) shared.push(target);
  }
  return shared;
}

/** The same launch, run by `bwrap` inside the namespace `spec` describes. */
export async function sandboxAntigravitySpawn(input: {
  readonly bubblewrapPath: string;
  readonly spawn: AcpSessionRuntime.AcpSpawnInput;
  readonly spec: AntigravitySandboxSpec;
}): Promise<AcpSessionRuntime.AcpSpawnInput> {
  const cwd = (await canonical(input.spawn.cwd ?? process.cwd())) ?? "/";
  const spec = await canonicalAntigravitySandboxSpec({
    ...input.spec,
    roots: [...input.spec.roots, cwd],
  });
  return {
    ...input.spawn,
    command: input.bubblewrapPath,
    args: [...antigravitySandboxArgs(spec, cwd), input.spawn.command, ...input.spawn.args],
  };
}
