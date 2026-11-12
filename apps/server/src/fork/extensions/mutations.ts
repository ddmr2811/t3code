import {
  ForkExtensionsError,
  type ForkExtensionAgent,
  type ForkInstallRequest,
  type ForkInstallResult,
  type ForkProblemReason,
  type ForkSetEnabledInput,
  type ForkUninstallInput,
} from "@t3tools/contracts";
import { isCommandMissingCause } from "@t3tools/provider-core/server/snapshotProbe";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { runCli, type ResolvedAgent } from "./agents.ts";
import { readClaudeJson, setClaudeProjectDisabled, type ClaudeJsonView } from "./claudeJson.ts";
import { decodeCodexMcpList } from "./cliJson.ts";
import { isValidToml, setCodexMcpEnabled } from "./codexToml.ts";
import {
  disableSkill,
  discardClaudeMcp,
  enableSkill,
  listDisabledSkills,
  listStashedClaudeMcp,
  peekClaudeMcp,
  removeSkill,
  stashClaudeMcp,
} from "./disabledStore.ts";
import { readWithFingerprint, writeIfUnchanged } from "./safeFileEdit.ts";
import { comparablePath } from "./snapshotModel.ts";

/**
 * Install, uninstall and switch on/off. Every operation answers per agent and never fails as
 * a whole; everything that changes an agent's config runs inside `withWriteLock`.
 */

