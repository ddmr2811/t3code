// Fork-only: the T3 threads' share of the activity feed, read from the projections. A summary is
// the thread's title and what happened; message text and run summaries are never selected.
import type { ForkActivityEntry } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { isoAt, RUN_OUTCOME_LABEL, runStatus, threadActor } from "./classify.ts";
import { summaryLine } from "./redact.ts";

export interface ThreadActivityRow {
  readonly id: string;
  readonly at: string;
  readonly status: string;
  readonly title: string;
  readonly projectTitle: string | null;
  readonly createdBy: string | null;
  readonly relationshipToParent: string | null;
  readonly delegated: number;
  readonly scheduled: number;
}

function threadEntry(row: ThreadActivityRow): ForkActivityEntry | null {
  const status = row.id.startsWith("request:") ? "waiting" : runStatus(row.status);
  const atMs = Date.parse(row.at);
  if (status === null || !Number.isFinite(atMs)) return null;
  const title = summaryLine(row.title, 120) || "Untitled thread";
  const project = row.projectTitle === null ? "" : summaryLine(row.projectTitle, 80);
  return {
    id: `thread:${row.id}`,
    at: isoAt(atMs),
    source: "thread",
    ...(project.length > 0 ? { project } : {}),
    actor: threadActor({
      createdBy: row.createdBy,
      relationshipToParent: row.relationshipToParent,
      delegated: Number(row.delegated) === 1,
      scheduled: Number(row.scheduled) === 1,
    }),
    summary: summaryLine(`${title}: ${RUN_OUTCOME_LABEL[status]}`),
    status,
  };
}

/**
 * Runs that ended or wait since `sinceIso`, and requests still waiting on an answer. Threads are
 * found through their project and update time, both indexed; a thread's update time moves with
 * every run, so no run outside it is missed.
 */
export const readThreadActivity = Effect.fn("ForkActivity.readThreadActivity")(function* (
  sinceIso: string,
  limit: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const origin = sql`
    t.title AS title,
    p.title AS "projectTitle",
    json_extract(t.payload_json, '$.createdBy') AS "createdBy",
    json_extract(t.payload_json, '$.lineage.relationshipToParent') AS "relationshipToParent",
    json_extract(t.payload_json, '$.delegatedFrom') IS NOT NULL AS delegated
  `;
  const runs = sql<ThreadActivityRow>`
    SELECT
      r.run_id AS id,
      coalesce(r.completed_at, json_extract(r.payload_json, '$.startedAt'), r.requested_at) AS at,
      r.status AS status,
      ${origin},
      EXISTS (
        SELECT 1 FROM orchestration_v2_projection_messages m
        WHERE m.message_id = json_extract(r.payload_json, '$.userMessageId')
          AND json_extract(m.payload_json, '$.scheduledTaskId') IS NOT NULL
      ) AS scheduled
    FROM orchestration_v2_projection_threads t
    JOIN projection_projects p ON p.project_id = t.project_id
    JOIN orchestration_v2_projection_runs r ON r.thread_id = t.thread_id
    WHERE t.project_id IN (SELECT project_id FROM projection_projects WHERE deleted_at IS NULL)
      AND t.updated_at >= ${sinceIso}
      AND t.deleted_at IS NULL
      AND r.status IN ('completed', 'failed', 'waiting')
      AND coalesce(r.completed_at, r.requested_at) >= ${sinceIso}
    ORDER BY at DESC
    LIMIT ${limit}
  `;
  const requests = sql<ThreadActivityRow>`
    SELECT
      'request:' || q.runtime_request_id AS id,
      q.created_at AS at,
      'waiting' AS status,
      ${origin},
      0 AS scheduled
    FROM orchestration_v2_projection_runtime_requests q
    JOIN orchestration_v2_projection_threads t ON t.thread_id = q.thread_id
    JOIN projection_projects p ON p.project_id = t.project_id
    WHERE q.status = 'pending' AND q.created_at >= ${sinceIso} AND t.deleted_at IS NULL
    ORDER BY q.created_at DESC
    LIMIT ${limit}
  `;
  const rows = yield* Effect.all([runs, requests]).pipe(
    NodeSqliteClient.readOnly,
    Effect.orElseSucceed((): ReadonlyArray<ReadonlyArray<ThreadActivityRow>> => []),
  );
  return rows.flat().flatMap((row) => {
    const entry = threadEntry(row);
    return entry === null ? [] : [entry];
  });
});

export interface ProjectRoot {
  readonly title: string;
  readonly workspaceRoot: string;
}

/** The projects whose repositories the feed reads `dev` commits from. */
export const readProjectRoots = Effect.fn("ForkActivity.readProjectRoots")(function* (
  limit: number,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<ProjectRoot>`
    SELECT title, workspace_root AS "workspaceRoot"
    FROM projection_projects
    WHERE deleted_at IS NULL AND archived_at IS NULL
    ORDER BY updated_at DESC
    LIMIT ${limit}
  `.pipe(
    NodeSqliteClient.readOnly,
    Effect.orElseSucceed((): ReadonlyArray<ProjectRoot> => []),
  );
});
