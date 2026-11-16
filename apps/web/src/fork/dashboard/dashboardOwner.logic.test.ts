import {
  DEFAULT_FORK_DASHBOARD_LAYOUT,
  type EnvironmentId,
  type ForkDashboardLayout,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type DashboardDraft,
  dashboardWriteTarget,
  needsLastRead,
  operationIsCurrent,
  type OwnerCandidate,
  ownerOptions,
  planDraft,
  planOwnerSwitch,
  resolveDashboardSource,
  reuseCandidates,
} from "./dashboardOwner.logic";

const PRIMARY = "env-pc" as EnvironmentId;
const SERVER = "env-cx53" as EnvironmentId;
const OLD = "env-old" as EnvironmentId;

const layout = (revision: number, alias: string | null = null): ForkDashboardLayout => ({
  ...DEFAULT_FORK_DASHBOARD_LAYOUT,
  revision,
  machines:
    alias === null
      ? []
      : [
          {
            ids: ["env:x"],
            name: "x",
            alias,
            icon: null,
            color: null,
            hidden: false,
            section: null,
          },
        ],
});

const candidate = (
  environmentId: EnvironmentId,
  overrides: Partial<OwnerCandidate> = {},
): OwnerCandidate => ({
  environmentId,
  label: environmentId,
  connected: true,
  protocol: 3,
  canWrite: true,
  layout: layout(4, environmentId),
  ...overrides,
});

const PRIMARY_LAYOUT = layout(9, "primary");
const CANDIDATES = [candidate(PRIMARY, { layout: PRIMARY_LAYOUT }), candidate(SERVER)];

const resolve = (
  owner: EnvironmentId | null,
  candidates: ReadonlyArray<OwnerCandidate> = CANDIDATES,
  lastRead: ForkDashboardLayout | null = null,
) =>
  resolveDashboardSource({
    owner,
    primaryId: PRIMARY,
    candidates,
    lastRead,
    primaryLayout: PRIMARY_LAYOUT,
  });

describe("resolveDashboardSource", () => {
  it("keeps the primary's layout when no owner is set or the owner is the primary", () => {
    expect(resolve(null)).toEqual({ kind: "primary", layout: PRIMARY_LAYOUT });
    expect(resolve(PRIMARY)).toEqual({ kind: "primary", layout: PRIMARY_LAYOUT });
  });

  it("reads a connected owner's own layout", () => {
    expect(resolve(SERVER)).toEqual({
      kind: "chosen",
      environmentId: SERVER,
      label: SERVER,
      layout: CANDIDATES[1]!.layout,
    });
  });

  it("shows the last read layout, read only, while the owner is offline", () => {
    const lastRead = layout(3, "cached");
    const offline = [CANDIDATES[0]!, candidate(SERVER, { connected: false })];
    expect(resolve(SERVER, offline, lastRead)).toEqual({
      kind: "unavailable",
      environmentId: SERVER,
      label: SERVER,
      layout: lastRead,
      notice: `${SERVER} is offline: showing the last saved layout`,
    });
  });

  it("falls back to the primary's layout when nothing was read, even for a forgotten owner", () => {
    const source = resolve(OLD);
    expect(source).toMatchObject({ kind: "unavailable", layout: PRIMARY_LAYOUT });
    expect(source.kind === "unavailable" && source.notice).toBe(
      "The chosen server is offline: showing the last saved layout",
    );
  });

  it("does not read an owner whose server cannot keep the Dashboard", () => {
    const lastRead = layout(3, "cached");
    const source = resolve(SERVER, [candidate(SERVER, { protocol: 2 })], lastRead);
    expect(source).toMatchObject({ kind: "unavailable", layout: lastRead });
  });
});

describe("dashboardWriteTarget", () => {
  it("writes only to the chosen environment, and nowhere while it cannot answer", () => {
    expect(dashboardWriteTarget(resolve(null), PRIMARY)).toBe(PRIMARY);
    expect(dashboardWriteTarget(resolve(SERVER), PRIMARY)).toBe(SERVER);
    const offline = [CANDIDATES[0]!, candidate(SERVER, { connected: false })];
    expect(dashboardWriteTarget(resolve(SERVER, offline, layout(1)), PRIMARY)).toBeNull();
    expect(dashboardWriteTarget(resolve(OLD), PRIMARY)).toBeNull();
    expect(
      dashboardWriteTarget(resolve(SERVER, [candidate(SERVER, { protocol: 2 })]), PRIMARY),
    ).toBeNull();
  });
});

describe("ownerOptions", () => {
  it("lists connected servers that keep the Dashboard and may be written, the primary first", () => {
    const options = ownerOptions({
      candidates: [
        candidate(SERVER),
        candidate(OLD, { protocol: 2 }),
        candidate("env-ro" as EnvironmentId, { canWrite: false }),
        candidate("env-down" as EnvironmentId, { connected: false }),
        candidate(PRIMARY),
      ],
      primaryId: PRIMARY,
      current: null,
    });
    expect(options.map((option) => [option.environmentId, option.disabled])).toEqual([
      [PRIMARY, false],
      [SERVER, false],
    ]);
  });

  it("keeps an offline or forgotten owner listed, disabled", () => {
    const offline = ownerOptions({
      candidates: [candidate(PRIMARY), candidate(SERVER, { connected: false })],
      primaryId: PRIMARY,
      current: SERVER,
    });
    expect(offline.map((option) => [option.environmentId, option.disabled])).toEqual([
      [PRIMARY, false],
      [SERVER, true],
    ]);
    const forgotten = ownerOptions({ candidates: [], primaryId: PRIMARY, current: OLD });
    expect(forgotten).toEqual([
      { environmentId: OLD, label: "The chosen server", primary: false, disabled: true },
    ]);
  });
});