export interface MutationContext {
  /** The agents this machine has (resolveAgents). */
  readonly agents: ReadonlyArray<ResolvedAgent>;
  /** T3 projects, whose `.mcp.json` holds Claude's project-scope servers. */
  readonly projects: ReadonlyArray<{ readonly path: string; readonly title: string }>;
  readonly withWriteLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

const AGENT_NAMES: Record<ForkExtensionAgent, string> = { claude: "Claude Code", codex: "Codex" };

const CLAUDE_AI_PREFIX = "claude.ai ";
const PLUGIN_MCP_PREFIX = "plugin:";

/** Plugin installs and marketplace adds clone repos; a skill clone does the same. */
const DOWNLOAD_TIMEOUT_MS = 120_000;
const LIST_TIMEOUT_MS = 30_000;

const isForkExtensionsError = Schema.is(ForkExtensionsError);

const problem = (
  reason: ForkProblemReason,
  summary: string,
  nextStep: string,
  rawOutput: string | null = null,
) => new ForkExtensionsError({ problem: { reason, summary, nextStep, rawOutput } });

const DUPLICATE_NEXT_STEP = "Pick another name or uninstall the existing one first.";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isJsonObject = (text: string): boolean => {
  try {
    return isRecord(JSON.parse(text));
  } catch {
    return false;
  }
};

const lastSegment = (value: string): string =>
  value.split(/[\\/]/).findLast((part) => part !== "") ?? value;

const fileProblem = (file: string, cause: PlatformError.PlatformError) =>
  problem(
    cause.reason._tag === "PermissionDenied" ? "permissionDenied" : "commandFailed",
    `Could not access ${file}.`,
    "Check the folder's permissions and that no other program is using it, then retry.",
    cause.message,
  );

/** A value passed as a positional CLI argument must not read as a flag. */
const assertArgument = (value: string, label: string) =>
  value.trim() === "" || value.startsWith("-")
    ? Effect.fail(
        problem(
          "invalidInput",
          `"${value}" is not a valid ${label}.`,
          `Enter a ${label} that doesn't start with "-".`,
        ),
      )
    : Effect.void;

const agentOf = (
  context: MutationContext,
  agent: ForkExtensionAgent,
): Effect.Effect<ResolvedAgent, ForkExtensionsError> => {
  const resolved = context.agents.find((candidate) => candidate.agent === agent);
  return resolved === undefined
    ? Effect.fail(
        problem(
          "unsupported",
          `${AGENT_NAMES[agent]} isn't set up on this machine.`,
          `Enable ${AGENT_NAMES[agent]} in Settings → Providers, then retry.`,
        ),
      )
    : Effect.succeed(resolved);
};

/** One agent's outcome; typed failures and defects both become a problem, never a failure. */
const toResult = <R>(
  agent: ForkExtensionAgent,
  effect: Effect.Effect<unknown, ForkExtensionsError, R>,
): Effect.Effect<ForkInstallResult, never, R> =>
  effect.pipe(
    Effect.as<ForkInstallResult>({ agent, ok: true, problem: null }),
    Effect.catch((error) =>
      Effect.succeed<ForkInstallResult>({ agent, ok: false, problem: error.problem }),
    ),
    Effect.catchDefect((defect) =>
      Effect.logError("Extensions operation died", { agent, defect }).pipe(
        Effect.as<ForkInstallResult>({
          agent,
          ok: false,
          problem: {
            reason: "commandFailed",
            summary: "Something unexpected went wrong.",
            nextStep: "Retry; if it keeps happening, check the T3 server log on this machine.",
            rawOutput: String(defect),
          },
        }),
      ),
    ),
  );

/** The agents a request answers for (plugins are Claude-only). */
export const requestAgents = (request: ForkInstallRequest): ReadonlyArray<ForkExtensionAgent> =>
  request._tag === "plugin" ? ["claude"] : request.agents;

/** A CLI that refuses a duplicate name says "already exists" (plugins: "already installed"). */
const duplicateAs =
  (summary: string, nextStep: string) =>
  <A, R>(effect: Effect.Effect<A, ForkExtensionsError, R>) =>
    effect.pipe(
      Effect.mapError((error) =>
        error.problem.reason === "commandFailed" &&
        /already (exists|installed)/i.test(error.problem.rawOutput ?? "")
          ? problem("alreadyExists", summary, nextStep, error.problem.rawOutput)
          : error,
      ),
    );

const parseItemId = (
  itemId: string,
): Effect.Effect<
  { readonly kind: "mcp" | "plugin" | "skill"; readonly name: string },
  ForkExtensionsError
> => {
  const separator = itemId.indexOf(":");
  const kind = itemId.slice(0, separator);
  const name = itemId.slice(separator + 1);
  if (separator <= 0 || name === "" || (kind !== "mcp" && kind !== "plugin" && kind !== "skill")) {
    return Effect.fail(
      problem(
        "invalidInput",
        `"${itemId}" is not an Extensions item.`,
        "Refresh the page and retry.",
      ),
    );
  }
  return Effect.succeed({ kind, name });
};

const readClaudeConfig = Effect.fn("ForkExtensions.readClaudeConfig")(function* (
  agent: ResolvedAgent,
) {
  const snapshot = yield* readWithFingerprint(agent.configFile);
  return { ...snapshot, view: readClaudeJson(snapshot.text) };
});

/** The exact `~/.claude.json` project key for a T3 project path; never an invented one. */
const projectKeyOf = (view: ClaudeJsonView, projectPath: string): string | undefined => {
  const wanted = comparablePath(projectPath);
  return view.projects.find((project) => comparablePath(project.path) === wanted)?.path;
};

const neverOpened = (projectPath: string) =>
  problem(
    "notFound",
    `Claude Code has no settings for ${lastSegment(projectPath)} yet.`,
    "Open Claude Code once in that project, then retry.",
  );

/** Sets `disabledMcpServers` for `name` in these project keys with one checked write. */
const writeProjectSwitches = Effect.fn("ForkExtensions.writeProjectSwitches")(function* (
  agent: ResolvedAgent,
  read: { readonly text: string; readonly fingerprint: string },
  keys: ReadonlyArray<string>,
  name: string,
  disabled: boolean,
) {
  const next = yield* Effect.try({
    try: () =>
      keys.reduce((text, key) => setClaudeProjectDisabled(text, key, name, disabled), read.text),
    catch: (cause) =>
      isForkExtensionsError(cause)
        ? cause
        : problem(
            "invalidInput",
            "~/.claude.json could not be edited, so it was left untouched.",
            "Fix or restore ~/.claude.json, then try again.",
            String(cause),
          ),
  });
  if (next === read.text) return;
  yield* writeIfUnchanged(agent.configFile, read.fingerprint, next, isJsonObject);
});

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const McpJson = Schema.fromJsonString(
  Schema.Struct({ mcpServers: Schema.Record(Schema.String, Schema.Unknown) }),
);
const decodeMcpJson = Schema.decodeUnknownOption(McpJson);

/** T3 projects whose `.mcp.json` (Claude project scope) defines `name`. */
const projectsDefining = Effect.fn("ForkExtensions.projectsDefining")(function* (
  context: MutationContext,
  name: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const found = yield* Effect.forEach(
    context.projects,
    (project) =>
      fs.readFileString(path.join(project.path, ".mcp.json")).pipe(
        Effect.map((text) =>
          decodeMcpJson(text).pipe(
            Option.filter((parsed) => Object.hasOwn(parsed.mcpServers, name)),
            Option.as(project),
          ),
        ),
        Effect.orElseSucceed(() => Option.none<(typeof context.projects)[number]>()),
      ),
    { concurrency: 8 },
  );
  return found.flatMap(Option.toArray);
});

type McpRequest = Extract<ForkInstallRequest, { readonly _tag: "mcp" }>;
type PluginRequest = Extract<ForkInstallRequest, { readonly _tag: "plugin" }>;
type SkillRequest = Extract<ForkInstallRequest, { readonly _tag: "skill" }>;

const validateMcp = Effect.fn("ForkExtensions.validateMcp")(function* (request: McpRequest) {
  yield* assertArgument(request.name, "server name");
  if (request.transport === "stdio") {
    if (request.command === null || request.command.trim() === "") {
      return yield* problem(
        "invalidInput",
        "A command server needs a command.",
        "Enter the command that starts the server.",
      );
    }
  } else if (request.url === null || !/^https?:\/\//i.test(request.url)) {
    return yield* problem(
      "invalidInput",
      "A remote server needs an http(s) URL.",
      "Enter the server's URL.",
    );
  }
  if (
    request.scope !== "user" &&
    (request.projectPath === null || request.projectPath.trim() === "")
  ) {
    return yield* problem(
      "invalidInput",
      `The ${request.scope} scope needs a project.`,
      "Pick the T3 project to add it to.",
    );
  }
});

const installClaudeMcp = Effect.fn("ForkExtensions.installClaudeMcp")(function* (
  agent: ResolvedAgent,
  request: McpRequest,
) {
  if (request.scope === "user") {
    const stashed = yield* listStashedClaudeMcp();
    if (Object.hasOwn(stashed, request.name)) {
      return yield* problem(
        "alreadyExists",
        `Claude Code has a switched-off server named "${request.name}".`,
        "Pick another name, or switch the existing one back on.",
      );
    }
  }
  const target =
    request.transport === "stdio"
      ? [request.name, "--", request.command ?? "", ...request.args]
      : ["--transport", request.transport, request.name, request.url ?? ""];
  yield* runCli(
    agent,
    ["mcp", "add", "-s", request.scope, ...target],
    request.scope === "user" || request.projectPath === null ? {} : { cwd: request.projectPath },
  ).pipe(
    duplicateAs(`Claude Code already has a server named "${request.name}".`, DUPLICATE_NEXT_STEP),
  );
});

const installCodexMcp = Effect.fn("ForkExtensions.installCodexMcp")(function* (
  agent: ResolvedAgent,
  request: McpRequest,
) {
  if (request.scope !== "user") {
    return yield* problem(
      "unsupported",
      "Codex has no per-project MCP servers.",
      "Install it for Codex with the User scope.",
    );
  }
  if (request.transport === "sse") {
    return yield* problem(
      "unsupported",
      "Codex can't connect to SSE servers.",
      "Use the server's streamable HTTP URL for Codex, if it has one.",
    );
  }
  // `codex mcp add` silently replaces a server with the same name, so check first.
  const listed = yield* runCli(agent, ["mcp", "list", "--json"], {
    timeoutMs: LIST_TIMEOUT_MS,
  }).pipe(Effect.flatMap(({ stdout }) => decodeCodexMcpList(stdout)));
  if (listed.some((server) => server.name === request.name)) {
    return yield* problem(
      "alreadyExists",
      `Codex already has a server named "${request.name}".`,
      DUPLICATE_NEXT_STEP,
    );
  }
  const target =
    request.transport === "stdio"
      ? [request.name, "--", request.command ?? "", ...request.args]
      : [request.name, "--url", request.url ?? ""];
  yield* runCli(agent, ["mcp", "add", ...target]).pipe(
    duplicateAs(`Codex already has a server named "${request.name}".`, DUPLICATE_NEXT_STEP),
  );
});

const installPlugin = Effect.fn("ForkExtensions.installPlugin")(function* (
  agent: ResolvedAgent,
  request: PluginRequest,
) {
  const ref = request.pluginRef.trim();
  yield* assertArgument(ref, "plugin");
  // `claude plugin install` takes `name@marketplace` (or a bare name); a repo path is not a
  // plugin it can find (checked with `claude plugin install --help`, Claude Code 2.1.322).
  if (!ref.includes("@") && ref.includes("/")) {
    return yield* problem(
      "unsupported",
      `${ref} is a plugin repo; Claude Code installs plugins only from a marketplace.`,
      "Add its marketplace instead (paste the marketplace repo).",
    );
  }
  if (request.marketplaceSource !== null) {
    const source = request.marketplaceSource.trim();
    yield* assertArgument(source, "marketplace");
    yield* runCli(agent, ["plugin", "marketplace", "add", source], {
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
    }).pipe(
      Effect.catchIf(
        (error) =>
          error.problem.reason === "commandFailed" &&
          /already (been )?(added|exists|installed)/i.test(error.problem.rawOutput ?? ""),
        () => Effect.void,
      ),
    );
  }
  yield* runCli(agent, ["plugin", "install", ref], { timeoutMs: DOWNLOAD_TIMEOUT_MS }).pipe(
    duplicateAs(`${ref} is already installed.`, "Uninstall it first if you want to reinstall it."),
  );
});

type SkillSource =
  | { readonly _tag: "local"; readonly path: string }
  | {
      readonly _tag: "github";
      readonly owner: string;
      readonly repo: string;
      readonly ref: string | null;
      readonly subpath: string | null;
    };

const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/;
const REPO_PART = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

const assertSkillName = (name: string) =>
  SKILL_NAME.test(name) && !/[. ]$/.test(name)
    ? Effect.void
    : Effect.fail(
        problem(
          "invalidInput",
          `"${name}" is not a valid skill name.`,
          "Use a single folder name: letters, numbers, dots, dashes or underscores.",
        ),
      );

const unknownSkillSource = (source: string) =>
  problem(
    "invalidInput",
    `"${source}" is not a GitHub repo or a local folder.`,
    "Paste a GitHub link (owner/repo/path) or the full path to a folder with SKILL.md.",
  );

const github = (
  owner: string,
  repo: string,
  ref: string | null,
  rest: ReadonlyArray<string>,
  source: string,
) => {
  const parts = rest.filter((part) => part !== "");
  if (parts.at(-1)?.toLowerCase() === "skill.md") parts.pop();
  if (
    !REPO_PART.test(owner) ||
    !REPO_PART.test(repo) ||
    (ref !== null && (ref.startsWith("-") || ref.trim() === "")) ||
    parts.some((part) => part === "." || part === "..")
  ) {
    return Effect.fail(unknownSkillSource(source));
  }
  return Effect.succeed<SkillSource>({
    _tag: "github",
    owner,
    repo: repo.replace(/\.git$/, ""),
    ref,
    subpath: parts.length > 0 ? parts.join("/") : null,
  });
};

const parseUrl = (text: string): URL | null => {
  try {
    return new URL(text);
  } catch {
    return null;
  }
};

const parseSkillSource = Effect.fn("ForkExtensions.parseSkillSource")(function* (source: string) {
  const path = yield* Path.Path;
  const input = source.trim();
  if (/^https?:\/\//i.test(input)) {
    const url = parseUrl(input);
    if (url === null) return yield* unknownSkillSource(source);
    if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
      return yield* unknownSkillSource(source);
    }
    const [owner = "", repo = "", kind, ref, ...rest] = url.pathname.split("/").filter(Boolean);
    return (kind === "tree" || kind === "blob") && ref !== undefined
      ? yield* github(owner, repo, ref, rest, source)
      : yield* github(owner, repo, null, [], source);
  }
  if (input === "~" || /^~[\\/]/.test(input)) {
    const home = yield* HostProcess.HomeDirectory;
    return { _tag: "local", path: path.join(home, input.slice(1)) } satisfies SkillSource;
  }
  if (path.isAbsolute(input) || /^[a-zA-Z]:[\\/]/.test(input)) {
    return { _tag: "local", path: input } satisfies SkillSource;
  }
  const match = /^([^/\\\s]+)\/([^/\\\s]+)((?:\/[^/\\]+)*)\/?$/.exec(input);
  if (match === null) return yield* unknownSkillSource(source);
  return yield* github(match[1]!, match[2]!, null, (match[3] ?? "").split("/"), source);
});

