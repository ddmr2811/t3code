import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ForkExtensionsSnapshot,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../../config.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ForkExtensions from "./ForkExtensions.ts";

const decodeSnapshot = Schema.decodeUnknownSync(ForkExtensionsSnapshot);

const PLUGINS = JSON.stringify([
  {
    id: "superpowers@claude-plugins-official",
    scope: "user",
    enabled: true,
    installPath: "/nowhere/superpowers",
  },
]);

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

/** ProcessRunner that records every call; `codex` is not installed. */
const recordingRunner = (calls: Ref.Ref<ReadonlyArray<ReadonlyArray<string>>>) =>
  Layer.succeed(
    ProcessRunner.ProcessRunner,
    ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Ref.update(calls, (all) => [...all, [input.command, ...input.args]]).pipe(
          Effect.andThen(() => {
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
              input.args.join(" ") === "plugin list --json" ? output(PLUGINS) : output(""),
            );
          }),
        ),
    }),
  );

const withService = <A, E>(
  body: (input: {
    readonly service: ForkExtensions.ForkExtensions["Service"];
    readonly calls: Ref.Ref<ReadonlyArray<ReadonlyArray<string>>>;
  }) => Effect.Effect<A, E>,
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
    const calls = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
    const layer = Layer.effect(ForkExtensions.ForkExtensions, ForkExtensions.make).pipe(
      Layer.provide(
        Layer.mergeAll(
          recordingRunner(calls),
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
        ),
      ),
    );
    return yield* Effect.gen(function* () {
      const service = yield* ForkExtensions.ForkExtensions;
      return yield* body({ service, calls });
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
          "plugin:superpowers@claude-plugins-official",
        ]);
        expect(snapshot.projects).toEqual([{ path: expect.stringMatching(/app$/), title: "App" }]);
        expect(snapshot.healthCheckedAt).toBeNull();
      }),
    ),
  );

  it.effect("keeps going when one agent's binary is missing", () =>
    withService(({ service }) =>
      Effect.gen(function* () {
        const snapshot = yield* service.snapshot;
        expect(snapshot.agents).toEqual([
          { agent: "claude", available: true },
          { agent: "codex", available: false },
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
