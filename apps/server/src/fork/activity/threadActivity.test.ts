import { describe, expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { readThreadActivity } from "./threadActivity.ts";

const SECRET_TEXT = "please deploy with password hunter2";
const RUN_SUMMARY = "I deployed it and pasted the logs";

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE projection_projects (
    project_id TEXT, title TEXT, workspace_root TEXT, updated_at TEXT, deleted_at TEXT,
    archived_at TEXT)`;
  yield* sql`CREATE TABLE orchestration_v2_projection_threads (
    thread_id TEXT, project_id TEXT, title TEXT, updated_at TEXT, deleted_at TEXT,
    payload_json TEXT)`;
  yield* sql`CREATE TABLE orchestration_v2_projection_runs (
    run_id TEXT, thread_id TEXT, status TEXT, requested_at TEXT, completed_at TEXT,
    payload_json TEXT)`;
  yield* sql`CREATE TABLE orchestration_v2_projection_messages (
    message_id TEXT, thread_id TEXT, payload_json TEXT, search_text TEXT)`;
  yield* sql`CREATE TABLE orchestration_v2_projection_runtime_requests (
    runtime_request_id TEXT, thread_id TEXT, status TEXT, created_at TEXT, payload_json TEXT)`;
  yield* sql`INSERT INTO projection_projects VALUES
    ('p1', 'T3 Code Fork', '/repo', '2026-11-17T00:00:00Z', NULL, NULL)`;
  const thread = (id: string, title: string, payload: object, deletedAt: string | null = null) =>
    sql`INSERT INTO orchestration_v2_projection_threads VALUES
      (${id}, 'p1', ${title}, '2026-11-17T05:00:00Z', ${deletedAt}, ${JSON.stringify(payload)})`;
  const run = (id: string, threadId: string, status: string, completedAt: string, messageId = "") =>
    sql`INSERT INTO orchestration_v2_projection_runs VALUES
      (${id}, ${threadId}, ${status}, '2026-11-17T03:00:00Z', ${completedAt},
       ${JSON.stringify({ userMessageId: messageId, summary: RUN_SUMMARY })})`;
  const message = (id: string, threadId: string, payload: object) =>
    sql`INSERT INTO orchestration_v2_projection_messages VALUES
      (${id}, ${threadId}, ${JSON.stringify({ text: SECRET_TEXT, ...payload })}, ${SECRET_TEXT})`;

  yield* thread("orchestrator", "Fork orchestrator", { createdBy: "agent", lineage: {} });
  yield* thread("worker", "Activity feed", {
    createdBy: "agent",
    lineage: { relationshipToParent: "subagent", parentThreadId: "orchestrator" },
  });
  yield* thread("delegated", "Remote review", {
    createdBy: "agent",
    lineage: {},
    delegatedFrom: { environmentId: "env-2" },
  });
  yield* thread("mine", "Ideas", { createdBy: "user", lineage: {} });
  yield* thread("nightly", "Nightly tests", { createdBy: "user", lineage: {} });
  yield* thread("gone", "Deleted", { createdBy: "user" }, "2026-11-17T05:00:00Z");

  yield* message("m-orch", "orchestrator", {});
  yield* message("m-night", "nightly", { scheduledTaskId: "task-1" });
  yield* run("r1", "orchestrator", "completed", "2026-11-17T04:00:00Z", "m-orch");
  yield* run("r2", "worker", "failed", "2026-11-17T04:10:00Z");
  yield* run("r3", "delegated", "completed", "2026-11-17T04:20:00Z");
  yield* run("r4", "mine", "running", "");
  yield* run("r5", "nightly", "completed", "2026-11-17T04:30:00Z", "m-night");
  yield* run("r6", "mine", "completed", "2026-11-15T04:30:00Z");
  yield* run("r7", "gone", "completed", "2026-11-17T04:40:00Z");
  yield* run("r8", "mine", "interrupted", "2026-11-17T04:45:00Z");
  yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests VALUES
    ('q1', 'mine', 'pending', '2026-11-17T04:50:00Z', ${JSON.stringify({ question: SECRET_TEXT })}),
    ('q2', 'mine', 'resolved', '2026-11-17T04:55:00Z', '{}')`;
});

describe("readThreadActivity", () => {
  it.effect("lists ended and waiting work by title and outcome, never message text", () =>
    Effect.gen(function* () {
      yield* setup;
      const entries = yield* readThreadActivity("2026-11-16T00:00:00.000Z", 50);
      const byId = new Map(entries.map((entry) => [entry.id, entry]));

      expect([...byId.keys()].toSorted()).toEqual([
        "thread:r1",
        "thread:r2",
        "thread:r3",
        "thread:r5",
        "thread:request:q1",
      ]);
      expect(byId.get("thread:r1")).toEqual({
        id: "thread:r1",
        at: "2026-11-17T04:00:00.000Z",
        source: "thread",
        project: "T3 Code Fork",
        actor: "orchestrator",
        summary: "Fork orchestrator: finished",
        status: "ok",
      });
      expect(byId.get("thread:r2")).toMatchObject({ actor: "worker", status: "error" });
      expect(byId.get("thread:r3")).toMatchObject({ actor: "worker", status: "ok" });
      expect(byId.get("thread:r5")).toMatchObject({
        actor: "timer",
        summary: "Nightly tests: finished",
      });
      expect(byId.get("thread:request:q1")).toMatchObject({
        actor: "user",
        status: "waiting",
        summary: "Ideas: waiting on you",
      });

      const wire = JSON.stringify(entries);
      expect(wire).not.toContain("hunter2");
      expect(wire).not.toContain("deploy");
      expect(wire).not.toContain(RUN_SUMMARY);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect(
    "keeps the oldest thread in the window past 500 newer ones, and says when it cuts",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* setup;
        yield* sql`INSERT INTO orchestration_v2_projection_threads
        WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 600)
        SELECT 'bulk-' || i, 'p1', 'Bulk ' || i, '2026-11-17T05:10:00Z', NULL,
               '{"createdBy":"agent"}'
        FROM n`;
        yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES
        ('oldest', 'p1', 'Oldest in window', '2026-11-16T00:30:00Z', NULL, '{"createdBy":"user"}')`;
        yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests VALUES
        ('q-old', 'oldest', 'pending', '2026-11-16T00:20:00Z', '{}')`;

        const entries = yield* readThreadActivity("2026-11-16T00:00:00.000Z", 50);
        expect(entries.find((entry) => entry.id === "thread:request:q-old")).toMatchObject({
          summary: "Oldest in window: waiting on you",
          status: "waiting",
        });
        expect(entries.some((entry) => entry.id === "thread:truncated")).toBe(false);

        const cut = yield* readThreadActivity("2026-11-16T00:00:00.000Z", 50, 100);
        expect(cut[0]).toMatchObject({ id: "thread:truncated", status: "error" });
        expect(cut[0]!.summary).toBe(
          "Activity truncated: more than 100 threads changed in this window",
        );
        expect(cut.some((entry) => entry.id === "thread:request:q-old")).toBe(false);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("answers nothing on a database without the projections", () =>
    Effect.gen(function* () {
      expect(yield* readThreadActivity("2026-11-16T00:00:00.000Z", 50)).toEqual([]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
