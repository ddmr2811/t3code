import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  UsageLimitSourceId,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  appendLimitSamples,
  EMPTY_LIMIT_HISTORY,
  LIMIT_HISTORY_RETENTION_MS,
  LIMIT_SAMPLE_INTERVAL_MS,
  type LimitSample,
  limitHistorySince,
  limitSamples,
  MAX_POINTS_PER_WINDOW,
  MAX_SERIES,
} from "./limitHistory.ts";

const now = Date.parse("2026-11-16T12:00:00.000Z");
const minutes = (count: number) => count * 60_000;

function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", email: "dev@example.com" },
    checkedAt: "2026-11-16T11:59:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

const weekly = (usedPercent: number) => ({
  id: "secondary",
  kind: "weekly" as const,
  label: "Weekly",
  usedPercent,
});

const sample = (key: string, usedPercent: number): LimitSample => ({
  key,
  driver: "codex",
  email: null,
  credentialFingerprint: null,
  workspaceId: null,
  windows: [weekly(usedPercent)],
});

describe("limitSamples", () => {
  it("reads enabled logins and hub accounts, never a failed or stale reading", () => {
    const fresh = { checkedAt: "2026-11-16T11:58:00.000Z", windows: [weekly(40)] };
    const source: UsageLimitSourceSnapshot = {
      id: UsageLimitSourceId.make("hub"),
      kind: "cliproxy",
      label: "Hub",
      checkedAt: "2026-11-16T11:58:00.000Z",
      accounts: [
        { id: "a.json", driver: ProviderDriverKind.make("codex"), usageLimits: fresh },
        {
          id: "b.json",
          driver: ProviderDriverKind.make("codex"),
          usageLimits: { ...fresh, checkedAt: "2026-11-16T09:00:00.000Z" },
        },
      ],
    };
    const samples = limitSamples(
      [
        provider({ usageLimits: fresh }),
        provider({
          instanceId: ProviderInstanceId.make("off"),
          enabled: false,
          usageLimits: fresh,
        }),
        provider({
          instanceId: ProviderInstanceId.make("failed"),
          usageLimits: { ...fresh, unavailable: { reason: "probeFailed" } },
        }),
      ],
      [source],
      now,
    );
    expect(samples.map((entry) => entry.key)).toEqual(["native:codex", "hub:hub:a.json"]);
    expect(samples[0]).toMatchObject({ email: "dev@example.com", windows: [weekly(40)] });
  });
});

describe("appendLimitSamples", () => {
  it("starts collecting with the first sample and keeps a flat stretch as two points", () => {
    let history = appendLimitSamples(EMPTY_LIMIT_HISTORY, [], now);
    expect(history.collectingSince).toBeNull();
    for (const [step, used] of [10, 10, 10, 10, 25].entries()) {
      history = appendLimitSamples(
        history,
        [sample("native:codex", used)],
        now + step * LIMIT_SAMPLE_INTERVAL_MS,
      );
    }
    expect(history.collectingSince).toBe(now);
    expect(history.series[0]!.windows[0]!.points).toEqual([
      [now, 10],
      [now + 3 * LIMIT_SAMPLE_INTERVAL_MS, 10],
      [now + 4 * LIMIT_SAMPLE_INTERVAL_MS, 25],
    ]);
  });

  it("keeps a gap: samples after a long pause are not folded into the stretch before", () => {
    let history = EMPTY_LIMIT_HISTORY;
    for (const at of [0, 5, 10, 60]) {
      history = appendLimitSamples(history, [sample("native:codex", 10)], now + minutes(at));
    }
    expect(history.series[0]!.windows[0]!.points.map((point) => point[0])).toEqual([
      now,
      now + minutes(10),
      now + minutes(60),
    ]);
  });

  it("clamps and rounds readings, including absurd ones", () => {
    const history = appendLimitSamples(
      EMPTY_LIMIT_HISTORY,
      [sample("a", 1e9), sample("b", -3), sample("c", 33.333)],
      now,
    );
    expect(history.series.map((series) => series.windows[0]!.points[0]![1])).toEqual([
      100, 0, 33.3,
    ]);
  });

  it("drops what is older than a week and caps the points of a window", () => {
    let history = appendLimitSamples(EMPTY_LIMIT_HISTORY, [sample("old", 5)], now);
    const later = now + LIMIT_HISTORY_RETENTION_MS + 1;
    history = appendLimitSamples(history, [sample("new", 5)], later);
    expect(history.series.map((series) => series.key)).toEqual(["new"]);
    expect(history.collectingSince).toBe(now);

    let busy = EMPTY_LIMIT_HISTORY;
    for (let step = 0; step < MAX_POINTS_PER_WINDOW + 50; step += 1) {
      busy = appendLimitSamples(busy, [sample("busy", step % 2)], now + step * 60_000);
    }
    const points = busy.series[0]!.windows[0]!.points;
    expect(points).toHaveLength(MAX_POINTS_PER_WINDOW);
    expect(points.at(-1)![0]).toBe(now + (MAX_POINTS_PER_WINDOW + 49) * 60_000);
  });

  it("keeps the most recently read accounts when there are too many", () => {
    let history = EMPTY_LIMIT_HISTORY;
    for (let index = 0; index < MAX_SERIES + 3; index += 1) {
      history = appendLimitSamples(history, [sample(`account-${index}`, 1)], now + index);
    }
    expect(history.series).toHaveLength(MAX_SERIES);
    expect(history.series.some((series) => series.key === "account-0")).toBe(false);
    expect(history.series[0]!.key).toBe(`account-${MAX_SERIES + 2}`);
  });
});

describe("limitHistorySince", () => {
  it("answers the last hours with the point before them as the line's start", () => {
    let history = EMPTY_LIMIT_HISTORY;
    for (const [at, used] of [
      [0, 1],
      [10, 2],
      [20, 3],
      [30, 4],
    ] as const) {
      history = appendLimitSamples(history, [sample("native:codex", used)], now + minutes(at));
    }
    const answer = limitHistorySince(history, now + minutes(15));
    expect(answer.series[0]!.windows[0]!.points).toEqual([
      [now + minutes(10), 2],
      [now + minutes(20), 3],
      [now + minutes(30), 4],
    ]);
    expect(answer.sampleIntervalMs).toBe(LIMIT_SAMPLE_INTERVAL_MS);
  });
});