const runGit = Effect.fn("ForkExtensions.runGit")(function* (
  args: ReadonlyArray<string>,
  what: string,
) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const result = yield* runner
    .run({ command: "git", args, timeout: Duration.millis(DOWNLOAD_TIMEOUT_MS) })
    .pipe(
      Effect.mapError((error) => {
        if (error._tag === "ProcessSpawnError" && isCommandMissingCause(error.cause)) {
          return problem(
            "binaryNotFound",
            "Git was not found on this machine.",
            "Install Git, or download the skill folder and paste its local path.",
            String(error.cause),
          );
        }
        if (error._tag === "ProcessTimeoutError") {
          return problem(
            "timeout",
            `Downloading ${what} did not finish within ${DOWNLOAD_TIMEOUT_MS / 1000} s.`,
            "Check your connection and retry.",
          );
        }
        return problem(
          "commandFailed",
          `Could not run git to download ${what}.`,
          "Run `git --version` in a terminal on this machine to check Git, then retry.",
          error.message,
        );
      }),
    );
  if (result.code !== 0) {
    return yield* problem(
      "commandFailed",
      `Couldn't download ${what} from GitHub.`,
      "Check the link and that the repo is public, then retry.",
      [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n").slice(0, 8192),
    );
  }
});

/**
 * The folder holding SKILL.md: the local path, or the subfolder of a shallow clone made in
 * `<baseDir>/fork-extensions/tmp`, which is removed when the scope closes.
 */
