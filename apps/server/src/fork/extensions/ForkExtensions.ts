import {
  FORK_EXTENSIONS_PROTOCOL_VERSION,
  type ForkExtensionAgent,
  type ForkExtensionProblem,
  type ForkExtensionsError,
  type ForkExtensionsSnapshot,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../../config.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { discoverClaudeSkills } from "../../provider/Drivers/ClaudeSkills.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { resolveAgents, runCli, type ResolvedAgent } from "./agents.ts";
import { readClaudeJson } from "./claudeJson.ts";
import {
  decodeClaudePluginList,
  decodeCodexMcpList,
  type ClaudePluginListEntry,
} from "./cliJson.ts";
import { listDisabledSkills, listStashedClaudeMcp } from "./disabledStore.ts";
import { readWithFingerprint } from "./safeFileEdit.ts";
import {
  buildSnapshotItems,
  emptyHealthCache,
  type ClaudeProjectMcp,
  type HealthCache,
  type SkillFolder,
  type SnapshotModelInput,
} from "./snapshotModel.ts";
import { scanUsage, type UsageTally } from "./usage.ts";

export class ForkExtensions extends Context.Service<
  ForkExtensions,
  {
    /** Fast matrix read from config and list commands; never runs a health check. */
    readonly snapshot: Effect.Effect<ForkExtensionsSnapshot, ForkExtensionsError>;
    /** Runs `effect` in this server's single queue for Extensions writes (CLI and files). */
    readonly withWriteLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  }
>()("t3/fork/extensions/ForkExtensions") {}

/** `plugin list` / `mcp list` answer in a few seconds; past this the machine is stuck. */
const SNAPSHOT_CLI_TIMEOUT_MS = 30_000;

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

  // Filled by the health check; the snapshot only reads it.
  const healthRef = yield* Ref.make<HealthCache>(emptyHealthCache);
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

  return ForkExtensions.of({ snapshot, withWriteLock });
});

/** @public Wired into the server runtime by the Extensions RPC methods. */
export const layer = Layer.effect(ForkExtensions, make).pipe(Layer.provide(ProcessRunner.layer));
