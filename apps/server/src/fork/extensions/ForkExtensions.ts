import {
  FORK_EXTENSIONS_PROTOCOL_VERSION,
  ForkCellState,
  ForkExtensionProblem,
  ForkExtensionsError,
  type ForkAuthorizeCompleteInput,
  type ForkAuthorizeEvent,
  type ForkExtensionAgent,
  type ForkExtensionItem,
  type ForkHealthEvent,
  type ForkExtensionsSnapshot,
  type ForkInstallRequest,
  type ForkInstallResult,
  type ForkSetEnabledInput,
  type ForkUninstallInput,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { discoverClaudeSkills } from "../../provider/Drivers/ClaudeSkills.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { resolveAgents, runCli, type ResolvedAgent } from "./agents.ts";
import { makeAuthorizer } from "./authorize.ts";
import { readClaudeJson } from "./claudeJson.ts";
import { parseClaudeMcpList, type ClaudeMcpListEntry } from "./claudeMcpList.ts";
import {
  decodeClaudePluginList,
  decodeCodexMcpList,
  type ClaudePluginListEntry,
} from "./cliJson.ts";
import { listDisabledSkills, listStashedClaudeMcp } from "./disabledStore.ts";
import {
  discardRevivedStash,
  installExtension,
  requestAgents,
  setExtensionEnabled,
  uninstallExtension,
  type MutationContext,
} from "./mutations.ts";
import { readWithFingerprint, writeIfUnchanged } from "./safeFileEdit.ts";
import {
  buildSnapshotItems,
  emptyHealthCache,
  healthCellKey,
  type ClaudeProjectMcp,
  type HealthCache,
  type HealthCell,
  type SkillFolder,
  type SnapshotModelInput,
} from "./snapshotModel.ts";
import { scanUsage, type UsageTally } from "./usage.ts";

export class ForkExtensions extends Context.Service<
  ForkExtensions,
  {
    /** Fast matrix read from config and list commands; never runs a health check. */
    readonly snapshot: Effect.Effect<ForkExtensionsSnapshot, ForkExtensionsError>;
    /**
     * Fresh per-cell health: one `cell` per checked cell, then `done`. Concurrent subscribers
     * share one run (single flight); the result is cached in memory and on disk.
     */
    readonly checkHealth: Stream.Stream<ForkHealthEvent, ForkExtensionsError>;
    /** Installs in each requested agent; one result per agent, never a failure as a whole. */
    readonly install: (
      request: ForkInstallRequest,
    ) => Effect.Effect<ReadonlyArray<ForkInstallResult>>;
    /** Removes the item from each agent; one result per agent. */
    readonly uninstall: (
      input: ForkUninstallInput,
    ) => Effect.Effect<ReadonlyArray<ForkInstallResult>>;
    /** Switches the item on/off for one agent, globally (`projectPath` null) or per project. */
    readonly setEnabled: (input: ForkSetEnabledInput) => Effect.Effect<ForkInstallResult>;
    /**
     * Runs `<agent> mcp login --no-browser <name>` on this machine: `authUrl` once the login
     * prints its link, then `done` or `failed`. One login per (item, agent); closing the stream
     * stops it. Remote machines work the same: the approval happens in the user's browser.
     */
    readonly authorize: (input: {
      readonly itemId: string;
      readonly agent: ForkExtensionAgent;
    }) => Stream.Stream<ForkAuthorizeEvent, ForkExtensionsError>;
    /** Hands the pasted redirect address to that session's login; unknown/expired → notFound. */
    readonly authorizeComplete: (
      input: ForkAuthorizeCompleteInput,
    ) => Effect.Effect<void, ForkExtensionsError>;
    /** Runs `effect` in this server's single queue for Extensions writes (CLI and files). */
    readonly withWriteLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("t3/fork/extensions/ForkExtensions") {}

/** `plugin list` / `mcp list` answer in a few seconds; past this the machine is stuck. */
const SNAPSHOT_CLI_TIMEOUT_MS = 30_000;

/** `claude mcp list` connects to every server; it takes ~10 s, so it gets a long leash. */
const HEALTH_CLI_TIMEOUT_MS = 60_000;

const PersistedHealth = Schema.fromJsonString(
  Schema.Struct({
    checkedAt: Schema.NullOr(Schema.String),
    cells: Schema.Record(
      Schema.String,
      Schema.Struct({ state: ForkCellState, problem: Schema.NullOr(ForkExtensionProblem) }),
    ),
  }),
);
const decodePersistedHealth = Schema.decodeUnknownOption(PersistedHealth);
const encodePersistedHealth = Schema.encodeSync(PersistedHealth);

type HealthRun = Deferred.Deferred<ReadonlyArray<ForkHealthEvent>, ForkExtensionsError>;

type HealthCellEvent = Extract<ForkHealthEvent, { readonly _tag: "cell" }>;

/** States whose cell exists on this machine and may be probed. */
const isCheckable = (state: ForkCellState): boolean =>
  state !== "notInstalled" && state !== "notApplicable";

const claudeHealthCell = (entry: ClaudeMcpListEntry): HealthCell => {
  if (entry.state === "working") return { state: "working", problem: null };
  if (entry.state === "needsAttention" && /needs authentication/i.test(entry.detail)) {
    return {
      state: "needsAttention",
      problem: {
        reason: "needsAuthorization",
        summary: entry.detail,
        nextStep: "Authorize it.",
        rawOutput: null,
      },
    };
  }
  return {
    state: "needsAttention",
    problem: {
      reason: "commandFailed",
      summary: entry.detail,
      nextStep: "Check the server's command or URL, then check status again.",
      rawOutput: null,
    },
  };
};

const McpJson = Schema.fromJsonString(
  Schema.Struct({ mcpServers: Schema.Record(Schema.String, Schema.Unknown) }),
);
const decodeMcpJson = Schema.decodeUnknownOption(McpJson);
/** A plugin's `.mcp.json`: `{ mcpServers: {…} }` or the bare `{ <name>: {…} }` object. */
const decodePluginMcpJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type UsageByAgent = Partial<Record<ForkExtensionAgent, UsageTally>>;

interface AgentRead {
  readonly agent: ForkExtensionAgent;
  readonly available: boolean;
  readonly problem?: ForkExtensionProblem;
  readonly data: Partial<SnapshotModelInput>;
}

/** @public */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const scope = yield* Effect.scope;
  // What the reads, CLI runs and the background usage scan need, captured once.
  const context = yield* Effect.context<
    | FileSystem.FileSystem
    | Path.Path
    | ProcessRunner.ProcessRunner
    | ServerSettings.ServerSettingsService
    | ServerConfig.ServerConfig
  >();

  // One queue per server for every Extensions write; reads never take it.
  const writeLock = yield* Semaphore.make(1);
  const withWriteLock: ForkExtensions["Service"]["withWriteLock"] = (effect) =>
    writeLock.withPermits(1)(effect);

  const config = yield* ServerConfig.ServerConfig;
  const healthCacheFile = path.join(config.baseDir, "fork-extensions", "health-cache.json");

  // Persisted across restarts; a missing or corrupt file reads as empty.
  const initialHealth = yield* readWithFingerprint(healthCacheFile).pipe(
    Effect.map(({ text }): HealthCache => {
      const decoded = decodePersistedHealth(text);
      return Option.isNone(decoded)
        ? emptyHealthCache
        : {
            checkedAt: decoded.value.checkedAt,
            cells: new Map(Object.entries(decoded.value.cells)),
          };
    }),
    Effect.orElseSucceed(() => emptyHealthCache),
    Effect.provide(context),
  );
  // Filled by the health check; the snapshot only reads it.
  const healthRef = yield* Ref.make<HealthCache>(initialHealth);
  const healthInFlight = yield* Ref.make<Option.Option<HealthRun>>(Option.none());
  const usageRef = yield* Ref.make<UsageByAgent | null>(null);
  const usageScanRunning = yield* Ref.make(false);

  /** Rescans transcripts in a fiber owned by the service, one scan at a time. */
  const refreshUsageInBackground = Effect.fn("ForkExtensions.refreshUsageInBackground")(function* (
    agents: ReadonlyArray<ResolvedAgent>,
  ) {
    const start = yield* Ref.modify(usageScanRunning, (running) => [!running, true] as const);
    if (!start) return;
    const userHome = yield* HostProcess.HomeDirectory;
    yield* Effect.forEach(
      agents,
      (agent) =>
        scanUsage(agent.agent, userHome, agent.home).pipe(
          Effect.map((tally) => [agent.agent, tally] as const),
        ),
      // Both agents share one cache file; in parallel, one write would always lose the race.
      { concurrency: 1 },
    ).pipe(
      Effect.flatMap((tallies) => Ref.set(usageRef, Object.fromEntries(tallies) as UsageByAgent)),
      Effect.tapCause((cause) => Effect.logWarning("Extensions usage scan failed", { cause })),
      Effect.ignore,
      Effect.ensuring(Ref.set(usageScanRunning, false)),
      Effect.provide(context),
      Effect.forkIn(scope),
    );
  });

  const readSkillFolders = Effect.fn("ForkExtensions.readSkillFolders")(function* (
    skillsDir: string,
  ) {
    const entries = yield* fileSystem
      .readDirectory(skillsDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const folders = yield* Effect.forEach(
      entries.filter((entry) => !entry.startsWith(".")).toSorted(),
      (entry) =>
        fileSystem.exists(path.join(skillsDir, entry, "SKILL.md")).pipe(
          Effect.orElseSucceed(() => false),
          Effect.map((exists) =>
            exists
              ? Option.some<SkillFolder>({ name: entry, path: path.join(skillsDir, entry) })
              : Option.none(),
          ),
        ),
      { concurrency: 16 },
    );
    return folders.flatMap(Option.toArray);
  });

  const readProjectMcp = Effect.fn("ForkExtensions.readProjectMcp")(function* (
    projectPath: string,
  ) {
    const text = yield* fileSystem
      .readFileString(path.join(projectPath, ".mcp.json"))
      .pipe(Effect.orElseSucceed(() => ""));
    return decodeMcpJson(text).pipe(
      Option.map((parsed): ClaudeProjectMcp => ({ path: projectPath, servers: parsed.mcpServers })),
    );
  });

  /**
   * `claude plugin list --json` only lists servers declared in plugin.json; many plugins declare
   * them in `<installPath>/.mcp.json` instead. No file is normal; an unreadable one is logged.
   */
  const withPluginMcpServers = Effect.fn("ForkExtensions.withPluginMcpServers")(function* (
    plugin: ClaudePluginListEntry,
  ) {
    if (plugin.mcpServers !== undefined) return plugin;
    const file = path.join(plugin.installPath, ".mcp.json");
    if (!(yield* fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false)))) return plugin;
    const parsed = yield* fileSystem.readFileString(file).pipe(
      Effect.map(decodePluginMcpJson),
      Effect.orElseSucceed(() => Option.none<Record<string, unknown>>()),
    );
    if (Option.isNone(parsed)) {
      yield* Effect.logWarning("Extensions could not read a plugin's .mcp.json", {
        plugin: plugin.id,
        file,
      });
      return plugin;
    }
    const servers = isRecord(parsed.value.mcpServers) ? parsed.value.mcpServers : parsed.value;
    const mcpServers = Object.fromEntries(
      Object.entries(servers).filter(([, definition]) => isRecord(definition)),
    );
    return { ...plugin, mcpServers } satisfies ClaudePluginListEntry;
  });

  const readClaude = Effect.fn("ForkExtensions.readClaude")(function* (
    agent: ResolvedAgent,
    projects: ReadonlyArray<{ readonly path: string }>,
  ) {
    const [claudeJson, claudePlugins, claudeSkills, disabled, stashed, projectMcp] =
      yield* Effect.all(
        [
          readWithFingerprint(agent.configFile).pipe(
            Effect.map(({ text }) => readClaudeJson(text)),
          ),
          runCli(agent, ["plugin", "list", "--json"], { timeoutMs: SNAPSHOT_CLI_TIMEOUT_MS }).pipe(
            Effect.flatMap(({ stdout }) => decodeClaudePluginList(stdout)),
            Effect.flatMap((plugins) =>
              Effect.forEach(plugins, withPluginMcpServers, { concurrency: 8 }),
            ),
          ),
          discoverClaudeSkills({ homePath: agent.home }, undefined, agent.env),
          listDisabledSkills("claude"),
          listStashedClaudeMcp(),
          Effect.forEach(projects, (project) => readProjectMcp(project.path), {
            concurrency: 8,
          }),
        ],
        { concurrency: "unbounded" },
      );
    return {
      claudeJson,
      claudePlugins,
      claudeSkills,
      stashed,
      claudeProjectMcp: projectMcp.flatMap(Option.toArray),
      disabledSkills: { claude: disabled },
    } satisfies Partial<SnapshotModelInput>;
  });

  const readCodex = Effect.fn("ForkExtensions.readCodex")(function* (agent: ResolvedAgent) {
    const [codexMcp, codexSkills, disabled] = yield* Effect.all(
      [
        runCli(agent, ["mcp", "list", "--json"], { timeoutMs: SNAPSHOT_CLI_TIMEOUT_MS }).pipe(
          Effect.flatMap(({ stdout }) => decodeCodexMcpList(stdout)),
        ),
        readSkillFolders(agent.skillsDir),
        listDisabledSkills("codex"),
      ],
      { concurrency: "unbounded" },
    );
    return {
      codexMcp,
      codexSkills,
      disabledSkills: { codex: disabled },
    } satisfies Partial<SnapshotModelInput>;
  });

  /** Any read failure marks only that agent unavailable, with the problem; the other stays. */
  const readAgent = Effect.fn("ForkExtensions.readAgent")(
    function* (agent: ResolvedAgent, projects: ReadonlyArray<{ readonly path: string }>) {
      const data: Partial<SnapshotModelInput> =
        agent.agent === "claude" ? yield* readClaude(agent, projects) : yield* readCodex(agent);
      const read: AgentRead = { agent: agent.agent, available: true, data };
      return read;
    },
    (effect, agent) =>
      effect.pipe(
        Effect.catch((error) =>
          Effect.logWarning("Extensions could not read an agent", {
            agent: agent.agent,
            reason: error.problem.reason,
            summary: error.problem.summary,
          }).pipe(
            Effect.as<AgentRead>({
              agent: agent.agent,
              available: false,
              problem: error.problem,
              data: {},
            }),
          ),
        ),
        Effect.provide(context),
      ),
  );

  const listProjects = projectStore.listShells().pipe(
    Effect.map((shells) =>
      shells
        .filter((shell) => shell.archivedAt == null)
        .map((shell) => ({ path: shell.workspaceRoot, title: shell.title })),
    ),
    Effect.tapError((cause) =>
      Effect.logWarning("Extensions could not list T3 projects", { cause }),
    ),
    Effect.orElseSucceed((): ReadonlyArray<{ path: string; title: string }> => []),
  );

  /**
   * Review Focus 5: a switched-off Claude server re-added from the terminal shows
   * `stashDiscarded` in this snapshot, and its stale copy is dropped. That is a write, so it
   * waits for the queue in a fiber of the service; the snapshot never waits behind an install.
   */
  const discardStashConflicts = Effect.fn("ForkExtensions.discardStashConflicts")(function* (
    agents: ReadonlyArray<ResolvedAgent>,
    items: ReadonlyArray<ForkExtensionItem>,
  ) {
    const claude = agents.find((agent) => agent.agent === "claude");
    const names = items
      .filter(
        (item) =>
          item.kind === "mcp" &&
          item.cells.some((cell) => cell.agent === "claude" && cell.stashDiscarded),
      )
      .map((item) => item.name);
    if (claude === undefined || names.length === 0) return;
    yield* withWriteLock(discardRevivedStash(claude, names)).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Extensions could not drop a stale switched-off copy", {
          reason: error.problem.reason,
          summary: error.problem.summary,
        }),
      ),
      Effect.provide(context),
      Effect.forkIn(scope),
    );
  });

  const snapshot: ForkExtensions["Service"]["snapshot"] = Effect.gen(function* () {
    const [agents, projects] = yield* Effect.all(
      [resolveAgents().pipe(Effect.provide(context)), listProjects],
      { concurrency: "unbounded" },
    );
    const reads = yield* Effect.forEach(agents, (agent) => readAgent(agent, projects), {
      concurrency: "unbounded",
    });
    const available = reads.filter((read) => read.available);

    // Usage never blocks the snapshot: counts are 0 until the first background scan lands.
    yield* refreshUsageInBackground(
      agents.filter((agent) => available.some((read) => read.agent === agent.agent)),
    );
    const usage = (yield* Ref.get(usageRef)) ?? {};
    const health = yield* Ref.get(healthRef);

    // Each agent fills its own fields; only disabledSkills is shared.
    const merged: Partial<SnapshotModelInput> = Object.assign(
      {},
      ...available.map((read) => read.data),
    );
    const disabledSkills: SnapshotModelInput["disabledSkills"] = Object.assign(
      {},
      ...available.map((read) => read.data.disabledSkills ?? {}),
    );
    const items = buildSnapshotItems({
      agents: available.map((read) => read.agent),
      claudeJson: merged.claudeJson ?? null,
      claudeProjectMcp: merged.claudeProjectMcp ?? [],
      claudePlugins: merged.claudePlugins ?? [],
      claudeSkills: merged.claudeSkills ?? [],
      codexMcp: merged.codexMcp ?? [],
      codexSkills: merged.codexSkills ?? [],
      stashed: merged.stashed ?? {},
      disabledSkills,
      health,
      usage,
      projects,
    });
    yield* discardStashConflicts(agents, items);
    return {
      protocolVersion: FORK_EXTENSIONS_PROTOCOL_VERSION,
      agents: reads.map((read) =>
        read.problem === undefined
          ? { agent: read.agent, available: read.available }
          : { agent: read.agent, available: read.available, problem: read.problem },
      ),
      projects,
      items,
      healthCheckedAt: health.checkedAt,
    } satisfies ForkExtensionsSnapshot;
  }).pipe(Effect.withSpan("ForkExtensions.snapshot"));

  /** Another check (or the terminal) may have touched the file; the cache is best effort. */
  const persistHealth = Effect.fn("ForkExtensions.persistHealth")(function* (cache: HealthCache) {
    const text = encodePersistedHealth({
      checkedAt: cache.checkedAt,
      cells: Object.fromEntries(cache.cells),
    });
    const { fingerprint } = yield* readWithFingerprint(healthCacheFile);
    yield* writeIfUnchanged(healthCacheFile, fingerprint, text, (next) =>
      Option.isSome(decodePersistedHealth(next)),
    );
  });

  const runHealthCheck = Effect.fn("ForkExtensions.runHealthCheck")(function* () {
    const [current, agents] = yield* Effect.all([
      snapshot,
      resolveAgents().pipe(Effect.provide(context)),
    ]);
    const available = new Set(current.agents.filter((a) => a.available).map((a) => a.agent));
    const cells: Array<HealthCellEvent> = [];
    const push = (itemId: string, agent: ForkExtensionAgent, cell: HealthCell) =>
      cells.push({ _tag: "cell", itemId, agent, state: cell.state, problem: cell.problem });

    // Codex has no connection probe in v1: switched off is disabled, otherwise working.
    if (available.has("codex")) {
      for (const item of current.items) {
        const cell = item.cells.find((candidate) => candidate.agent === "codex");
        if (item.kind !== "mcp" || cell === undefined || !isCheckable(cell.state)) continue;
        push(item.id, "codex", {
          state: cell.state === "disabled" ? "disabled" : "working",
          problem: null,
        });
      }
    }

    const claude = agents.find((agent) => agent.agent === "claude");
    if (available.has("claude") && claude !== undefined) {
      const listed = yield* runCli(claude, ["mcp", "list"], {
        timeoutMs: HEALTH_CLI_TIMEOUT_MS,
      }).pipe(
        Effect.map(({ stdout }) => ({ entries: parseClaudeMcpList(stdout), problem: null })),
        Effect.catch((error) =>
          Effect.succeed({
            entries: [] as ReadonlyArray<ClaudeMcpListEntry>,
            problem: error.problem,
          }),
        ),
        Effect.provide(context),
      );
      if (listed.problem === null) {
        for (const entry of listed.entries) {
          push(`mcp:${entry.name}`, "claude", claudeHealthCell(entry));
        }
      } else {
        // The command timed out or failed: every installed, switched-on server is unverified.
        const problem = listed.problem;
        for (const item of current.items) {
          const cell = item.cells.find((candidate) => candidate.agent === "claude");
          if (item.kind !== "mcp" || cell === undefined) continue;
          if (!isCheckable(cell.state) || cell.state === "disabled") continue;
          push(item.id, "claude", { state: "needsAttention", problem });
        }
      }
    }

    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const cache: HealthCache = {
      checkedAt,
      cells: new Map(cells.map((cell) => [healthCellKey(cell.itemId, cell.agent), cell])),
    };
    yield* Ref.set(healthRef, cache);
    yield* persistHealth(cache).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Extensions could not save the health cache", {
          reason: error.problem.reason,
        }),
      ),
      Effect.provide(context),
    );
    return [...cells, { _tag: "done", checkedAt }] satisfies ReadonlyArray<ForkHealthEvent>;
  });

  /** Joins the run in progress, or starts one in a fiber owned by the service. */
  const sharedHealthCheck = Effect.gen(function* () {
    const fresh: HealthRun = yield* Deferred.make<
      ReadonlyArray<ForkHealthEvent>,
      ForkExtensionsError
    >();
    const { deferred, owner } = yield* Ref.modify(
      healthInFlight,
      (
        inFlight: Option.Option<HealthRun>,
      ): readonly [{ deferred: HealthRun; owner: boolean }, Option.Option<HealthRun>] =>
        Option.isSome(inFlight)
          ? [{ deferred: inFlight.value, owner: false }, inFlight]
          : [{ deferred: fresh, owner: true }, Option.some(fresh)],
    );
    if (owner) {
      yield* runHealthCheck().pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          Ref.set(healthInFlight, Option.none()).pipe(
            Effect.andThen(Deferred.done(deferred, exit)),
          ),
        ),
        Effect.forkIn(scope),
      );
    }
    return yield* Deferred.await(deferred);
  });

  const checkHealth = Stream.fromIterableEffect(sharedHealthCheck);

  const mutationContext = Effect.all(
    [resolveAgents().pipe(Effect.provide(context)), listProjects],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map(([agents, projects]): MutationContext => ({ agents, projects, withWriteLock })),
  );

  const install: ForkExtensions["Service"]["install"] = (request) =>
    mutationContext.pipe(
      Effect.flatMap((mutation) => installExtension(mutation, request)),
      Effect.catch((error) =>
        Effect.succeed(
          requestAgents(request).map((agent): ForkInstallResult => ({
            agent,
            ok: false,
            problem: error.problem,
          })),
        ),
      ),
      Effect.provide(context),
      Effect.withSpan("ForkExtensions.install"),
    );

  const uninstall: ForkExtensions["Service"]["uninstall"] = (input) =>
    mutationContext.pipe(
      Effect.flatMap((mutation) => uninstallExtension(mutation, input)),
      Effect.catch((error) =>
        Effect.succeed(
          input.agents.map((agent): ForkInstallResult => ({
            agent,
            ok: false,
            problem: error.problem,
          })),
        ),
      ),
      Effect.provide(context),
      Effect.withSpan("ForkExtensions.uninstall"),
    );

  const setEnabled: ForkExtensions["Service"]["setEnabled"] = (input) =>
    mutationContext.pipe(
      Effect.flatMap((mutation) => setExtensionEnabled(mutation, input)),
      Effect.catch((error) =>
        Effect.succeed<ForkInstallResult>({
          agent: input.agent,
          ok: false,
          problem: error.problem,
        }),
      ),
      Effect.provide(context),
      Effect.withSpan("ForkExtensions.setEnabled"),
    );

  /** A finished login makes the cached cell stale: it shows unknown until the next check. */
  const forgetHealthCell = Effect.fn("ForkExtensions.forgetHealthCell")(function* (target: {
    readonly itemId: string;
    readonly agent: ForkExtensionAgent;
  }) {
    const key = healthCellKey(target.itemId, target.agent);
    const cache = yield* Ref.modify(healthRef, (current): readonly [HealthCache, HealthCache] => {
      const cells = new Map(current.cells);
      cells.set(key, { state: "unknown", problem: null });
      const next: HealthCache = { checkedAt: current.checkedAt, cells };
      return [next, next];
    });
    yield* persistHealth(cache).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Extensions could not save the health cache", {
          reason: error.problem.reason,
        }),
      ),
      Effect.provide(context),
    );
  });

  const authorizer = yield* makeAuthorizer({ onDone: forgetHealthCell });

  const authorize: ForkExtensions["Service"]["authorize"] = (input) =>
    Stream.unwrap(
      resolveAgents().pipe(
        Effect.flatMap((agents) => {
          const agent = agents.find((candidate) => candidate.agent === input.agent);
          if (agent !== undefined) return Effect.succeed(authorizer.authorize(agent, input));
          return Effect.fail(
            new ForkExtensionsError({
              problem: {
                reason: "notFound",
                summary: `${input.agent === "claude" ? "Claude Code" : "Codex"} isn't set up on this machine.`,
                nextStep: "Enable it in Settings → Providers on that machine.",
                rawOutput: null,
              },
            }),
          );
        }),
        Effect.provide(context),
      ),
    );

  return ForkExtensions.of({
    snapshot,
    checkHealth,
    install,
    uninstall,
    setEnabled,
    authorize,
    authorizeComplete: authorizer.authorizeComplete,
    withWriteLock,
  });
});

/** @public Wired into the server runtime by the Extensions RPC methods. */
export const layer = Layer.effect(ForkExtensions, make).pipe(Layer.provide(ProcessRunner.layer));
