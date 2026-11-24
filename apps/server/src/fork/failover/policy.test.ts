import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_FORK_FAILOVER_CONFIG,
  type ForkFailoverConfig,
  type ForkFailoverEvent,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

import {
  type AvailableProviderCatalog,
  buildFailoverResumePrompt,
  isUsageLimitFailure,
  selectFailoverTarget,
  selectMatchingChain,
} from "./policy.ts";

const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");
const cursor = ProviderInstanceId.make("cursor");
const threadA = ThreadId.make("thread-a");

const allProvidersOpen = (ids: ReadonlyArray<ProviderInstanceId>): AvailableProviderCatalog =>
  new Map(ids.map((id) => [id, null]));

const baseConfig: ForkFailoverConfig = {
  ...DEFAULT_FORK_FAILOVER_CONFIG,
  enabled: true,
  cooldownSeconds: 600,
  maxSwitchesPerWindow: 2,
  chains: [
    {
      id: "default",
      name: "Default backup",
      targets: [
        { instanceId: claude, model: "claude-sonnet-4-6" },
        { instanceId: cursor, model: "composer-2" },
      ],
    },
    {
      id: "codex-any",
      name: "Codex instance fallback",
      matchInstanceId: codex,
      targets: [
        { instanceId: codex, model: "gpt-5.4-mini" },
        { instanceId: claude, model: "claude-sonnet-4-6" },
        { instanceId: cursor, model: "composer-2" },
      ],
    },
    {
      id: "codex-exact",
      name: "Codex exact fallback",
      matchInstanceId: codex,
      matchModel: "gpt-5.4",
      targets: [
        { instanceId: claude, model: "claude-opus-4-6" },
        { instanceId: cursor, model: "composer-2" },
      ],
    },
  ],
};

const nowMs = Date.parse("2026-11-24T12:00:00.000Z");

