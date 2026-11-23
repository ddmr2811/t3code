import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { acceptImages, effortBars, providerChoices, turnSettings } from "./composer.logic.ts";

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
