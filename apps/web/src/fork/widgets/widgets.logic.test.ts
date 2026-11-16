import type {
  ForkLimitHistory,
  ForkLimitHistorySeries,
  UsageProviderKind,
} from "@t3tools/contracts";
import { ProviderDriverKind } from "@t3tools/contracts";
import type { DailyTotals } from "@t3tools/shared/usageMerge";
import { describe, expect, it } from "vite-plus/test";

import {
  collectingSince,
  dotRows,
  heatGrid,
  heroFit,
  lastDays,
  monthDays,
  primaryWindow,
  providerLayers,
  remainingLine,
  seriesForAccount,
  spendByDay,
  stackLayers,
  sumActivity,
} from "./widgets.logic";

const codex = "codex" as UsageProviderKind;
const claude = "claude" as UsageProviderKind;

function daily(
  day: string,
  byProvider: ReadonlyArray<readonly [UsageProviderKind, number]>,
): DailyTotals {
  const map = new Map(
    byProvider.map(([provider, tokens]) => [
      provider,
      { costUsd: tokens / 1e6, totalTokens: tokens },
    ]),
  );
  const totalTokens = byProvider.reduce((sum, [, tokens]) => sum + tokens, 0);
  return { day, costUsd: totalTokens / 1e6, totalTokens, byProvider: map };
}

describe("days", () => {
  it("counts back across month and year ends", () => {
    expect(lastDays("2026-01-02", 4)).toEqual([
      "2025-12-30",
      "2025-12-31",
      "2026-01-01",
      "2026-01-02",
    ]);
    expect(monthDays("2026-11-03")).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"]);
    expect(lastDays("not a day", 3)).toEqual([]);
  });
});

describe("dotRows", () => {
  it("scales to the busiest value, keeps a tiny value visible and zero empty", () => {
    expect(dotRows([0, 1, 50, 100], 10)).toEqual([0, 1, 5, 10]);
  });

  it("draws nothing for all-zero, negative or broken values", () => {
    expect(dotRows([0, 0], 8)).toEqual([0, 0]);
    expect(dotRows([-5, Number.NaN, Number.POSITIVE_INFINITY], 8)).toEqual([0, 0, 0]);
    expect(dotRows([3], 0)).toEqual([0]);
  });

  it("never passes the top with enormous values", () => {
    expect(dotRows([1e15, 1, 5e14], 12)).toEqual([12, 1, 6]);
  });
});

describe("spendByDay", () => {
  it("fills the days with no spend and keeps the order asked for", () => {
    const days = lastDays("2026-11-16", 3);
    expect(spendByDay([daily("2026-11-16", [[codex, 2e6]])], days)).toEqual([
      { day: "2026-11-14", costUsd: 0, tokens: 0 },
      { day: "2026-11-15", costUsd: 0, tokens: 0 },
      { day: "2026-11-16", costUsd: 2, tokens: 2e6 },
    ]);
  });
});

describe("providerLayers", () => {
  it("stacks providers biggest first and leaves out the ones without tokens", () => {
    const days = lastDays("2026-11-03", 3);
    const layers = providerLayers(
      [
        daily("2026-11-01", [
          [codex, 10],
          [claude, 100],
        ]),
        daily("2026-11-03", [
          [codex, 5],
          [claude, 0],
        ]),
        daily("2026-10-31", [[codex, 1e9]]),
      ],
      days,
    );
    expect(layers.map((layer) => [layer.provider, layer.total])).toEqual([
      [claude, 100],
      [codex, 15],
    ]);
    expect(stackLayers(layers)).toEqual([
      [100, 0, 0],
      [110, 0, 5],
    ]);
  });
});

describe("primaryWindow", () => {
  it("follows the weekly window, then the session one", () => {
    const base = { label: "x", usedPercent: 1 };
    expect(
      primaryWindow([
        { ...base, id: "a", kind: "session" },
        { ...base, id: "b", kind: "weekly" },
      ])?.id,
    ).toBe("b");
    expect(primaryWindow([{ ...base, id: "a", kind: "session" }])?.id).toBe("a");
    expect(primaryWindow([])).toBeNull();
  });
});

const series = (overrides: Partial<ForkLimitHistorySeries>): ForkLimitHistorySeries => ({
  key: "native:codex",
  driver: "codex",
  email: null,
  credentialFingerprint: null,
  workspaceId: null,
  windows: [],
  ...overrides,
});

const history = (entries: ReadonlyArray<ForkLimitHistorySeries>, since: number | null = 1) =>
  ({
    collectingSince: since,
    sampleIntervalMs: 300_000,
    series: entries,
  }) satisfies ForkLimitHistory;

