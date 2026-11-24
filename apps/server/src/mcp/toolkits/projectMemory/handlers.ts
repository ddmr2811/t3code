import { type ForkMemoryError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ForkProjectMemory from "../../../fork/memory/ForkProjectMemory.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { unavailable } from "../../threadAccess.ts";
import { ProjectMemoryToolkit } from "./tools.ts";

/** The calling thread's own project; the tools never take one, so they cannot reach another. */
const callerProject = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const caller = yield* McpInvocationContext.requireThreadScope(scope, "Project memory");
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const shell = yield* threads
    .getThreadShell(caller.thread.threadId)
    .pipe(Effect.mapError(unavailable));
  if (shell === null || shell.deletedAt !== null) {
    return yield* new OrchestratorMcpFailure({
      code: "thread_not_found",
      message: "The calling thread was not found.",
    });
  }
  return shell.projectId;
});

const toFailure = (error: ForkMemoryError) =>
  new OrchestratorMcpFailure({
    code: error.reason === "storageFailed" ? "orchestration_error" : "invalid_request",
    message: error.message,
  });

export const layer = McpToolAccess.toLayer(ProjectMemoryToolkit, {
  project_memory_search: McpToolAccess.readsAsCaller(({ query }) =>
    Effect.gen(function* () {
      const memory = yield* ForkProjectMemory.ForkProjectMemory;
      const found = yield* memory
        .search(yield* callerProject, query)
        .pipe(Effect.mapError(toFailure));
      return {
        notes: found.notes.map(({ id, text, inclusion, origin, updatedAt }) => ({
          id,
          text,
          inclusion,
          origin,
          updatedAt,
        })),
        total: found.total,
      };
    }),
  ),
  project_memory_save: McpToolAccess.actsAsCaller(({ text, replaces }) =>
    Effect.gen(function* () {
      const memory = yield* ForkProjectMemory.ForkProjectMemory;
      const note = yield* memory
        .upsert(
          // Essential notes reach the coordinator's turn, which may run with more access than
          // this caller, so only the user promotes a note there.
          { projectId: yield* callerProject, text, inclusion: "searchable" },
          "agent",
          replaces,
        )
        .pipe(Effect.mapError(toFailure));
      return { id: note.id, inclusion: note.inclusion };
    }),
  ),
});