const fetchSkillFolder = Effect.fn("ForkExtensions.fetchSkillFolder")(function* (
  source: SkillSource,
  label: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let folder: string;
  if (source._tag === "local") {
    folder = source.path;
  } else {
    const config = yield* ServerConfig.ServerConfig;
    const tmpRoot = path.join(config.baseDir, "fork-extensions", "tmp");
    const workDir = yield* Effect.acquireRelease(
      fs.makeDirectory(tmpRoot, { recursive: true }).pipe(
        Effect.andThen(fs.makeTempDirectory({ directory: tmpRoot, prefix: "skill-" })),
        Effect.mapError((cause) => fileProblem(tmpRoot, cause)),
      ),
      (dir) =>
        fs.remove(dir, { recursive: true, force: true }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Extensions could not remove a temporary skill clone", {
              dir,
              cause,
            }),
          ),
        ),
    );
    const clone = path.join(workDir, "repo");
    const what = `${source.owner}/${source.repo}`;
    yield* runGit(
      [
        "clone",
        "--depth",
        "1",
        ...(source.ref === null ? [] : ["--branch", source.ref]),
        `https://github.com/${source.owner}/${source.repo}.git`,
        clone,
      ],
      what,
    );
    // The repo's history never ends up in a skills folder.
    yield* fs
      .remove(path.join(clone, ".git"), { recursive: true, force: true })
      .pipe(Effect.mapError((cause) => fileProblem(clone, cause)));
    folder = source.subpath === null ? clone : path.join(clone, ...source.subpath.split("/"));
  }
  const hasSkill = yield* fs
    .exists(path.join(folder, "SKILL.md"))
    .pipe(Effect.orElseSucceed(() => false));
  if (!hasSkill) {
    return yield* problem(
      "invalidInput",
      `There is no SKILL.md in ${label}.`,
      "Paste the link to the folder that holds SKILL.md.",
    );
  }
  return folder;
});

