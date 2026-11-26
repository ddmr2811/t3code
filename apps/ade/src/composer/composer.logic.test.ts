import {
  DEFAULT_SERVER_SETTINGS,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  acceptImages,
  defaultNewThreadSettings,
  effortBars,
  type MenuProject,
  menuProviders,
  providerChoices,
  turnSettings,
} from "./composer.logic.ts";

const project = ProjectId.make("project");
const provider = (id: string, extra: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: ProviderInstanceId.make(id),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [{ slug: "m", name: "M", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
  ...extra,
});

describe("providerChoices", () => {
  it("offers only providers the project can run", () => {
    const choices = providerChoices(
      {
        providers: [
          provider("codex"),
          provider("off-here"),
          provider("missing", { installed: false }),
          provider("down", { availability: "unavailable" }),
        ],
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          projectSettingsOverrides: {
            [project]: {
              providerInstances: { [ProviderInstanceId.make("off-here")]: { enabled: false } },
            },
          },
        },
      },
      project,
    );
    expect(choices.map((choice) => choice.instanceId)).toEqual(["codex"]);
  });

  it("counts the generic ACP driver, whose agents may refuse images, as without images", () => {
    const acpRegistry = ProviderDriverKind.make("acpRegistry");
    const choices = providerChoices(
      {
        providers: [provider("codex"), provider("devReplay", { driver: acpRegistry })],
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: { [ProviderInstanceId.make("devReplay")]: { driver: acpRegistry } },
        },
      },
      project,
    );
    expect(choices.map((choice) => [choice.instanceId, choice.takesImages])).toEqual([
      ["codex", true],
      ["devReplay", false],
    ]);
  });

  it("leaves out runtime modes above the managed policy's ceiling", () => {
    const [choice] = providerChoices(
      {
        providers: [provider("codex")],
        settings: DEFAULT_SERVER_SETTINGS,
        managedPolicy: { limits: { maxRuntimeMode: "auto-accept-edits" } } as never,
      },
      project,
    );
    expect(choice?.runtimeModes).toEqual(["approval-required", "auto-accept-edits"]);
  });
});

describe("turnSettings", () => {
  const thread = {
    model: { instanceId: ProviderInstanceId.make("codex"), model: "m" },
    runtimeMode: "full-access",
    interactionMode: "plan",
  } as const;
  const choice = (interactionModes: boolean) => ({
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    label: "Codex",
    accentColor: undefined,
    models: [{ slug: "m", name: "M", descriptors: [] }],
    runtimeModes: ["approval-required", "auto"] as const,
    interactionModes,
    takesImages: true,
  });

  it("never sends a mode the chosen provider does not offer", () => {
    expect(turnSettings({ text: "" }, thread, [choice(true)]).runtimeMode).toBe(
      "approval-required",
    );
    expect(
      turnSettings({ text: "", runtimeMode: "auto" }, thread, [choice(true)]).runtimeMode,
    ).toBe("auto");
  });

  it("keeps the thread's interaction mode where the provider shows no toggle", () => {
    const draft = { text: "", interactionMode: "default" } as const;
    expect(turnSettings(draft, thread, [choice(false)]).interactionMode).toBe("plan");
    expect(turnSettings(draft, thread, [choice(true)]).interactionMode).toBe("default");
  });
});

describe("acceptImages", () => {
  const file = (name: string, type: string, size = 1024) => ({ name, type, size });

  it("takes only what the turn contract accepts", () => {
    const { accepted, error } = acceptImages(
      [],
      [
        file("a.png", "image/png"),
        file("b.svg", "image/svg+xml"),
        file("c.webp", "image/webp", 10 * 1024 * 1024),
        file("d.jpg", "image/jpeg", 10 * 1024 * 1024 + 1),
        file("e.gif", "image/gif", 0),
      ],
    );
    expect(accepted.map((image) => image.name)).toEqual(["a.png", "c.webp"]);
    expect(error).toContain("b.svg");
    expect(error).toContain("d.jpg");
    expect(error).toContain("e.gif");
  });

  it("stops at the message's total image size", () => {
    // 80 MB in all: eight 10 MB images fit, a ninth does not.
    const ten = 10 * 1024 * 1024;
    const { accepted } = acceptImages(
      [],
      Array.from({ length: 9 }, (_, index) => file(`${index}.png`, "image/png", ten)),
    );
    expect(accepted).toHaveLength(8);
  });
});

