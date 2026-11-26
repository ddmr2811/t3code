import {
  ForkMemoryInclusion,
  ForkMemoryNoteId,
  ForkMemoryOrigin,
  ForkMemoryInputText,
  IsoDateTime,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ForkProjectMemory from "../../../fork/memory/ForkProjectMemory.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ForkProjectMemory.ForkProjectMemory,
  ],
};

const MemoryNote = Schema.Struct({
  id: ForkMemoryNoteId,
  text: Schema.String,
  inclusion: ForkMemoryInclusion,
  origin: ForkMemoryOrigin,
  updatedAt: IsoDateTime,
});

// Fork: project memory lives on the server, so it survives a new thread or another provider.
const ProjectMemorySearchTool = Tool.make("project_memory_search", {
  ...shared,
  description:
    "Search this project's memory: notes the user and agents saved across threads and providers. Every word of `query` must appear in a note; an empty query lists the newest. Search when the task may depend on an earlier decision, convention or finding.",
  parameters: Schema.Struct({
    query: Schema.String.check(Schema.isMaxLength(200)),
  }),
  success: Schema.Struct({
    notes: Schema.Array(MemoryNote),
    total: Schema.Number.annotate({ description: "Matches before the 50-note limit." }),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const ProjectMemorySaveTool = Tool.make("project_memory_save", {
  ...shared,
  description:
    "Save one durable fact to this project's memory, without being asked, when you learn something later work here will need: a decision, a convention, a fact that took effort to find. Not progress, not what the repo already says. One fact per note, one line. Notes are found with `project_memory_search`; only the user marks one essential, so propose it in your reply when a note should reach every turn. `replaces` merges agent notes: the listed ones are removed in the same save. Notes the user wrote cannot be replaced; propose changes to them instead.",
  parameters: Schema.Struct({
    text: ForkMemoryInputText,
    replaces: Schema.optionalKey(
      Schema.Array(ForkMemoryNoteId)
        .check(Schema.isMaxLength(20))
        .annotate({ description: "Note ids from `project_memory_search` this note supersedes." }),
    ),
  }),
  success: Schema.Struct({ id: ForkMemoryNoteId, inclusion: ForkMemoryInclusion }),
})
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const ProjectMemoryToolkit = Toolkit.make(ProjectMemorySearchTool, ProjectMemorySaveTool);