/** Copies the skill folder into `<skillsDir>/<name>` through a temp sibling, then renames it. */
const placeSkill = Effect.fn("ForkExtensions.placeSkill")(function* (
  agent: ResolvedAgent,
  folder: string,
  name: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const destination = path.join(agent.skillsDir, name);
  if (
    yield* fs.exists(destination).pipe(Effect.mapError((cause) => fileProblem(destination, cause)))
  ) {
    return yield* problem(
      "alreadyExists",
      `${AGENT_NAMES[agent.agent]} already has a skill named "${name}".`,
      DUPLICATE_NEXT_STEP,
    );
  }
  if ((yield* listDisabledSkills(agent.agent)).includes(name)) {
    return yield* problem(
      "alreadyExists",
      `${AGENT_NAMES[agent.agent]} has a switched-off skill named "${name}".`,
      "Pick another name, or switch the existing one back on.",
    );
  }
  yield* fs
    .makeDirectory(agent.skillsDir, { recursive: true })
    .pipe(Effect.mapError((cause) => fileProblem(agent.skillsDir, cause)));
  // A dot folder: the snapshot skips it while the copy is in progress.
  const staging = yield* fs
    .makeTempDirectory({ directory: agent.skillsDir, prefix: ".t3-tmp-" })
    .pipe(Effect.mapError((cause) => fileProblem(agent.skillsDir, cause)));
  yield* fs.copy(folder, path.join(staging, name)).pipe(
    Effect.andThen(fs.rename(path.join(staging, name), destination)),
    Effect.mapError((cause) => fileProblem(destination, cause)),
    Effect.ensuring(fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore)),
  );
});