describe("seriesForAccount", () => {
  const account = {
    driver: ProviderDriverKind.make("codex"),
    email: "Dev@Example.com",
    key: "env-a:codex",
    limits: { checkedAt: "2026-11-16T12:00:00.000Z", windows: [] },
  };

  it("joins the same login read by several machines, by e-mail or credential", () => {
    const mine = seriesForAccount(account, [
      { environmentId: "env-a", history: history([series({ email: "dev@example.com" })]) },
      {
        environmentId: "env-b",
        history: history([
          series({ email: "dev@example.com", key: "hub:h:a" }),
          series({ email: "other@example.com" }),
          series({ driver: "claudeAgent", email: "dev@example.com" }),
        ]),
      },
    ]);
    expect(mine.map((entry) => entry.key)).toEqual(["native:codex", "hub:h:a"]);
    const byCredential = seriesForAccount(
      { ...account, email: undefined, limits: { ...account.limits, credentialFingerprint: "fp" } },
      [{ environmentId: "env-b", history: history([series({ credentialFingerprint: "fp" })]) }],
    );
    expect(byCredential).toHaveLength(1);
  });

  it("falls back to the provider instance the account came from", () => {
    const anonymous = { ...account, email: undefined };
    const found = seriesForAccount(anonymous, [
      { environmentId: "env-a", history: history([series({})]) },
      { environmentId: "env-b", history: history([series({})]) },
    ]);
    expect(found).toHaveLength(1);
  });
});

describe("remainingLine", () => {
  const hour = 60 * 60_000;
  it("merges servers by time within one window, starts at the edge and reads room left", () => {
    const line = remainingLine(
      [
        series({
          windows: [
            {
              id: "w",
              kind: "weekly",
              label: "Weekly",
              points: [
                [0, 10],
                [12 * hour, 40],
              ],
            },
          ],
        }),
        series({
          windows: [
            { id: "w", kind: "weekly", label: "Weekly", points: [[30 * hour, 60]] },
            { id: "s", kind: "session", label: "5h", points: [[20 * hour, 99]] },
            { id: "w-fable", kind: "weekly", label: "Weekly · Fable", points: [[20 * hour, 99]] },
          ],
        }),
      ],
      "w",
      6 * hour,
      30 * hour,
    );
    expect(line).toEqual([
      { x: 0, y: 0.9 },
      { x: 0.25, y: 0.6 },
      { x: 1, y: 0.4 },
    ]);
  });

  it("draws nothing without samples or with an empty range", () => {
    expect(remainingLine([], "w", 0, 10)).toEqual([]);
    expect(remainingLine([series({})], "w", 10, 10)).toEqual([]);
  });

  it("names the earliest machine collecting", () => {
    expect(collectingSince([history([], 50), history([], null), history([], 20)])).toBe(20);
    expect(collectingSince([history([], null)])).toBeNull();
  });
});

describe("activity", () => {
  it("adds up the turns of every machine per day", () => {
    const totals = sumActivity([
      { readAt: "", days: [{ day: "2026-11-15", turns: 2 }] },
      {
        readAt: "",
        days: [
          { day: "2026-11-15", turns: 3 },
          { day: "2026-11-16", turns: 1 },
        ],
      },
    ]);
    expect([...totals]).toEqual([
      ["2026-11-15", 5],
      ["2026-11-16", 1],
    ]);
  });

  it("lays the weeks out Monday first, ends at today and grades by the busiest day", () => {
    // 2026-11-16 is a Monday.
    const grid = heatGrid(
      new Map([
        ["2026-11-16", 8],
        ["2026-11-10", 1],
        ["2026-11-01", 4],
        ["2026-10-01", 99],
      ]),
      "2026-11-16",
      3,
    );
    expect(grid.weeks).toHaveLength(3);
    expect(grid.weeks[0]![0]!.day).toBe("2026-11-02");
    expect(grid.weeks[2]!.map((cell) => cell?.level ?? null)).toEqual([
      4,
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
    expect(grid.weeks[1]![1]).toEqual({ day: "2026-11-10", count: 1, level: 1 });
    expect(grid.total).toBe(9);
    expect(grid.months).toEqual([{ week: 0, label: "Nov" }]);
  });

  it("is empty for an empty or broken range and all-zero for no turns", () => {
    expect(heatGrid(new Map(), "nope", 4).weeks).toEqual([]);
    const quiet = heatGrid(new Map(), "2026-11-16", 1);
    expect(quiet.weeks[0]![0]).toEqual({ day: "2026-11-16", count: 0, level: 0 });
    expect(quiet.total).toBe(0);
  });
});

describe("heroFit", () => {
  const composerWidth = 736;
  it("uses two rows when they fit, else one wide row, else two cards, else none", () => {
    expect(heroFit({ below: 700, laneWidth: 2000, composerWidth })).toEqual({
      columns: 2,
      cards: 4,
      width: composerWidth,
    });
    expect(heroFit({ below: 420, laneWidth: 2000, composerWidth })).toEqual({
      columns: 4,
      cards: 4,
      width: 1440,
    });
    expect(heroFit({ below: 420, laneWidth: 1000, composerWidth })).toEqual({
      columns: 2,
      cards: 2,
      width: composerWidth,
    });
    expect(heroFit({ below: 200, laneWidth: 2000, composerWidth })).toBeNull();
  });
});