describe("effortBars", () => {
  const select = (ids: ReadonlyArray<string>) => ({
    id: "effort",
    label: "Effort",
    type: "select" as const,
    options: ids.map((id) => ({ id, label: id })),
  });

  it("fills up to the current level, an off level filling none", () => {
    expect(effortBars(select(["low", "medium", "high"]), "medium")).toEqual({
      count: 3,
      filled: 2,
    });
    expect(effortBars(select(["off", "low", "high"]), "off")).toEqual({ count: 2, filled: 0 });
    // Max is named, not a bar: it fills them all.
    expect(effortBars(select(["low", "high", "max"]), "max")).toEqual({ count: 2, filled: 2 });
  });
});

describe("menuProviders", () => {
  const claude = (slugs: ReadonlyArray<string>, displayName?: string) => ({
    driver: ProviderDriverKind.make("claudeAgent"),
    ...(displayName === undefined ? {} : { displayName }),
    models: slugs.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
  });
  const enabled = { driver: ProviderDriverKind.make("claudeAgent"), enabled: true };
  const opencode = (models: ReadonlyArray<[slug: string, name: string]>) => ({
    driver: ProviderDriverKind.make("opencode"),
    models: models.map(([slug, name]) => ({ slug, name, isCustom: false, capabilities: null })),
  });
  const providers = providerChoices(
    {
      providers: [
        provider("codex"),
        provider(
          "claudeAgent",
          claude(["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-2"]),
        ),
        provider("claudeAgent_claudehxcks", claude(["claude-opus-5-5", "claude-haiku-5-5"])),
        // Recognised by the name shown, whatever its id.
        provider("claudeAgent_work", claude(["claude-opus-5-5"], "ClaudeHxcks")),
        provider(
          "opencode",
          opencode([
            ["opencode/big-pickle", "Big Pickle"],
            ["opencode/beam-free", "Beam Free"],
            ["opencode-go/beam-free", "Beam Free"],
            ["opencode/flint-40b", "Flint 40B"],
            ["opencode-go/pickle-2", "Big Pickle 2"],
            ["opencode/tidepool-alpha-free", "Tidepool Alpha Free"],
            ["opencode-go/iceman-contributor-free", "Iceman Contributor Free"],
            ["opencode/nemotron-3.5-lightning-free", "Nemotron 3.5 Lightning Free"],
            ["opencode/nemotron-3.5-pro", "Nemotron 3.5 Pro"],
            ["opencode/deepseek-v4.1-flash-free", "DeepSeek V4.1 Flash Free"],
            ["opencode-go/claude-haiku-5-5", "Claude Haiku 5.5"],
            ["opencode-go/claude-opus-5-5", "Claude Opus 5.5"],
            // Same name, another provider inside OpenCode: not a Zen/Go pair, so it stays.
            ["anthropic/claude-opus-5-5", "Claude Opus 5.5"],
            ["opencode/kimi-k3.1-pro", "Kimi K3.1 Pro"],
            ["opencode-go/kimi-k3.1-pro", "Kimi K3.1 Pro"],
          ]),
        ),
      ],
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [ProviderInstanceId.make("claudeAgent_claudehxcks")]: enabled,
          [ProviderInstanceId.make("claudeAgent_work")]: enabled,
          [ProviderInstanceId.make("opencode")]: {
            driver: ProviderDriverKind.make("opencode"),
            enabled: true,
          },
        },
      },
    },
    project,
  );
  const hxcksHaiku = {
    instanceId: ProviderInstanceId.make("claudeAgent_claudehxcks"),
    model: "claude-haiku-5-5",
  };
  const claudeSonnet = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-sonnet-5-5",
  };
  const elsewhere = { title: "T3 Code Fork", workspaceRoot: "/p/t3code-fork" };
  const inHxcks = { title: "proyecto", workspaceRoot: "/home/dani/proyectos/hxcks" };
  const shown = (where: MenuProject | null, kept: ReadonlyArray<ModelSelection> = []) =>
    menuProviders(providers, where, kept).map(
      (choice) => `${choice.instanceId}: ${choice.models.map((model) => model.slug).join(" ")}`,
    );

  it.each([
    {
      when: "outside Hxcks: Claude's Opus and Fable, no Hxcks account by id or by name",
      where: elsewhere,
      kept: [],
      expected: [
        "codex: m",
        "claudeAgent: claude-opus-5-5 claude-fable-5-2",
        "opencode: opencode-go/beam-free opencode/nemotron-3.5-pro opencode/deepseek-v4.1-flash-free opencode-go/claude-opus-5-5 anthropic/claude-opus-5-5 opencode-go/kimi-k3.1-pro",
      ],
    },
    {
      when: "in the Hxcks project: its account too",
      where: inHxcks,
      kept: [],
      expected: [
        "codex: m",
        "claudeAgent: claude-opus-5-5 claude-fable-5-2",
        "claudeAgent_claudehxcks: claude-opus-5-5",
        "claudeAgent_work: claude-opus-5-5",
        "opencode: opencode-go/beam-free opencode/nemotron-3.5-pro opencode/deepseek-v4.1-flash-free opencode-go/claude-opus-5-5 anthropic/claude-opus-5-5 opencode-go/kimi-k3.1-pro",
      ],
    },
    {
      when: "the thread's hidden model and the draft's hidden pick both stay",
      where: null,
      kept: [claudeSonnet, hxcksHaiku],
      expected: [
        "codex: m",
        "claudeAgent: claude-opus-5-5 claude-sonnet-5-5 claude-fable-5-2",
        "claudeAgent_claudehxcks: claude-haiku-5-5",
        "opencode: opencode-go/beam-free opencode/nemotron-3.5-pro opencode/deepseek-v4.1-flash-free opencode-go/claude-opus-5-5 anthropic/claude-opus-5-5 opencode-go/kimi-k3.1-pro",
      ],
    },
    {
      when: "OpenCode: a thread on a hidden free model, or on Zen's copy of a Go model, keeps it",
      where: elsewhere,
      kept: [
        { instanceId: ProviderInstanceId.make("opencode"), model: "opencode/big-pickle" },
        { instanceId: ProviderInstanceId.make("opencode"), model: "opencode/beam-free" },
      ],
      expected: [
        "codex: m",
        "claudeAgent: claude-opus-5-5 claude-fable-5-2",
        "opencode: opencode/big-pickle opencode/beam-free opencode-go/beam-free opencode/nemotron-3.5-pro opencode/deepseek-v4.1-flash-free opencode-go/claude-opus-5-5 anthropic/claude-opus-5-5 opencode-go/kimi-k3.1-pro",
      ],
    },
  ])("$when", ({ where, kept, expected }) => {
    expect(shown(where, kept)).toEqual(expected);
  });

  it("starts a new thread on a model the menu offers, not a hidden default", () => {
    const settings = (defaultModelSelection: ModelSelection) =>
      defaultNewThreadSettings(
        { settings: { ...DEFAULT_SERVER_SETTINGS, defaultModelSelection } },
        project,
        providers,
        elsewhere,
      )?.model;
    expect(settings(claudeSonnet)).toEqual({
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus-5-5",
    });
    expect(settings(hxcksHaiku)).toEqual({
      instanceId: ProviderInstanceId.make("codex"),
      model: "m",
    });
    // A Zen or Go default survives the Zen/Go merge.
    for (const model of ["opencode/beam-free", "opencode-go/beam-free"]) {
      const opencodeDefault = { instanceId: ProviderInstanceId.make("opencode"), model };
      expect(settings(opencodeDefault)).toEqual(opencodeDefault);
    }
  });
});