const installSkill = Effect.fn("ForkExtensions.installSkill")(function* (
  context: MutationContext,
  request: SkillRequest,
) {
  const name = request.name.trim();
  const fetched = yield* Effect.gen(function* () {
    yield* assertSkillName(name);
    const source = yield* parseSkillSource(request.source);
    const agents = yield* Effect.forEach(request.agents, (agent) =>
      agentOf(context, agent).pipe(Effect.result),
    );
    // The download only touches T3's temp folder, so it runs outside the write queue.
    const folder = yield* fetchSkillFolder(source, request.source.trim());
    return yield* Effect.forEach(request.agents, (agent, index) => {
      const resolved = agents[index]!;
      return toResult(
        agent,
        resolved._tag === "Failure"
          ? Effect.fail(resolved.failure)
          : context.withWriteLock(placeSkill(resolved.success, folder, name)),
      );
    });
  }).pipe(Effect.scoped, Effect.result);
  if (fetched._tag === "Success") return fetched.success;
  return request.agents.map((agent): ForkInstallResult => ({
    agent,
    ok: false,
    problem: fetched.failure.problem,
  }));
});

export const installExtension = Effect.fn("ForkExtensions.installExtension")(function* (
  context: MutationContext,
  request: ForkInstallRequest,
) {
  switch (request._tag) {
    case "mcp":
      return yield* Effect.forEach(request.agents, (agent) =>
        toResult(
          agent,
          Effect.gen(function* () {
            yield* validateMcp(request);
            const resolved = yield* agentOf(context, agent);
            yield* context.withWriteLock(
              agent === "claude"
                ? installClaudeMcp(resolved, request)
                : installCodexMcp(resolved, request),
            );
          }),
        ),
      );
    case "plugin":
      return [
        yield* toResult(
          "claude",
          agentOf(context, "claude").pipe(
            Effect.flatMap((resolved) => context.withWriteLock(installPlugin(resolved, request))),
          ),
        ),
      ];
    case "skill":
      return yield* installSkill(context, request);
  }
});

const connectorUninstall = () =>
  problem(
    "unsupported",
    "claude.ai connectors belong to your claude.ai account.",
    "Remove it in claude.ai → Settings → Connectors.",
  );

const pluginPartUninstall = (what: string) =>
  problem(
    "unsupported",
    `This ${what} comes from a plugin.`,
    "Uninstall the plugin it comes from.",
  );

const notFoundOn = (agent: ForkExtensionAgent, what: string) =>
  problem(
    "notFound",
    `${AGENT_NAMES[agent]} has no ${what}.`,
    "Refresh the page; it may have been removed from the terminal.",
  );

const uninstallClaudeMcp = Effect.fn("ForkExtensions.uninstallClaudeMcp")(function* (
  context: MutationContext,
  agent: ResolvedAgent,
  name: string,
) {
  if (name.startsWith(CLAUDE_AI_PREFIX)) return yield* connectorUninstall();
  if (name.startsWith(PLUGIN_MCP_PREFIX)) return yield* pluginPartUninstall("server");
  yield* assertArgument(name, "server name");
  const { view } = yield* readClaudeConfig(agent);
  const stashed = yield* listStashedClaudeMcp();
  const inRepos = yield* projectsDefining(context, name);
  let removed = false;
  if (Object.hasOwn(view.userServers, name)) {
    yield* runCli(agent, ["mcp", "remove", "-s", "user", name]);
    removed = true;
  }
  for (const project of view.projects) {
    if (!Object.hasOwn(project.servers, name)) continue;
    yield* runCli(agent, ["mcp", "remove", "-s", "local", name], { cwd: project.path });
    removed = true;
  }
  if (Object.hasOwn(stashed, name)) {
    yield* discardClaudeMcp(name);
    removed = true;
  }
  if (inRepos.length > 0) {
    // A repo's .mcp.json is shared through git; T3 never edits it.
    return yield* problem(
      "unsupported",
      `"${name}" is ${removed ? "also " : ""}defined in the .mcp.json of ${inRepos.map((project) => project.title).join(", ")}.`,
      "Remove it from that repo's .mcp.json by hand, or switch it off per project.",
    );
  }
  if (!removed) return yield* notFoundOn("claude", `MCP server named "${name}"`);
});

const uninstallOne = Effect.fn("ForkExtensions.uninstallOne")(function* (
  context: MutationContext,
  kind: "mcp" | "plugin" | "skill",
  name: string,
  agent: ForkExtensionAgent,
) {
  if (kind === "mcp" && agent === "claude" && name.startsWith(CLAUDE_AI_PREFIX)) {
    return yield* connectorUninstall();
  }
  if (kind === "skill" && name.includes(":")) return yield* pluginPartUninstall("skill");
  if (kind === "plugin" && agent === "codex") {
    return yield* problem("unsupported", "Codex has no plugins.", "Nothing to do for Codex.");
  }
  const resolved = yield* agentOf(context, agent);
  switch (kind) {
    case "mcp":
      if (agent === "claude")
        return yield* context.withWriteLock(uninstallClaudeMcp(context, resolved, name));
      if (name.startsWith(CLAUDE_AI_PREFIX) || name.startsWith(PLUGIN_MCP_PREFIX)) {
        return yield* notFoundOn("codex", `MCP server named "${name}"`);
      }
      yield* assertArgument(name, "server name");
      return yield* context.withWriteLock(runCli(resolved, ["mcp", "remove", name]));
    case "plugin":
      yield* assertArgument(name, "plugin");
      return yield* context.withWriteLock(runCli(resolved, ["plugin", "uninstall", name]));
    case "skill":
      return yield* context.withWriteLock(removeSkill(agent, resolved.skillsDir, name));
  }
});