describe("planOwnerSwitch", () => {
  const onScreen = layout(9, "mine");

  it("uses the target's layout without writing anything", () => {
    const target = CANDIDATES[1]!;
    expect(
      planOwnerSwitch({ choice: "use", target, primaryId: PRIMARY, layout: onScreen }),
    ).toEqual({ owner: SERVER, write: null, confirm: null, next: target.layout });
  });

  it("copies the layout on screen to the target alone, asking first when it has one", () => {
    const target = CANDIDATES[1]!;
    const plan = planOwnerSwitch({ choice: "copy", target, primaryId: PRIMARY, layout: onScreen });
    expect(plan?.owner).toBe(SERVER);
    expect(plan?.write).toEqual({ environmentId: SERVER, layout: onScreen, base: target.layout });
    expect(plan?.confirm).toContain(`Replace the dashboard saved on ${SERVER}?`);
    expect(plan?.next).toEqual({ ...onScreen, revision: 5 });
  });

  it("copies without asking when the target still has the default layout", () => {
    const target = candidate(SERVER, { layout: layout(0) });
    const plan = planOwnerSwitch({ choice: "copy", target, primaryId: PRIMARY, layout: onScreen });
    expect(plan?.confirm).toBeNull();
    expect(plan?.write?.environmentId).toBe(SERVER);
  });

  it("stores null when moving back to the primary", () => {
    const target = CANDIDATES[0]!;
    expect(
      planOwnerSwitch({ choice: "use", target, primaryId: PRIMARY, layout: onScreen })?.owner,
    ).toBeNull();
    expect(
      planOwnerSwitch({ choice: "copy", target, primaryId: PRIMARY, layout: onScreen })?.write
        ?.environmentId,
    ).toBe(PRIMARY);
  });

  it("refuses a target that cannot keep the Dashboard", () => {
    for (const target of [
      candidate(SERVER, { connected: false }),
      candidate(SERVER, { canWrite: false }),
      candidate(SERVER, { protocol: 2 }),
    ]) {
      expect(
        planOwnerSwitch({ choice: "copy", target, primaryId: PRIMARY, layout: onScreen }),
      ).toBeNull();
    }
  });
});

describe("needsLastRead", () => {
  it("reads the cache whenever the owner's own layout cannot be used", () => {
    const needs = (
      candidates: ReadonlyArray<OwnerCandidate>,
      owner: EnvironmentId | null = SERVER,
    ) => needsLastRead({ owner, primaryId: PRIMARY, candidates });
    expect(needs(CANDIDATES)).toBe(false);
    expect(needs([candidate(SERVER, { connected: false })])).toBe(true);
    expect(needs([candidate(SERVER, { protocol: 2 })])).toBe(true);
    expect(needs([candidate(SERVER, { layout: null })])).toBe(true);
    expect(needs([])).toBe(true);
    expect(needs([], null)).toBe(false);
    expect(needs([], PRIMARY)).toBe(false);
  });
});

describe("planDraft", () => {
  const opened = (overrides: Partial<DashboardDraft> = {}): DashboardDraft => {
    const base = layout(4, "a");
    return { layout: base, base, ownerId: PRIMARY, ownerLabel: "PC", ...overrides };
  };
  const onB = { ownerId: SERVER, label: "cx53", layout: layout(7, "b") };

  it("saves after the draft's own base while the owner holds", () => {
    const draft = opened({ layout: layout(4, "edited") });
    expect(planDraft(draft, { ...onB, ownerId: PRIMARY })).toEqual({
      kind: "save",
      base: draft.base,
    });
  });

  it("closes an untouched draft when the owner moves", () => {
    expect(planDraft(opened(), onB)).toEqual({ kind: "close" });
    // Edited back to what it was is untouched too.
    expect(planDraft(opened({ layout: layout(4, "a") }), onB)).toEqual({ kind: "close" });
  });

  it("never saves edits made for one owner on another unasked", () => {
    const plan = planDraft(opened({ layout: layout(4, "edited") }), onB);
    expect(plan).toEqual({
      kind: "moved",
      notice: "The dashboard is now saved on cx53; your edits were made for PC",
      copyLabel: "Copy my edits to cx53",
      copyConfirm: expect.stringContaining("Replace the dashboard saved on cx53?"),
      copyBase: onB.layout,
    });
    const onDefault = planDraft(opened({ layout: layout(4, "edited") }), {
      ...onB,
      layout: layout(0),
    });
    expect(onDefault.kind === "moved" && onDefault.copyConfirm).toBeNull();
  });
});

describe("operationIsCurrent", () => {
  it("drops an answer once another switch started or the owner moved", () => {
    const started = { id: 2, owner: null };
    expect(operationIsCurrent(started, { id: 2, owner: null })).toBe(true);
    expect(operationIsCurrent(started, { id: 3, owner: null })).toBe(false);
    expect(operationIsCurrent(started, { id: 2, owner: SERVER })).toBe(false);
  });
});

describe("reuseCandidates", () => {
  it("keeps the previous list until something a consumer reads changes", () => {
    const previous = [candidate(SERVER)];
    expect(reuseCandidates(previous, [{ ...previous[0]! }])).toBe(previous);
    const offline = [candidate(SERVER, { connected: false, layout: previous[0]!.layout })];
    expect(reuseCandidates(previous, offline)).toBe(offline);
  });
});
