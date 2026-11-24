import {
  DEFAULT_FORK_FAILOVER_CONFIG,
  DEFAULT_SERVER_SETTINGS,
  type ForkFailoverConfig,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  availableMachineModelOptions,
  availableMachineProviderCatalog,
  buildSafeChainId,
  findBackupCandidateForThread,
  formatFailoverTargetLabel,
  moveTargetInChain,
  validateFailoverConfigDraft,
} from "./failover.logic.ts";

const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");
const cursor = ProviderInstanceId.make("cursor");
const grok = ProviderInstanceId.make("grok");
const projectA = ProjectId.make("proj-a");

const mockServerConfig: Pick<ServerConfig, "providers" | "settings"> = {
  settings: {
    ...DEFAULT_SERVER_SETTINGS,
    projectSettingsOverrides: {
      [projectA]: {
        providerInstances: {
          [claude]: { enabled: false },
        },
      },
    },
  },
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
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "unauthenticated" },
      checkedAt: "2026-11-24T00:00:00.000Z",
      models: [{ slug: "composer-2", name: "Composer 2", isCustom: false, capabilities: null }],
      slashCommands: [],
      skills: [],
    },
    {
      instanceId: grok,
      driver: ProviderDriverKind.make("grok"),
      displayName: "Grok",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "error",
      auth: { status: "authenticated" },
      checkedAt: "2026-11-24T00:00:00.000Z",
      models: [{ slug: "grok-build", name: "Grok Build", isCustom: false, capabilities: null }],
      slashCommands: [],
      skills: [],
    },
  ],
};

describe("failover.logic", () => {
  it("lists only enabled, authenticated, non-error, non-legacy models for a machine", () => {
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
    const catalog = availableMachineProviderCatalog(mockServerConfig);
    expect([...catalog.keys()]).toEqual([codex, claude]);
    expect(
      formatFailoverTargetLabel({ instanceId: claude, model: "claude-sonnet-4-6" }, options),
    ).toBe("Claude · Claude Sonnet 4.6");
  });

  it("skips unauthenticated, error, project-disabled providers and unknown model slugs", () => {
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
            { instanceId: grok, model: "grok-build" },
            { instanceId: claude, model: "unknown-model" },
            { instanceId: claude, model: "claude-sonnet-4-6" },
          ],
        },
      ],
    };

    // Without project override, skips unauthenticated cursor, error grok, and unknown claude slug.
    expect(
      findBackupCandidateForThread(
        config,
        { instanceId: codex, model: "gpt-5.4" },
        availableMachineProviderCatalog(mockServerConfig),
      ),
    ).toEqual({ instanceId: claude, model: "claude-sonnet-4-6" });

    // With projectA override disabling claude, no backup candidate remains.
    expect(
      findBackupCandidateForThread(
        config,
        { instanceId: codex, model: "gpt-5.4" },
        availableMachineProviderCatalog(mockServerConfig, projectA),
      ),
    ).toBeNull();
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