export const uninstallExtension = Effect.fn("ForkExtensions.uninstallExtension")(function* (
  context: MutationContext,
  input: ForkUninstallInput,
) {
  return yield* Effect.forEach(input.agents, (agent) =>
    toResult(
      agent,
      parseItemId(input.itemId).pipe(
        Effect.flatMap(({ kind, name }) => uninstallOne(context, kind, name, agent)),
      ),
    ),
  );
});

/** Claude MCP for one project: `disabledMcpServers` of its exact `~/.claude.json` key. */
const setClaudeMcpForProject = Effect.fn("ForkExtensions.setClaudeMcpForProject")(function* (
  agent: ResolvedAgent,
  name: string,
  enabled: boolean,
  projectPath: string,
) {
  const read = yield* readClaudeConfig(agent);
  const key = projectKeyOf(read.view, projectPath);
  if (key === undefined) return yield* neverOpened(projectPath);
  yield* writeProjectSwitches(agent, read, [key], name, !enabled);
});

/**
 * Global switch of a Claude MCP server. User scope: off = stash the exact definition and
 * `claude mcp remove`; on = `add-json` it back, dropping the stash only after that worked.
 * Local/project scope: the per-project switch in every project that has it.
 */
const setClaudeMcpGlobally = Effect.fn("ForkExtensions.setClaudeMcpGlobally")(function* (
  context: MutationContext,
  agent: ResolvedAgent,
  name: string,
  enabled: boolean,
) {
  if (name.startsWith(CLAUDE_AI_PREFIX)) {
    return yield* problem(
      "unsupported",
      "claude.ai connectors are switched on or off for your whole claude.ai account.",
      "Turn it off in claude.ai → Settings → Connectors.",
    );
  }
  if (name.startsWith(PLUGIN_MCP_PREFIX)) {
    return yield* problem(
      "unsupported",
      "This server comes from a plugin.",
      "Disable the plugin it comes from.",
    );
  }
  yield* assertArgument(name, "server name");
  const read = yield* readClaudeConfig(agent);
  const stashed = yield* listStashedClaudeMcp();
  const user = Object.hasOwn(read.view.userServers, name) ? read.view.userServers[name] : undefined;
  const inStash = Object.hasOwn(stashed, name);
  const localKeys = read.view.projects
    .filter((project) => Object.hasOwn(project.servers, name))
    .map((project) => project.path);
  const inRepos = yield* projectsDefining(context, name);

  if (user === undefined && !inStash && localKeys.length === 0 && inRepos.length === 0) {
    return yield* notFoundOn("claude", `MCP server named "${name}"`);
  }

  if (!enabled) {
    const repoKeys: Array<string> = [];
    for (const project of inRepos) {
      const key = projectKeyOf(read.view, project.path);
      if (key === undefined) return yield* neverOpened(project.path);
      repoKeys.push(key);
    }
    const keys = [...new Set([...localKeys, ...repoKeys])];
    if (keys.length > 0) yield* writeProjectSwitches(agent, read, keys, name, true);
    if (user !== undefined) {
      yield* stashClaudeMcp(name, "user", user);
      // If the CLI refuses, the server is still live: drop the copy so nothing is duplicated.
      yield* runCli(agent, ["mcp", "remove", "-s", "user", name]).pipe(
        Effect.tapError(() => discardClaudeMcp(name).pipe(Effect.ignore)),
      );
    }
    return;
  }

  if (inStash) {
    if (user === undefined) {
      const definition = yield* peekClaudeMcp(name).pipe(
        Effect.flatMap(encodeJson),
        Effect.mapError((cause) =>
          isForkExtensionsError(cause)
            ? cause
            : problem(
                "invalidInput",
                `The saved copy of "${name}" can't be turned back into JSON.`,
                "Add the server again by hand.",
                String(cause),
              ),
        ),
      );
      yield* runCli(agent, ["mcp", "add-json", "-s", "user", name, definition]);
    }
    // Live config wins: a server re-added from the terminal makes the copy stale.
    yield* discardClaudeMcp(name);
    return;
  }
  if (user === undefined) {
    const keys = read.view.projects
      .filter((project) => project.disabled.includes(name))
      .map((project) => project.path);
    if (keys.length > 0) yield* writeProjectSwitches(agent, read, keys, name, false);
  }
});

