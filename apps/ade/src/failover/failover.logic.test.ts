import {
  DEFAULT_FORK_FAILOVER_CONFIG,
  type ForkFailoverConfig,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  availableMachineInstanceIds,
  availableMachineModelOptions,
  buildSafeChainId,
  findBackupCandidateForThread,
  formatFailoverTargetLabel,
  moveTargetInChain,
  validateFailoverConfigDraft,
} from "./failover.logic.ts";

const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");
const cursor = ProviderInstanceId.make("cursor");

const mockServerConfig: Pick<ServerConfig, "providers"> = {
  providers: [
    {
      instanceId: codex,
      driver: ProviderDriverKind.make("codex"),
      displayName: "Codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-11-24T00:00:00.000Z",
      models: [
        { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: null },
        { slug: "old-model", name: "Old", isCustom: false, isLegacy: true, capabilities: null },
      ],
      slashCommands: [],
      skills: [],
    },
    {
      instanceId: claude,
      driver: ProviderDriverKind.make("claudeAgent"),
      displayName: "Claude",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-11-24T00:00:00.000Z",
      models: [
        {
          slug: "claude-sonnet-4-6",
          name: "Claude Sonnet 4.6",
          isCustom: false,
          capabilities: null,
        },
      ],
      slashCommands: [],
      skills: [],
    },
    {
      instanceId: cursor,
      driver: ProviderDriverKind.make("cursor"),
      displayName: "Cursor",
      enabled: false,
      installed: true,
      version: "1.0.0",
      status: "disabled",
      auth: { status: "unauthenticated" },
      checkedAt: "2026-11-24T00:00:00.000Z",
      models: [{ slug: "composer-2", name: "Composer 2", isCustom: false, capabilities: null }],
      slashCommands: [],
      skills: [],
    },
  ],
};

describe("failover.logic", () => {
  it("lists only enabled, installed, non-legacy models for a machine", () => {
    const options = availableMachineModelOptions(mockServerConfig);
    expect(options).toEqual([
      { instanceId: codex, providerLabel: "Codex", model: "gpt-5.4", modelName: "GPT-5.4" },
      {
        instanceId: claude,
        providerLabel: "Claude",
        model: "claude-sonnet-4-6",
        modelName: "Claude Sonnet 4.6",
      },
    ]);
    expect(availableMachineInstanceIds(mockServerConfig)).toEqual(new Set([codex, claude]));
    expect(
      formatFailoverTargetLabel({ instanceId: claude, model: "claude-sonnet-4-6" }, options),
    ).toBe("Claude · Claude Sonnet 4.6");
  });

  it("picks the next eligible backup candidate for a thread skipping current and disabled instances", () => {
    const config: ForkFailoverConfig = {
      ...DEFAULT_FORK_FAILOVER_CONFIG,
      enabled: true,
      chains: [
        {
          id: "chain:main",
          name: "Principal",
          targets: [
            { instanceId: codex, model: "gpt-5.4" },
            { instanceId: cursor, model: "composer-2" },
            { instanceId: claude, model: "claude-sonnet-4-6" },
          ],
        },
      ],
    };
    const candidate = findBackupCandidateForThread(
      config,
      { instanceId: codex, model: "gpt-5.4" },
      availableMachineInstanceIds(mockServerConfig),
    );
    expect(candidate).toEqual({ instanceId: claude, model: "claude-sonnet-4-6" });
  });

  it("reorders chain targets and generates safe deduplicated chain IDs", () => {
    const reordered = moveTargetInChain(
      [
        { instanceId: codex, model: "gpt-5.4" },
        { instanceId: claude, model: "claude-sonnet-4-6" },
      ],
      1,
      -1,
    );
    expect(reordered.map((item) => item.instanceId)).toEqual([claude, codex]);
    expect(buildSafeChainId(new Set(["chain:principal"]), "Principal .. / 1")).toBe(
      "chain:principal-1",
    );
    expect(buildSafeChainId(new Set(["chain:principal"]), "Principal")).toBe("chain:principal-2");
  });

  it("validates failover drafts strictly against bounds, duplicates, and control characters", () => {
    expect(
      validateFailoverConfigDraft({
        enabled: true,
        cooldownSeconds: 10,
        maxSwitchesPerWindow: 2,
        chains: [],
      }),
    ).toMatchObject({ ok: false });

    expect(
      validateFailoverConfigDraft({
        enabled: true,
        cooldownSeconds: 300,
        maxSwitchesPerWindow: 9,
        chains: [],
      }),
    ).toMatchObject({ ok: false });

    expect(
      validateFailoverConfigDraft({
        enabled: true,
        cooldownSeconds: 300,
        maxSwitchesPerWindow: 2,
        chains: [
          {
            id: "chain:dup",
            name: "Duplicada",
            targets: [
              { instanceId: codex, model: "gpt-5.4" },
              { instanceId: codex, model: "gpt-5.4" },
            ],
          },
        ],
      }),
    ).toMatchObject({ ok: false });

    expect(
      validateFailoverConfigDraft({
        enabled: true,
        cooldownSeconds: 300,
        maxSwitchesPerWindow: 2,
        chains: [
          {
            id: "chain:bad",
            name: "Mal\u0007Nombre",
            targets: [{ instanceId: codex, model: "gpt-5.4" }],
          },
        ],
      }),
    ).toMatchObject({ ok: false });

    expect(
      validateFailoverConfigDraft({
        enabled: true,
        cooldownSeconds: 600,
        maxSwitchesPerWindow: 3,
        chains: [
          {
            id: "chain:ok",
            name: "  Respaldo principal  ",
            targets: [
              { instanceId: codex, model: "gpt-5.4" },
              { instanceId: claude, model: "claude-sonnet-4-6" },
            ],
          },
        ],
      }),
    ).toEqual({
      ok: true,
      config: {
        version: 1,
        enabled: true,
        cooldownSeconds: 600,
        maxSwitchesPerWindow: 3,
        chains: [
          {
            id: "chain:ok",
            name: "Respaldo principal",
            targets: [
              { instanceId: codex, model: "gpt-5.4" },
              { instanceId: claude, model: "claude-sonnet-4-6" },
            ],
          },
        ],
      },
    });
  });
});
