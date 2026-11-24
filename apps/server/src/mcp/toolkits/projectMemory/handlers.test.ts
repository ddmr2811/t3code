import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../../config.ts";
import * as ForkProjectMemory from "../../../fork/memory/ForkProjectMemory.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as ProjectMemoryHandlers from "./handlers.ts";
import { ProjectMemoryToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread:memory");
const callerProject = liveThreadShell(threadId).projectId;
const otherProject = ProjectId.make("project:other");

it.effect("saves an agent's note as searchable in the calling thread's own project", () =>
  Effect.gen(function* () {
    const toolkit = yield* ProjectMemoryToolkit;
    const memory = yield* ForkProjectMemory.ForkProjectMemory;
    const saved = yield* toolkit
      .handle("project_memory_save", { text: "Los despliegues van por Fly." })
      .pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.map((parts) => parts.at(-1)?.result),
      );

    expect(saved).toMatchObject({ inclusion: "searchable" });
    expect((yield* memory.list({ projectId: callerProject })).notes).toMatchObject([
      { text: "Los despliegues van por Fly.", inclusion: "searchable", origin: "agent" },
    ]);
    expect((yield* memory.list({ projectId: otherProject })).notes).toEqual([]);
  }).pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(ProjectMemoryHandlers.layer).pipe(
        Layer.provideMerge(ForkProjectMemory.layer),
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.succeed(McpInvocationContext.McpInvocationContext, {
              environmentId: EnvironmentId.make("environment:memory"),
              requestNamespace: "provider:memory",
              thread: {
                threadId,
                providerSessionId: "provider:memory",
                providerInstanceId: ProviderInstanceId.make("codex"),
              },
              client: undefined,
              capabilities: new Set(["orchestration" as const]),
              issuedAt: 0,
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
            }),
            Layer.mock(ProjectService.ProjectService)({
              getById: (projectId) => Effect.succeedSome({ id: projectId } as never),
            }),
            ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-memory-mcp-test-" }),
          ),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  ),
);