describe("defaultNewThreadSettings", () => {
  it("uses project runtime mode and model defaults, falling back and clamping to allowed modes", () => {
    const codexId = ProviderInstanceId.make("codex");
    const claudeId = ProviderInstanceId.make("claudeAgent");
    const providers = providerChoices(
      {
        providers: [
          provider("codex", { supportedRuntimeModes: ["approval-required", "auto"] }),
          provider("claudeAgent", {
            models: [{ slug: "opus", name: "Opus", isCustom: false, capabilities: null }],
          }),
        ],
        settings: DEFAULT_SERVER_SETTINGS,
      },
      project,
    );

    const withProjectDefaults = defaultNewThreadSettings(
      {
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          defaultRuntimeMode: "full-access",
          projectSettingsOverrides: {
            [project]: {
              defaultRuntimeMode: "auto",
              defaultModelSelection: { instanceId: codexId, model: "m" },
            },
          },
        },
      },
      project,
      providers,
      null,
    );
    expect(withProjectDefaults).toEqual({
      model: { instanceId: codexId, model: "m" },
      runtimeMode: "auto",
      interactionMode: "default",
    });

    const clamped = defaultNewThreadSettings(
      {
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          defaultRuntimeMode: "full-access",
          defaultModelSelection: { instanceId: ProviderInstanceId.make("missing"), model: "x" },
        },
      },
      project,
      providers,
      null,
    );
    expect(clamped).toEqual({
      model: { instanceId: codexId, model: "m" },
      runtimeMode: "approval-required",
      interactionMode: "default",
    });

    const legacyProjectDefault = defaultNewThreadSettings(
      { settings: DEFAULT_SERVER_SETTINGS },
      project,
      providers,
      {
        title: "Proyecto",
        workspaceRoot: "/p/proyecto",
        defaultModelSelection: { instanceId: claudeId, model: "opus" },
      },
    );
    expect(legacyProjectDefault).toEqual({
      model: { instanceId: claudeId, model: "opus" },
      runtimeMode: DEFAULT_SERVER_SETTINGS.defaultRuntimeMode,
      interactionMode: "default",
    });
  });
});