describe("failover policy", () => {
  it("treats only non-OOM usage_limit failures as eligible", () => {
    expect(isUsageLimitFailure({ class: "usage_limit", code: "rate_limit_exceeded" })).toBe(true);
    expect(isUsageLimitFailure({ class: "usage_limit", code: null })).toBe(true);
    expect(isUsageLimitFailure({ class: "usage_limit", code: "oom_kill" })).toBe(false);
    expect(isUsageLimitFailure({ class: "provider_error", code: "500" })).toBe(false);
    expect(isUsageLimitFailure({ class: "permission_error", code: "401" })).toBe(false);
    expect(isUsageLimitFailure({ class: "transport_error", code: "ECONNRESET" })).toBe(false);
    expect(isUsageLimitFailure({ class: "validation_error", code: null })).toBe(false);
    expect(isUsageLimitFailure({ class: "unknown", code: null })).toBe(false);
    expect(isUsageLimitFailure(null)).toBe(false);
    expect(isUsageLimitFailure(undefined)).toBe(false);
  });

  it("matches the most specific chain for (instanceId, model)", () => {
    expect(
      selectMatchingChain(baseConfig.chains, { instanceId: codex, model: "gpt-5.4" })?.id,
    ).toBe("codex-exact");
    expect(
      selectMatchingChain(baseConfig.chains, { instanceId: codex, model: "gpt-5.3" })?.id,
    ).toBe("codex-any");
    expect(selectMatchingChain(baseConfig.chains, { instanceId: cursor, model: "auto" })?.id).toBe(
      "default",
    );
  });

  it("skips disabled instances and models missing from a loaded catalog", () => {
    const decisionDisabled = selectFailoverTarget({
      config: baseConfig,
      trigger: "auto_usage_limit",
      failure: { class: "usage_limit", code: "429" },
      threadId: threadA,
      currentSelection: { instanceId: codex, model: "gpt-5.4" },
      availableProviders: allProvidersOpen([codex, cursor]),
      recentEvents: [],
      nowMs,
    });
    expect(decisionDisabled).toEqual({
      decision: "switch",
      target: { instanceId: cursor, model: "composer-2" },
      chainId: "codex-exact",
    });

    // Claude is available, but its loaded catalog does not contain `claude-opus-4-6`.
    const decisionMissingModel = selectFailoverTarget({
      config: baseConfig,
      trigger: "auto_usage_limit",
      failure: { class: "usage_limit", code: "429" },
      threadId: threadA,
      currentSelection: { instanceId: codex, model: "gpt-5.4" },
      availableProviders: new Map<ProviderInstanceId, ReadonlySet<string> | null>([
        [codex, new Set(["gpt-5.4"])],
        [claude, new Set(["claude-sonnet-4-6"])],
        [cursor, new Set(["composer-2"])],
      ]),
      recentEvents: [],
      nowMs,
    });
    expect(decisionMissingModel).toEqual({
      decision: "switch",
      target: { instanceId: cursor, model: "composer-2" },
      chainId: "codex-exact",
    });
  });

  it("blocks automatic failover when disabled or when failure is not usage_limit", () => {
    expect(
      selectFailoverTarget({
        config: { ...baseConfig, enabled: false },
        trigger: "auto_usage_limit",
        failure: { class: "usage_limit", code: "429" },
        threadId: threadA,
        currentSelection: { instanceId: codex, model: "gpt-5.4" },
        availableProviders: allProvidersOpen([codex, claude, cursor]),
        recentEvents: [],
        nowMs,
      }),
    ).toMatchObject({ decision: "skip", skipReason: "disabled" });

    expect(
      selectFailoverTarget({
        config: baseConfig,
        trigger: "auto_usage_limit",
        failure: { class: "permission_error", code: "401" },
        threadId: threadA,
        currentSelection: { instanceId: codex, model: "gpt-5.4" },
        availableProviders: allProvidersOpen([codex, claude, cursor]),
        recentEvents: [],
        nowMs,
      }),
    ).toMatchObject({ decision: "skip", skipReason: "not_usage_limit" });
  });

  it("prevents bouncing between two exhausted providers and enforces maxSwitchesPerWindow", () => {
    const twoWayConfig: ForkFailoverConfig = {
      ...DEFAULT_FORK_FAILOVER_CONFIG,
      enabled: true,
      cooldownSeconds: 600,
      maxSwitchesPerWindow: 2,
      chains: [
        {
          id: "shared",
          name: "Shared pool",
          targets: [
            { instanceId: codex, model: "gpt-5.4" },
            { instanceId: claude, model: "claude-sonnet-4-6" },
            { instanceId: cursor, model: "composer-2" },
          ],
        },
      ],
    };

    const firstSwitch: ForkFailoverEvent = {
      id: "failover:1",
      threadId: threadA,
      fromSelection: { instanceId: codex, model: "gpt-5.4" },
      toSelection: { instanceId: claude, model: "claude-sonnet-4-6" },
      reason: "usage_limit",
      resetAt: null,
      status: "switched",
      detail: "Switched to claudeAgent/claude-sonnet-4-6",
      occurredAt: "2026-11-24T11:58:00.000Z",
    };

    // Second quota hit on Claude must NOT bounce back to Codex; it advances to Cursor.
    const secondDecision = selectFailoverTarget({
      config: twoWayConfig,
      trigger: "auto_usage_limit",
      failure: { class: "usage_limit", code: "429" },
      threadId: threadA,
      currentSelection: { instanceId: claude, model: "claude-sonnet-4-6" },
      availableProviders: allProvidersOpen([codex, claude, cursor]),
      recentEvents: [firstSwitch],
      nowMs,
    });
    expect(secondDecision).toEqual({
      decision: "switch",
      target: { instanceId: cursor, model: "composer-2" },
      chainId: "shared",
    });

    const secondSwitch: ForkFailoverEvent = {
      id: "failover:2",
      threadId: threadA,
      fromSelection: { instanceId: claude, model: "claude-sonnet-4-6" },
      toSelection: { instanceId: cursor, model: "composer-2" },
      reason: "usage_limit",
      resetAt: null,
      status: "switched",
      detail: "Switched to cursor/composer-2",
      occurredAt: "2026-11-24T11:59:00.000Z",
    };

    // Third quota hit within cooldown hits the anti-loop cap.
    const blocked = selectFailoverTarget({
      config: twoWayConfig,
      trigger: "auto_usage_limit",
      failure: { class: "usage_limit", code: "429" },
      threadId: threadA,
      currentSelection: { instanceId: cursor, model: "composer-2" },
      availableProviders: allProvidersOpen([codex, claude, cursor]),
      recentEvents: [secondSwitch, firstSwitch],
      nowMs,
    });
    expect(blocked).toMatchObject({ decision: "skip", skipReason: "loop_guard" });

    // Once the cooldown window has elapsed, switching is allowed again.
    const afterCooldown = selectFailoverTarget({
      config: twoWayConfig,
      trigger: "auto_usage_limit",
      failure: { class: "usage_limit", code: "429" },
      threadId: threadA,
      currentSelection: { instanceId: cursor, model: "composer-2" },
      availableProviders: allProvidersOpen([codex, claude, cursor]),
      recentEvents: [secondSwitch, firstSwitch],
      nowMs: nowMs + 601_000,
    });
    expect(afterCooldown).toEqual({
      decision: "switch",
      target: { instanceId: codex, model: "gpt-5.4" },
      chainId: "shared",
    });
  });

  it("supports manual switches with explicit or rotated chain targets and rejects unknown models", () => {
    const manualExplicit = selectFailoverTarget({
      config: { ...baseConfig, enabled: false },
      trigger: "manual",
      threadId: threadA,
      currentSelection: { instanceId: codex, model: "gpt-5.4" },
      availableProviders: new Map<ProviderInstanceId, ReadonlySet<string> | null>([
        [codex, new Set(["gpt-5.4"])],
        [claude, new Set(["claude-sonnet-4-6"])],
      ]),
      recentEvents: [],
      nowMs,
      explicitTarget: { instanceId: claude, model: "claude-sonnet-4-6" },
    });
    expect(manualExplicit).toEqual({
      decision: "switch",
      target: { instanceId: claude, model: "claude-sonnet-4-6" },
      chainId: null,
    });

    const manualMissingModel = selectFailoverTarget({
      config: baseConfig,
      trigger: "manual",
      threadId: threadA,
      currentSelection: { instanceId: codex, model: "gpt-5.4" },
      availableProviders: new Map<ProviderInstanceId, ReadonlySet<string> | null>([
        [codex, new Set(["gpt-5.4"])],
        [claude, new Set(["claude-sonnet-4-6"])],
      ]),
      recentEvents: [],
      nowMs,
      explicitTarget: { instanceId: claude, model: "non-existent-model" },
    });
    expect(manualMissingModel).toMatchObject({
      decision: "skip",
      skipReason: "target_unavailable",
    });
  });

  it("builds concise same-provider and cross-provider handoff prompts", () => {
    expect(
      buildFailoverResumePrompt(
        { instanceId: codex, model: "gpt-5.4" },
        { instanceId: codex, model: "gpt-5.4-mini" },
      ),
    ).toContain("gpt-5.4");
    expect(
      buildFailoverResumePrompt(
        { instanceId: codex, model: "gpt-5.4" },
        { instanceId: claude, model: "claude-sonnet-4-6" },
      ),
    ).toContain("claudeAgent/claude-sonnet-4-6");
  });
});
