import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { providerChoices, turnSettings } from "./composer.logic.ts";

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
    label: "Codex",
    models: [{ slug: "m", name: "M" }],
    runtimeModes: ["approval-required", "auto"] as const,
    interactionModes,
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
