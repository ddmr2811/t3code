// @effect-diagnostics nodeBuiltinImport:off -- Symlink, chmod, and mkfifo security fixtures require node:fs/promises and node:child_process.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";

import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  FORK_COORDINATION_MAX_ENTRIES,
  FORK_COORDINATION_MAX_FILE_BYTES,
  ThreadId,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as RpcTest from "effect/rpc/RpcTest";
import * as TestClock from "effect/testing/TestClock";

import * as RpcAuthorization from "../../auth/RpcAuthorization.ts";
import * as ServerConfig from "../../config.ts";
import * as ForkCoordination from "./ForkCoordination.ts";

const makeTestLayer = () =>
  ForkCoordination.layer.pipe(
    Layer.provideMerge(
      ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-fork-coord-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const withTempCoordination = <A, E, R>(
  use: (args: {
    readonly stateDir: string;
    readonly forkDir: string;
    readonly coordinationFile: string;
    readonly service: ForkCoordination.ForkCoordination["Service"];
    readonly fs: FileSystem.FileSystem;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const service = yield* ForkCoordination.ForkCoordination;
      const forkDir = path.join(config.stateDir, "fork");
      return yield* use({
        stateDir: config.stateDir,
        forkDir,
        coordinationFile: path.join(forkDir, "coordination.json"),
        service,
        fs,
      });
    }).pipe(Effect.provide(makeTestLayer())),
  );

describe("ForkCoordination", () => {
  it.effect("persists entries atomically with 0700/0600 permissions and filters by project", () =>
    withTempCoordination(({ forkDir, coordinationFile, service, fs }) =>
      Effect.gen(function* () {
        expect(yield* service.list({})).toEqual({ entries: [], updatedAt: null });

        yield* TestClock.setTime(Date.parse("2026-11-23T10:00:00.000Z"));
        const first = yield* service.upsert({
          id: "coord:api",
          projectKey: "proj:api",
          projectName: "API",
          threadId: ThreadId.make("thread-api-1"),
          agentName: "Codex",
          status: "working",
          workingOn: "Migrando contrato RPC",
          completedSummary: "Esquemas definidos",
          waitingFor: "",
          modelLabel: "gpt-5.4",
        });

        yield* TestClock.setTime(Date.parse("2026-11-23T10:05:00.000Z"));
        const second = yield* service.upsert({
          projectKey: "proj:web",
          projectName: "Web ADE",
          agentName: "Claude",
          status: "waiting",
          workingOn: "Bandeja de pendientes",
          completedSummary: "Filtros listos",
          waitingFor: "Confirmación de UX",
        });

        expect(first.updatedAt).toBe("2026-11-23T10:00:00.000Z");
        expect(second.id).toMatch(/^coord:/);

        const platform = yield* HostProcess.Platform;
        if (platform !== "win32") {
          const dirStat = yield* fs.stat(forkDir);
          const fileStat = yield* fs.stat(coordinationFile);
          expect(dirStat.mode & 0o777).toBe(0o700);
          expect(fileStat.mode & 0o777).toBe(0o600);
        }

        const all = yield* service.list({});
        expect(all.updatedAt).toBe("2026-11-23T10:05:00.000Z");
        expect(all.entries.map((entry) => entry.id)).toEqual([second.id, "coord:api"]);

        const onlyApi = yield* service.list({ projectKey: "proj:api" });
        expect(onlyApi.entries).toEqual([first]);

        yield* TestClock.setTime(Date.parse("2026-11-23T10:10:00.000Z"));
        const updated = yield* service.upsert({
          id: "coord:api",
          projectKey: "proj:api",
          projectName: "API",
          threadId: ThreadId.make("thread-api-1"),
          agentName: "Codex",
          status: "done",
          workingOn: "",
          completedSummary: "RPCs y pruebas en verde",
          waitingFor: "",
        });
        expect(updated.status).toBe("done");
        expect(updated.modelLabel).toBeUndefined();
        expect((yield* service.list({})).entries.map((entry) => entry.id)).toEqual([
          "coord:api",
          second.id,
        ]);

        expect(yield* service.remove({ id: second.id })).toEqual({ removed: true, id: second.id });
        expect(yield* service.remove({ id: second.id })).toEqual({ removed: false, id: second.id });
        expect((yield* service.list({})).entries.map((entry) => entry.id)).toEqual(["coord:api"]);
      }),
    ),
  );

  it.effect("tightens pre-existing looser directory (0755) and file (0644) modes on write", () =>
    withTempCoordination(({ forkDir, coordinationFile, service, fs }) =>
      Effect.gen(function* () {
        const platform = yield* HostProcess.Platform;
        if (platform === "win32") return;

        yield* Effect.promise(() => NodeFSP.mkdir(forkDir, { recursive: true, mode: 0o755 }));
        yield* Effect.promise(() => NodeFSP.chmod(forkDir, 0o755));
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            coordinationFile,
            JSON.stringify({ version: 1, updatedAt: null, entries: [] }),
            { mode: 0o644 },
          ),
        );
        yield* Effect.promise(() => NodeFSP.chmod(coordinationFile, 0o644));

        yield* service.upsert({
          id: "coord:tight",
          projectKey: "proj:tight",
          projectName: "Tight",
          agentName: "Bot",
          status: "working",
          workingOn: "Check perms",
          completedSummary: "",
          waitingFor: "",
        });

        const dirStat = yield* fs.stat(forkDir);
        const fileStat = yield* fs.stat(coordinationFile);
        expect(dirStat.mode & 0o777).toBe(0o700);
        expect(fileStat.mode & 0o777).toBe(0o600);
      }),
    ),
  );

  it.effect("refuses symlinks on coordination.json and fork/ without leaking host paths", () =>
    withTempCoordination(({ stateDir, forkDir, coordinationFile, service }) =>
      Effect.gen(function* () {
        const platform = yield* HostProcess.Platform;
        if (platform === "win32") return;

        const path = yield* Path.Path;
        const outsideTarget = path.join(stateDir, "outside-secret.txt");
        yield* Effect.promise(() => NodeFSP.writeFile(outsideTarget, "DO_NOT_OVERWRITE", "utf8"));
        yield* Effect.promise(() => NodeFSP.mkdir(forkDir, { recursive: true, mode: 0o700 }));
        yield* Effect.promise(() => NodeFSP.symlink(outsideTarget, coordinationFile));

        const readSymlink = yield* service.list({}).pipe(Effect.flip);
        expect(readSymlink).toMatchObject({
          _tag: "ForkCoordinationError",
          reason: "storageFailed",
        });
        expect(readSymlink.message).not.toContain(stateDir);
        expect(readSymlink.message).not.toContain("coordination.json");

        const writeSymlink = yield* service
          .upsert({
            id: "coord:sym",
            projectKey: "proj:sym",
            projectName: "Sym",
            agentName: "Bot",
            status: "working",
            workingOn: "Blocked",
            completedSummary: "",
            waitingFor: "",
          })
          .pipe(Effect.flip);
        expect(writeSymlink).toMatchObject({
          _tag: "ForkCoordinationError",
          reason: "storageFailed",
        });
        expect(writeSymlink.message).not.toContain(stateDir);
        expect(yield* Effect.promise(() => NodeFSP.readFile(outsideTarget, "utf8"))).toBe(
          "DO_NOT_OVERWRITE",
        );

        // Now test symlinked fork/ directory.
        const outsideDir = path.join(stateDir, "outside-dir");
        yield* Effect.promise(() => NodeFSP.mkdir(outsideDir, { recursive: true }));
        yield* Effect.promise(() => NodeFSP.rm(forkDir, { recursive: true, force: true }));
        yield* Effect.promise(() => NodeFSP.symlink(outsideDir, forkDir));

        const readSymDir = yield* service.list({}).pipe(Effect.flip);
        expect(readSymDir).toMatchObject({
          _tag: "ForkCoordinationError",
          reason: "storageFailed",
        });
        expect(readSymDir.message).not.toContain(stateDir);

        const writeSymDir = yield* service
          .upsert({
            id: "coord:symdir",
            projectKey: "proj:sym",
            projectName: "Sym",
            agentName: "Bot",
            status: "working",
            workingOn: "Blocked",
            completedSummary: "",
            waitingFor: "",
          })
          .pipe(Effect.flip);
        expect(writeSymDir).toMatchObject({
          _tag: "ForkCoordinationError",
          reason: "storageFailed",
        });
        expect(writeSymDir.message).not.toContain(stateDir);
      }),
    ),
  );

  it.effect("refuses FIFO at coordination.json without blocking", () =>
    withTempCoordination(({ forkDir, coordinationFile, service }) =>
      Effect.gen(function* () {
        const platform = yield* HostProcess.Platform;
        if (platform === "win32") return;

        yield* Effect.promise(() => NodeFSP.mkdir(forkDir, { recursive: true, mode: 0o700 }));
        NodeChildProcess.execFileSync("mkfifo", [coordinationFile]);

        const readFifo = yield* service.list({}).pipe(Effect.flip);
        expect(readFifo).toMatchObject({ _tag: "ForkCoordinationError", reason: "storageFailed" });

        const writeFifo = yield* service
          .upsert({
            id: "coord:fifo",
            projectKey: "proj:fifo",
            projectName: "Fifo",
            agentName: "Bot",
            status: "working",
            workingOn: "Should not block",
            completedSummary: "",
            waitingFor: "",
          })
          .pipe(Effect.flip);
        expect(writeFifo).toMatchObject({ _tag: "ForkCoordinationError", reason: "storageFailed" });
      }),
    ),
  );

  it.effect(
    "rejects path traversal, control characters, invalid threadId, and oversized fields",
    () =>
      withTempCoordination(({ service }) =>
        Effect.gen(function* () {
          const invalidCases = [
            {
              id: "../escape",
              projectKey: "proj:ok",
              projectName: "OK",
              agentName: "Bot",
              status: "working" as const,
              workingOn: "a",
              completedSummary: "",
              waitingFor: "",
            },
            {
              projectKey: "foo/../bar",
              projectName: "OK",
              agentName: "Bot",
              status: "working" as const,
              workingOn: "a",
              completedSummary: "",
              waitingFor: "",
            },
            {
              projectKey: "proj:ok",
              projectName: "Bad\u0000Name",
              agentName: "Bot",
              status: "working" as const,
              workingOn: "a",
              completedSummary: "",
              waitingFor: "",
            },
            {
              projectKey: "proj:ok",
              projectName: "OK",
              threadId: ThreadId.make("t".repeat(129)),
              agentName: "Bot",
              status: "working" as const,
              workingOn: "a",
              completedSummary: "",
              waitingFor: "",
            },
            {
              projectKey: "proj:ok",
              projectName: "OK",
              threadId: ThreadId.make("thread\nbad"),
              agentName: "Bot",
              status: "working" as const,
              workingOn: "a",
              completedSummary: "",
              waitingFor: "",
            },
            {
              projectKey: "proj:ok",
              projectName: "OK",
              agentName: "Bot",
              status: "working" as const,
              workingOn: "x".repeat(501),
              completedSummary: "",
              waitingFor: "",
            },
          ];

          for (const payload of invalidCases) {
            const error = yield* service.upsert(payload).pipe(Effect.flip);
            expect(error).toMatchObject({ _tag: "ForkCoordinationError", reason: "invalidInput" });
          }

          const badFilter = yield* service.list({ projectKey: "../etc" }).pipe(Effect.flip);
          expect(badFilter).toMatchObject({
            _tag: "ForkCoordinationError",
            reason: "invalidInput",
          });
        }),
      ),
  );

  it.effect("enforces max entry count while still allowing updates to existing entries", () =>
    withTempCoordination(({ service }) =>
      Effect.gen(function* () {
        for (let index = 0; index < FORK_COORDINATION_MAX_ENTRIES; index += 1) {
          yield* service.upsert({
            id: `entry:${index}`,
            projectKey: "proj:cap",
            projectName: "Cap",
            agentName: "Bot",
            status: "working",
            workingOn: `Task ${index}`,
            completedSummary: "",
            waitingFor: "",
          });
        }

        const overflow = yield* service
          .upsert({
            id: "entry:overflow",
            projectKey: "proj:cap",
            projectName: "Cap",
            agentName: "Bot",
            status: "working",
            workingOn: "Too many",
            completedSummary: "",
            waitingFor: "",
          })
          .pipe(Effect.flip);
        expect(overflow).toMatchObject({ _tag: "ForkCoordinationError", reason: "limitExceeded" });

        // Updating an existing entry does not grow the board.
        const updated = yield* service.upsert({
          id: "entry:0",
          projectKey: "proj:cap",
          projectName: "Cap",
          agentName: "Bot",
          status: "done",
          workingOn: "",
          completedSummary: "Finished",
          waitingFor: "",
        });
        expect(updated.status).toBe("done");
      }),
    ),
  );

  it.effect("rejects oversized, over-cap, or corrupted store files without leaking paths", () =>
    withTempCoordination(({ stateDir, forkDir, coordinationFile, service, fs }) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(forkDir, { recursive: true });
        yield* fs.writeFileString(coordinationFile, "{not-valid-json");

        const corrupt = yield* service.list({}).pipe(Effect.flip);
        expect(corrupt).toMatchObject({ _tag: "ForkCoordinationError", reason: "storageFailed" });
        expect(corrupt.message).not.toContain(stateDir);
        expect(corrupt.message).not.toContain("coordination.json");

        const tooManyEntries = Array.from(
          { length: FORK_COORDINATION_MAX_ENTRIES + 1 },
          (_, i) => ({
            id: `e:${i}`,
            projectKey: "p",
            projectName: "P",
            agentName: "B",
            status: "working",
            workingOn: "x",
            completedSummary: "",
            waitingFor: "",
            updatedAt: "2026-11-23T10:00:00.000Z",
          }),
        );
        yield* fs.writeFileString(
          coordinationFile,
          JSON.stringify({ version: 1, updatedAt: null, entries: tooManyEntries }),
        );
        const overCap = yield* service.list({}).pipe(Effect.flip);
        expect(overCap).toMatchObject({ _tag: "ForkCoordinationError", reason: "storageFailed" });
        expect(overCap.message).not.toContain(stateDir);

        yield* fs.writeFileString(
          coordinationFile,
          " ".repeat(FORK_COORDINATION_MAX_FILE_BYTES + 16),
        );
        const oversized = yield* service.list({}).pipe(Effect.flip);
        expect(oversized).toMatchObject({ _tag: "ForkCoordinationError", reason: "limitExceeded" });
      }),
    ),
  );

  it.effect("requires read scope to list and operate scope to upsert or remove via RPC", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tested = [
          WS_METHODS.forkCoordinationList,
          WS_METHODS.forkCoordinationUpsert,
          WS_METHODS.forkCoordinationRemove,
        ] as const;
        const group = WsRpcGroup.omit(
          ...[...WsRpcGroup.requests.keys()].filter(
            (
              tag,
            ): tag is Exclude<
              keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES,
              (typeof tested)[number]
            > => !(tested as ReadonlyArray<string>).includes(tag),
          ),
        );

        const service = yield* ForkCoordination.ForkCoordination.pipe(
          Effect.provide(makeTestLayer()),
        );
        const handlers = Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.forkCoordinationList, (input) => service.list(input)),
          group.toLayerHandler(WS_METHODS.forkCoordinationUpsert, (input) => service.upsert(input)),
          group.toLayerHandler(WS_METHODS.forkCoordinationRemove, (input) => service.remove(input)),
        );

        const reader = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(handlers, RpcAuthorization.layer([AuthOrchestrationReadScope])),
          ),
        );
        expect((yield* reader[WS_METHODS.forkCoordinationList]({})).entries).toEqual([]);
        expect(
          yield* reader[WS_METHODS.forkCoordinationUpsert]({
            projectKey: "proj:a",
            projectName: "A",
            agentName: "Bot",
            status: "working",
            workingOn: "Work",
            completedSummary: "",
            waitingFor: "",
          }).pipe(Effect.flip),
        ).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
          requiredPermission: AuthOrchestrationOperateScope,
        });
        expect(
          yield* reader[WS_METHODS.forkCoordinationRemove]({ id: "coord:1" }).pipe(Effect.flip),
        ).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
          requiredPermission: AuthOrchestrationOperateScope,
        });

        const operator = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(
              handlers,
              RpcAuthorization.layer([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]),
            ),
          ),
        );
        const created = yield* operator[WS_METHODS.forkCoordinationUpsert]({
          id: "coord:1",
          projectKey: "proj:a",
          projectName: "A",
          agentName: "Bot",
          status: "working",
          workingOn: "Work",
          completedSummary: "",
          waitingFor: "",
        });
        expect(created.id).toBe("coord:1");
        expect(yield* operator[WS_METHODS.forkCoordinationRemove]({ id: "coord:1" })).toEqual({
          removed: true,
          id: "coord:1",
        });
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
});
