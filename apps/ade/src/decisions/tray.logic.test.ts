import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  advancePendingNotificationState,
  buildPendingNotificationEvent,
  buildPendingTrayItems,
  classifyPendingKinds,
  countPendingByKind,
  filterPendingItems,
  isSnoozed,
  isTrayOpenForViewport,
  readSnoozed,
  reconcileTrayChoice,
  snoozeUntilTomorrow,
  writeSnoozed,
  type PendingSeenByEnvironment,
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

  it("tracks initial hydration per machine without firing false alerts for pre-existing items", () => {
    const label = (env: EnvironmentId) => (env === envA ? "Alfa" : "Beta");
    let seen: PendingSeenByEnvironment = new Map();

    // 1. Before any machine hydrates, empty render does not seal baselines.
    const step0 = advancePendingNotificationState(seen, {
      items: [],
      hydratedEnvironmentIds: new Set(),
    });
    expect(step0.newlyPending).toEqual([]);
    seen = step0.nextSeenByEnv;

    // 2. Machine A hydrates with a pre-existing pending approval -> no notification.
    const itemA1 = buildPendingTrayItems(
      [pendingThread("t1", envA, { hasPendingApprovals: true })],
      label,
    );
    const step1 = advancePendingNotificationState(seen, {
      items: itemA1,
      hydratedEnvironmentIds: new Set([envA]),
    });
    expect(step1.newlyPending).toEqual([]);
    seen = step1.nextSeenByEnv;

    // 3. Machine B hydrates later with a pre-existing pending question -> still no notification.
    const itemsAB = buildPendingTrayItems(
      [
        pendingThread("t1", envA, { hasPendingApprovals: true }),
        pendingThread("t2", envB, { hasPendingUserInput: true }),
      ],
      label,
    );
    const step2 = advancePendingNotificationState(seen, {
      items: itemsAB,
      hydratedEnvironmentIds: new Set([envA, envB]),
    });
    expect(step2.newlyPending).toEqual([]);
    seen = step2.nextSeenByEnv;

    // 4. A genuinely new question arrives on already-hydrated machine B -> notifies.
    const itemsAfter = buildPendingTrayItems(
      [
        pendingThread("t1", envA, { hasPendingApprovals: true }),
        pendingThread("t2", envB, { hasPendingUserInput: true }),
        pendingThread("t3", envB, { hasPendingUserInput: true }),
      ],
      label,
    );
    const step3 = advancePendingNotificationState(seen, {
      items: itemsAfter,
      hydratedEnvironmentIds: new Set([envA, envB]),
    });
    expect(step3.newlyPending.map((item) => item.thread.id)).toEqual(["t3"]);

    const event = buildPendingNotificationEvent(step3.newlyPending);
    expect(event).toMatchObject({
      count: 1,
      title: "Pregunta pendiente · Beta",
      body: "Hilo t3",
      threadKeys: [itemsAfter[2]!.key],
    });
    // 5. If machine B temporarily drops out of hydrated/operable set and returns with the same items,
    //    it re-seeds its baseline cleanly without firing duplicate alerts.
    const dropOut = advancePendingNotificationState(step3.nextSeenByEnv, {
      items: itemA1,
      hydratedEnvironmentIds: new Set([envA]),
    });
    expect(dropOut.newlyPending).toEqual([]);
    const recover = advancePendingNotificationState(dropOut.nextSeenByEnv, {
      items: itemsAfter,
      hydratedEnvironmentIds: new Set([envA, envB]),
    });
    expect(recover.newlyPending).toEqual([]);
  });

  it("never auto-opens the full-screen tray on narrow mobile viewports, including after emptying", () => {
    expect(isTrayOpenForViewport(null, ["env-a:t1"], true)).toBe(false);
    const opened = { open: true, seenKeys: ["env-a:t1"] };
    expect(isTrayOpenForViewport(opened, ["env-a:t1"], true)).toBe(true);
    expect(isTrayOpenForViewport(opened, [], true)).toBe(false);

    // Sequence open -> [] -> [t2]: reconciling when empty clears stale open:true so t2 stays non-blocking.
    const afterEmpty = reconcileTrayChoice(opened, [], true);
    expect(afterEmpty).toBeNull();
    expect(isTrayOpenForViewport(afterEmpty, ["env-a:t2"], true)).toBe(false);

    // Desktop keeps auto-opening behavior unchanged.
    expect(reconcileTrayChoice(opened, [], false)).toBe(opened);
    expect(isTrayOpenForViewport(null, ["env-a:t1"], false)).toBe(true);
  });

  it("brings a «Luego» back tomorrow at 08:00, across a month end, and forgets it once due", () => {
    const local = (month: number, day: number, hours: number, minutes: number) =>
      DateTime.makeZonedUnsafe(
        { year: 2026, month, day, hour: hours, minute: minutes },
        { timeZone: DateTime.zoneMakeLocal(), adjustForTimeZone: true },
      );
    const until = snoozeUntilTomorrow(local(1, 31, 23, 30));
    expect(until).toBe(DateTime.toEpochMillis(local(2, 1, 8, 0)));
    const snoozed = { "env-a:t1": until };
    expect(isSnoozed(snoozed, "env-a:t1", until - 60_000)).toBe(true);
    expect(isSnoozed(snoozed, "env-a:t1", until)).toBe(false);

    const saved = new Map<string, string>();
    const storage = {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => void saved.set(key, value),
    };
    writeSnoozed({ ...snoozed, "env-a:old": until - 86_400_000 }, storage);
    expect(readSnoozed(until - 1, storage)).toEqual(snoozed);
    expect(readSnoozed(until, storage)).toEqual({});
  });
});
