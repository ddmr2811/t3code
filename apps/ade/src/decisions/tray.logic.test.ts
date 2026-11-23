import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildPendingNotificationEvent,
  buildPendingTrayItems,
  classifyPendingKinds,
  countPendingByKind,
  detectNewlyPending,
  filterPendingItems,
  type PendingThreadInput,
} from "./tray.logic.ts";

const envA = EnvironmentId.make("env-a");
const envB = EnvironmentId.make("env-b");

const pendingThread = (
  id: string,
  environmentId: EnvironmentId,
  overrides: Partial<PendingThreadInput> = {},
): PendingThreadInput => ({
  environmentId,
  id: ThreadId.make(id),
  projectId: ProjectId.make("proj-1"),
  title: `Hilo ${id}`,
  branch: "dev",
  worktreePath: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  pendingGuestMessageCount: 0,
  hasActionableProposedPlan: false,
  interactionMode: "default",
  updatedAt: "2026-11-23T10:00:00.000Z",
  ...overrides,
});

describe("tray.logic", () => {
  it("classifies, counts, and filters pending items across machines", () => {
    const items = buildPendingTrayItems(
      [
        pendingThread("t1", envA, { hasPendingApprovals: true }),
        pendingThread("t2", envB, { hasPendingUserInput: true }),
        pendingThread("t3", envA, {
          hasPendingApprovals: true,
          hasPendingUserInput: true,
        }),
        pendingThread("t4", envB, { interactionMode: "plan", hasActionableProposedPlan: true }),
      ],
      (env) => (env === envA ? "Alfa" : "Beta"),
    );

    expect(classifyPendingKinds(items[2]!.thread)).toEqual(["approval", "question"]);
    expect(countPendingByKind(items)).toEqual({
      all: 4,
      approval: 2,
      question: 2,
      plan: 1,
      guest: 0,
    });

    expect(
      filterPendingItems(items, { kind: "question", environmentId: "all" }).map(
        (item) => item.thread.id,
      ),
    ).toEqual(["t2", "t3"]);
    expect(
      filterPendingItems(items, { kind: "approval", environmentId: envA }).map(
        (item) => item.thread.id,
      ),
    ).toEqual(["t1", "t3"]);
    expect(
      filterPendingItems(items, { kind: "plan", environmentId: envA }).map(
        (item) => item.thread.id,
      ),
    ).toEqual([]);
  });

  it("emits notification payloads only for newly arrived items after initial hydration", () => {
    const items = buildPendingTrayItems(
      [
        pendingThread("t1", envA, { hasPendingApprovals: true }),
        pendingThread("t2", envB, { hasPendingUserInput: true }),
      ],
      (env) => (env === envA ? "Alfa" : "Beta"),
    );

    expect(detectNewlyPending(null, items)).toEqual([]);

    const arrived = detectNewlyPending(new Set([items[0]!.key]), items);
    expect(arrived.map((item) => item.thread.id)).toEqual(["t2"]);

    const event = buildPendingNotificationEvent(arrived);
    expect(event).toMatchObject({
      count: 1,
      title: "Pregunta pendiente · Beta",
      body: "Hilo t2",
      threadKeys: [items[1]!.key],
    });
  });
});
