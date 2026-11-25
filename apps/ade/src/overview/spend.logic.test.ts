import {
  type EnvironmentId,
  USAGE_CONTRACT_VERSION,
  type UsageBucket,
  type UsageDay,
  type UsageProviderKind,
} from "@t3tools/contracts";
import type { EnvironmentUsage } from "@t3tools/shared/usageMerge";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { botEstimate, ratesByModel, rulerTicks, spendSummary, weekWindow } from "./spend.logic.ts";

const bucket = (
  provider: UsageProviderKind,
  model: string,
  day: string,
  costUsd: number,
  extra: Partial<UsageBucket> = {},
): UsageBucket => ({
  day: day as UsageDay,
  provider,
  model,
  totals: {
    uncachedInputTokens: 600,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 400,
    reasoningTokens: 0,
  },
  costUsd,
  cacheSavingsUsd: 0,
  costSource: "modelPriced",
  records: 2,
  unpricedRecords: 0,
  sessions: 1,
  ...extra,
});

const machine = (buckets: UsageBucket[]): EnvironmentUsage => ({
  environmentId: "env-1" as EnvironmentId,
  label: "dev",
  summary: {
    contractVersion: USAGE_CONTRACT_VERSION,
    readAt: "2026-11-25T10:00:00.000Z",
    timeZone: "Europe/Madrid",
    sinceDay: "2026-11-23" as UsageDay,
    untilDay: "2026-11-25" as UsageDay,
    buckets,
    sources: [...new Set(buckets.map((entry) => entry.provider))].map((provider) => ({
      fingerprint: { hostId: "dev", provider, resolvedHomePath: "/home/dev", volumeId: "1:1" },
      status: "ok" as const,
      scannedFiles: 1,
      skippedFiles: 0,
      malformedRecords: 0,
      distinctSessions: 1,
      message: null,
    })),
    pricing: { status: "fresh", source: "litellm", fetchedAt: null, knownModels: 1 },
    scanDurationMs: 1,
  },
});

describe("spendSummary", () => {
  const usage = [
    machine([
      bucket("opencode", "kimi-k2", "2026-11-25", 1.5),
      bucket("opencode", "kimi-k2", "2026-11-23", 2),
      bucket("claude", "claude-opus-5-5", "2026-11-25", 40),
      bucket("pi", "local-model", "2026-11-25", 0, {
        costSource: "unpriced",
        unpricedRecords: 2,
        unpricedTokens: 1000,
      }),
    ]),
  ];
  const { today, week } = spendSummary(usage, new Set(["claude"]));

  it("adds only pay-per-use money: a flat subscription and an unpriced model never count", () => {
    expect(today.realUsd).toBe(1.5);
    expect(today.lines.map((line) => [line.model, line.kind, line.costUsd, line.tokens])).toEqual([
      ["kimi-k2", "real", 1.5, 1000],
      ["claude-opus-5-5", "flat", 0, 1000],
      ["local-model", "unpriced", 0, 1000],
    ]);
  });

  it("counts today from the last day only, and the week from every day", () => {
    expect(week.realUsd).toBe(3.5);
  });
});

describe("botEstimate", () => {
  const rates = ratesByModel([machine([bucket("claude", "claude-opus-5-5", "2026-11-25", 2)])]);
  const usage = (models: string[]) =>
    ({
      usageScope: "main_agent",
      usageStatus: "complete",
      hasSubagents: false,
      inputTokens: 300,
      outputTokens: 200,
      models,
    }) as const;

  it("prices today's turns in the user's zone and keeps tokens without a rate apart", () => {
    expect(
      botEstimate({
        turns: [
          // 23:30 on the 24th in Madrid: yesterday. The next one is 00:30 on the 25th there.
          { endedAtMs: Date.parse("2026-11-24T22:30:00Z"), turnTokenUsage: usage([]) },
          { endedAtMs: Date.parse("2026-11-24T23:30:00Z"), turnTokenUsage: usage(["mystery"]) },
          { endedAtMs: Date.parse("2026-11-25T09:00:00Z"), turnTokenUsage: usage([]) },
        ],
        fallbackModel: "claude-opus-5-5",
        day: "2026-11-25",
        timeZone: "Europe/Madrid",
        rates,
      }),
    ).toEqual({ usd: 1, unpricedTokens: 500 });
  });
});

it("weekWindow starts on Monday, also when today is Sunday", () => {
  expect(weekWindow(DateTime.toDateUtc(DateTime.makeUnsafe("2026-11-29T12:00:00Z"))).sinceDay).toBe(
    "2026-11-23",
  );
  expect(weekWindow(DateTime.toDateUtc(DateTime.makeUnsafe("2026-11-23T12:00:00Z"))).sinceDay).toBe(
    "2026-11-23",
  );
});

it("rulerTicks fills the marks up to the value, inclusive, and none when nothing was spent", () => {
  const filled = (value: number) => rulerTicks(value, 50).filter((tick) => tick.filled).length;
  expect(filled(32)).toBe(17);
  expect(filled(0)).toBe(0);
  expect(filled(80)).toBe(26);
});