const setCodexMcp = Effect.fn("ForkExtensions.setCodexMcp")(function* (
  agent: ResolvedAgent,
  name: string,
  enabled: boolean,
) {
  const read = yield* readWithFingerprint(agent.configFile);
  const next = yield* Effect.try({
    try: () => setCodexMcpEnabled(read.text, name, enabled),
    catch: (cause) =>
      isForkExtensionsError(cause)
        ? cause
        : problem(
            "invalidInput",
            "config.toml could not be edited, so it was left untouched.",
            "Fix config.toml by hand, then try again.",
            String(cause),
          ),
  });
  if (next === read.text) return;
  yield* writeIfUnchanged(agent.configFile, read.fingerprint, next, isValidToml);
});

const setSkill = Effect.fn("ForkExtensions.setSkill")(function* (
  agent: ResolvedAgent,
  name: string,
  enabled: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const folder = path.join(agent.skillsDir, name);
  const live = yield* fs
    .exists(folder)
    .pipe(Effect.mapError((cause) => fileProblem(folder, cause)));
  const switchedOff = (yield* listDisabledSkills(agent.agent)).includes(name);
  if (enabled) {
    if (live) return;
    if (!switchedOff) return yield* notFoundOn(agent.agent, `skill named "${name}"`);
    return yield* enableSkill(agent.agent, agent.skillsDir, name);
  }
  if (!live) {
    if (switchedOff) return;
    return yield* notFoundOn(agent.agent, `skill named "${name}"`);
  }
  yield* disableSkill(agent.agent, agent.skillsDir, name);
});

const wholeMachineOnly = (what: string) =>
  problem(
    "unsupported",
    `${what} switch on or off for the whole machine, not per project.`,
    "Use its main switch.",
  );

const setEnabledOne = Effect.fn("ForkExtensions.setEnabledOne")(function* (
  context: MutationContext,
  input: ForkSetEnabledInput,
) {
  const { kind, name } = yield* parseItemId(input.itemId);
  const projectPath = input.projectPath?.trim() ? input.projectPath : null;
  if (kind === "plugin") {
    if (input.agent === "codex") {
      return yield* problem("unsupported", "Codex has no plugins.", "Nothing to do for Codex.");
    }
    if (projectPath !== null) return yield* wholeMachineOnly("Plugins");
    yield* assertArgument(name, "plugin");
    const resolved = yield* agentOf(context, "claude");
    return yield* context.withWriteLock(
      runCli(resolved, ["plugin", input.enabled ? "enable" : "disable", name]),
    );
  }
  if (kind === "skill") {
    if (name.includes(":")) {
      return yield* problem(
        "unsupported",
        "This skill comes from a plugin.",
        "Disable the plugin it comes from.",
      );
    }
    if (projectPath !== null) return yield* wholeMachineOnly("Skills");
    const resolved = yield* agentOf(context, input.agent);
    return yield* context.withWriteLock(setSkill(resolved, name, input.enabled));
  }
  const resolved = yield* agentOf(context, input.agent);
  if (input.agent === "codex") {
    if (projectPath !== null) return yield* wholeMachineOnly("Codex MCP servers");
    return yield* context.withWriteLock(setCodexMcp(resolved, name, input.enabled));
  }
  return yield* context.withWriteLock(
    projectPath === null
      ? setClaudeMcpGlobally(context, resolved, name, input.enabled)
      : setClaudeMcpForProject(resolved, name, input.enabled, projectPath),
  );
});

export const setExtensionEnabled = Effect.fn("ForkExtensions.setExtensionEnabled")(function* (
  context: MutationContext,
  input: ForkSetEnabledInput,
) {
  return yield* toResult(input.agent, setEnabledOne(context, input));
});

/**
 * A stashed (switched-off) Claude server that is live again was re-added from the terminal:
 * live config wins and the copy is dropped. Re-checked here, inside the write queue.
 */
export const discardRevivedStash = Effect.fn("ForkExtensions.discardRevivedStash")(function* (
  agent: ResolvedAgent,
  names: ReadonlyArray<string>,
) {
  const { view } = yield* readClaudeConfig(agent);
  for (const name of names) {
    if (Object.hasOwn(view.userServers, name)) yield* discardClaudeMcp(name);
  }
});
