import {
  type EnvironmentId,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthUsageReadScope,
  USAGE_CONTRACT_VERSION,
  type UsageBucket,
  type UsageDay,
  type UsageProviderKind,
} from "@t3tools/contracts";
import type { EnvironmentUsage } from "@t3tools/shared/usageMerge";
import * as DateTime from "effect/DateTime";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { binKey, gasto, trend } from "./gasto.logic.ts";
import {
  botEstimate,
  ratesByModel,
  rulerTicks,
  spendSummary,
  summaryIncomplete,
  weekWindow,
  widenScopes,
} from "./spend.logic.ts";

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
  providerReportedRecords: 0,
  sessions: 1,
  ...extra,
});

const machine = (
  buckets: UsageBucket[],
  id = "env-1",
  { hostId = id, status = "ok", readAt = "2026-11-25T10:00:00.000Z" } = {} as {
    hostId?: string;
    status?: "ok" | "partial" | "failed";
    readAt?: string;
  },
): EnvironmentUsage => ({
  environmentId: id as EnvironmentId,
  label: id,
  summary: {
    contractVersion: USAGE_CONTRACT_VERSION,
    readAt,
    timeZone: "Europe/Madrid",
    sinceDay: "2026-11-23" as UsageDay,
    untilDay: "2026-11-25" as UsageDay,
    buckets,
    sources: [...new Set(buckets.map((entry) => entry.provider))].map((provider) => ({
      fingerprint: { hostId, provider, resolvedHomePath: "/home/dev", volumeId: "1:1" },
      status,
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
  const reported = { costSource: "providerReported" } as const;
  const usage = [
    machine([bucket("claude", "claude-opus-5-5", "2026-11-25", 40)], "pc-subscription"),
    machine(
      [
        bucket("claude", "claude-opus-5-5", "2026-11-25", 5, reported),
        bucket("claude", "claude-opus-5-5", "2026-11-23", 2, reported),
        bucket("opencode", "kimi-k2", "2026-11-25", 1.5, {
          unpricedRecords: 1,
          unpricedTokens: 200,
        }),
        bucket("pi", "local-model", "2026-11-25", 0, {
          costSource: "unpriced",
          unpricedRecords: 2,
          unpricedTokens: 1000,
        }),
      ],
      "vps-api",
    ),
  ];
  const flat = new Map([["pc-subscription" as EnvironmentId, new Set(["claude" as const])]]);
  const { today, week } = spendSummary(usage, flat);
  const line = (provider: string, kind: string) =>
    today.lines.find((entry) => entry.provider === provider && entry.kind === kind);

  it("a subscription on one machine leaves another machine's API spend counted", () => {
    expect(line("claude", "flat")?.costUsd).toBe(0);
    expect(line("claude", "real")?.costUsd).toBe(5);
  });

  it("only reported money is real; tokens at list price are an estimate apart from it", () => {
    expect(today.realUsd).toBe(5);
    expect(today.estimatedUsd).toBe(1.5);
    expect(line("opencode", "estimated")?.costUsd).toBe(1.5);
  });

  it("keeps a line's tokens without a rate beside its amount, never as free", () => {
    expect(line("opencode", "estimated")?.unpricedTokens).toBe(200);
    expect(line("pi", "unpriced")?.unpricedTokens).toBe(1000);
  });

  it("counts today from the last day only, and the week from every day", () => {
    expect(week.realUsd).toBe(7);
  });
});

describe("spendSummary with what the server cannot split", () => {
  it("a priced group with reported records counts toward the cap, labelled as including estimates", () => {
    const mixed = machine([
      bucket("codex", "gpt-5", "2026-11-25", 6, { providerReportedRecords: 1 }),
    ]);
    const { today } = spendSummary([mixed], new Map());
    expect(today.realUsd).toBe(6);
    expect(today.mixedUsd).toBe(6);
    expect(today.estimatedUsd).toBe(0);
  });

  it("a reported charge stays real on a machine with a flat plan for that provider", () => {
    const usage = machine([
      bucket("opencode", "kimi-k2", "2026-11-25", 3, { costSource: "providerReported" }),
    ]);
    const flat = new Map([["env-1" as EnvironmentId, new Set(["opencode" as const])]]);
    expect(spendSummary([usage], flat).today.realUsd).toBe(3);
    // A $0 reported turn grouped with a list-price one is still the subscription, not a charge.
    const zeroReported = machine([
      bucket("claude", "sonnet", "2026-11-25", 3, { providerReportedRecords: 1 }),
    ]);
    const claudeFlat = new Map([["env-1" as EnvironmentId, new Set(["claude" as const])]]);
    expect(spendSummary([zeroReported], claudeFlat).today.realUsd).toBe(0);
  });

  it("keeps a reported charge that came with no tokens", () => {
    const usage = machine([
      bucket("cursor", "auto", "2026-11-25", 2, {
        costSource: "providerReported",
        totals: {
          uncachedInputTokens: 0,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
        },
      }),
    ]);
    expect(spendSummary([usage], new Map()).today.realUsd).toBe(2);
  });

  it("a group of reported and unpriced records only is not labelled as including estimates", () => {
    const usage = machine([
      bucket("codex", "gpt-5", "2026-11-25", 5, { providerReportedRecords: 1, unpricedRecords: 1 }),
    ]);
    const { today } = spendSummary([usage], new Map());
    expect([today.realUsd, today.mixedUsd]).toEqual([5, 0]);
  });

  it("a newer partial rescan of the same folder on another machine is not counted twice", () => {
    const cell = () => bucket("claude", "claude-opus-5-5", "2026-11-25", 4);
    const owner = machine([cell()], "pc", { hostId: "shared" });
    const rescan = machine([cell()], "wsl", {
      hostId: "shared",
      status: "partial",
      readAt: "2026-11-25T11:00:00.000Z",
    });
    const flat = new Map([["pc" as EnvironmentId, new Set(["claude" as const])]]);
    const { today } = spendSummary([owner, rescan], flat);
    expect(today.lines.reduce((sum, line) => sum + line.tokens, 0)).toBe(1000);
  });
});

it("summaryIncomplete flags a summary whose own sources failed or were read in part", () => {
  const read = (status: "ok" | "partial" | "failed") =>
    summaryIncomplete(machine([bucket("claude", "m", "2026-11-25", 1)], "a", { status }).summary);
  expect([read("ok"), read("partial"), read("failed")]).toEqual([false, true, true]);
});

describe("botEstimate", () => {
  const rates = ratesByModel([
    machine([
      bucket("claude", "claude-opus-5-5", "2026-11-25", 2),
      bucket("opencode", "claude-opus-5-5", "2026-11-25", 20),
    ]),
  ]);
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
        provider: "claude",
        day: "2026-11-25",
        timeZone: "Europe/Madrid",
        rates,
      }),
    ).toEqual({ usd: 1, unpricedTokens: 500 });
  });

  it("prices a model at its own provider's rate when two providers share its name", () => {
    const estimate = (provider: "claude" | "opencode") =>
      botEstimate({
        turns: [{ endedAtMs: Date.parse("2026-11-25T09:00:00Z"), turnTokenUsage: usage([]) }],
        fallbackModel: "claude-opus-5-5",
        provider,
        day: "2026-11-25",
        timeZone: "Europe/Madrid",
        rates,
      })?.usd;
    expect([estimate("claude"), estimate("opencode")]).toEqual([1, 10]);
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

describe("widenScopes", () => {
  const readOnly = { authenticated: true, permissions: [AuthOrchestrationReadScope] };
  const candidates = [
    AuthOrchestrationReadScope,
    AuthOrchestrationOperateScope,
    AuthUsageReadScope,
  ];

  it.each([
    [
      "asks for what the session holds plus usage:read, never more",
      AsyncResult.success(readOnly),
      [AuthOrchestrationReadScope, AuthUsageReadScope],
    ],
    // After another tab paired the machine again, the old session shows until it is read anew.
    [
      "asks for nothing while the session is read again",
      AsyncResult.success(readOnly, { waiting: true }),
      null,
    ],
  ])("%s", (_name, result, expected) => {
    expect(widenScopes(result, candidates)).toEqual(expected);
  });
});

describe("gasto", () => {
  const reported = { costSource: "providerReported" } as const;
  const usage = [
    machine(
      [
        bucket("claude", "claude-opus-5-5", "2026-11-25", 4),
        // The day before the 7 days up to 25 November: the previous period.
        bucket("claude", "claude-opus-5-5", "2026-11-18", 2),
        // Read for a longer range, but before the previous week: neither period counts it.
        bucket("claude", "claude-opus-5-5", "2026-11-11", 50),
      ],
      "pc",
    ),
    machine([bucket("codex", "gpt-6", "2026-11-20", 3, reported)], "vps"),
  ];

  it("takes the range and the period before it from a longer window, by model and account", () => {
    const week = gasto(usage, new Map(), "7d", "2026-11-25");
    expect(week.rows.map((row) => [row.model, row.account, row.kind, row.costUsd])).toEqual([
      ["claude-opus-5-5", "pc · Claude", "estimated", 4],
      ["gpt-6", "vps · Codex", "real", 3],
    ]);
    expect(week.current).toEqual({
      tokens: 2000,
      costUsd: 7,
      estimatedUsd: 4,
      mixedUsd: 0,
      priced: true,
      requests: 4,
    });
    expect(week.previous).toMatchObject({ tokens: 1000, costUsd: 2, requests: 2 });
    expect(week.bins.map((bin) => [bin.key, bin.tokens])).toEqual([
      ["2026-11-19", 0],
      ["2026-11-20", 1000],
      ["2026-11-21", 0],
      ["2026-11-22", 0],
      ["2026-11-23", 0],
      ["2026-11-24", 0],
      ["2026-11-25", 1000],
    ]);
  });

  it("counts a subscription's tokens but not its list price", () => {
    const flat = new Map([["pc" as EnvironmentId, new Set(["claude" as const])]]);
    const week = gasto(usage, flat, "7d", "2026-11-25");
    expect(week.current).toMatchObject({ tokens: 2000, costUsd: 3, estimatedUsd: 0 });
  });

  it("has no previous period for «Todo» and charts from the first day with usage", () => {
    const all = gasto(usage, new Map(), "all", "2026-11-25");
    expect(all.previous).toBeNull();
    expect(all.current.tokens).toBe(4000);
    expect(all.firstDay).toBe("2026-11-11");
    expect(all.bins).toHaveLength(15);
  });

  it.each([
    ["2026-11-25", "week", "2026-11-23"],
    ["2026-11-29", "week", "2026-11-23"],
    ["2026-11-23", "week", "2026-11-23"],
    ["2026-11-25", "month", "2026-11"],
  ] as const)("puts %s in the %s of %s", (day, unit, expected) => {
    expect(binKey(day, unit)).toBe(expected);
  });

  it.each([
    [7, 2, 2.5],
    [1, 2, -0.5],
    [5, 0, null],
    [5, null, null],
    // A figure the current period does not have is compared with nothing.
    [null, 2, null],
  ] as const)("trend of %s against %s is %s", (current, previous, expected) => {
    expect(trend(current, previous)).toBe(expected);
  });
});
