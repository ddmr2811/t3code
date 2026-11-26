// The real workflow engine on a fresh database, for fork tests that put the bots behind it.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import WorkflowsMigration from "../../persistence/Migrations/110_Workflows.ts";
import WorkflowSkippedRunsMigration from "../../persistence/Migrations/113_WorkflowSkippedRuns.ts";
import WorkflowRunTagsMigration from "../../persistence/Migrations/115_WorkflowRunTags.ts";
import WorkflowMailSenderMigration from "../../persistence/Migrations/117_WorkflowMailSender.ts";
import WorkflowPoolsMigration from "../../persistence/Migrations/118_WorkflowPools.ts";
import WorkflowRunSubjectMigration from "../../persistence/Migrations/119_WorkflowRunSubject.ts";
import type { WorkflowDefinition } from "../../workflows/workflow.ts";
import { WorkflowAgents } from "../../workflows/WorkflowAgents.ts";
import * as WorkflowEngine from "../../workflows/WorkflowEngine.ts";
import { unavailable, WorkflowForge } from "../../workflows/WorkflowForge.ts";
import type * as Workflows from "../../workflows/Workflows.ts";
import * as ForkWorkflowAgents from "./ForkWorkflowAgents.ts";
import { type ForkWorkflowHooks, ForkWorkflowLink } from "./ForkWorkflowLink.ts";

/**
 * `use` runs against an engine holding `definitions`, with the fork's agent steps in front of
 * `agents` (upstream's threads, which a test stands in for) and `hooks` behind the link, or
 * none, as before the fork's services are up.
 */
export const withWorkflowEngine = <A, E>(
  definitions: ReadonlyArray<WorkflowDefinition>,
  hooks: ForkWorkflowHooks | undefined,
  agents: WorkflowAgents["Service"],
  use: Effect.Effect<A, E, Workflows.Workflows>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fork-workflows-" });
    const database = NodeSqliteClient.layer({ filename: path.join(directory, "state.sqlite") });
    yield* Effect.provide(
      Effect.all(
        [
          WorkflowsMigration,
          WorkflowSkippedRunsMigration,
          WorkflowRunTagsMigration,
          WorkflowMailSenderMigration,
          WorkflowPoolsMigration,
          WorkflowRunSubjectMigration,
        ],
        { discard: true },
      ),
      database,
    );
    return yield* Effect.provide(
      use,
      WorkflowEngine.layer(definitions).pipe(
        Layer.provide(ForkWorkflowAgents.layer),
        Layer.provide(Layer.succeed(WorkflowAgents, agents)),
        Layer.provide(Layer.succeed(WorkflowForge, unavailable)),
        Layer.provide(Layer.succeed(ForkWorkflowLink, { current: hooks })),
        Layer.provide(database),
        Layer.provide(NodeCrypto.layer),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
