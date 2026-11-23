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
      return yield* use({
        stateDir: config.stateDir,
        coordinationFile: path.join(config.stateDir, "fork", "coordination.json"),
        service,
        fs,
      });
    }).pipe(Effect.provide(makeTestLayer())),
  );

describe("ForkCoordination", () => {
  it.effect("persists entries atomically with 0600 permissions and filters by project", () =>
    withTempCoordination(({ coordinationFile, service, fs }) =>
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

        const stat = yield* fs.stat(coordinationFile);
        const platform = yield* HostProcess.Platform;
        if (platform !== "win32") {
          expect(stat.mode & 0o777).toBe(0o600);
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

  it.effect("rejects path traversal, control characters, and oversized fields", () =>
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
        expect(badFilter).toMatchObject({ _tag: "ForkCoordinationError", reason: "invalidInput" });
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

  it.effect("rejects oversized or corrupted store files without wiping them", () =>
    withTempCoordination(({ coordinationFile, service, fs }) =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        yield* fs.makeDirectory(path.dirname(coordinationFile), { recursive: true });
        yield* fs.writeFileString(coordinationFile, "{not-valid-json");

        const corrupt = yield* service.list({}).pipe(Effect.flip);
        expect(corrupt).toMatchObject({ _tag: "ForkCoordinationError", reason: "storageFailed" });

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
