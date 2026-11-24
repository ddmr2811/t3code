import { type ForkBot, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { coordinatorRoutineInput, validateBotDraft } from "./bots.logic.ts";

describe("bots.logic", () => {
  it("rejects an invalid handle", () => {
    expect(
      validateBotDraft({
        handle: "Bad",
        name: "Bot",
        role: "Tester",
        instructions: "Do things",
        projectId: "proj-1",
        runtimeMode: "approval-required",
        instanceId: "codex",
        model: "gpt-5.4",
        coordinator: false,
      }).ok,
    ).toBe(false);
  });

  it("accepts a valid draft", () => {
    const result = validateBotDraft({
      handle: "tester",
      name: "Bot",
      role: "Tester",
      instructions: "Do things",
      projectId: "proj-1",
      runtimeMode: "approval-required",
      instanceId: "codex",
      model: "gpt-5.4",
      coordinator: false,
    });
    expect(result.ok).toBe(true);
  });

  it("runs every coordinator routine in the coordinator's own thread, with its model and mode", () => {
    const bot: ForkBot = {
      id: "bot:coord",
      handle: "coord",
      name: "Coordinador",
      role: "Coordina",
      instructions: "",
      projectId: ProjectId.make("proj-1"),
      threadId: ThreadId.make("thread-coord"),
      runtimeMode: "auto",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      archived: false,
      coordinator: true,
      memoryHash: null,
      createdAt: "2026-11-24T00:00:00.000Z",
      updatedAt: "2026-11-24T00:00:00.000Z",
    };
    const thread = ThreadId.make("thread-coord");
    const nightly = coordinatorRoutineInput(bot, thread, { kind: "nightly" });
    const daily = coordinatorRoutineInput(bot, thread, {
      kind: "daily",
      title: " Parte ",
      prompt: " Resume el día ",
      timeOfDay: "08:30",
    });
    const webhook = coordinatorRoutineInput(bot, thread, {
      kind: "webhook",
      title: "CI",
      prompt: "Mira el fallo",
    });
    for (const input of [nightly, daily, webhook]) {
      expect(input).toMatchObject({
        projectId: bot.projectId,
        threadId: thread,
        threadMode: "continue",
        modelSelection: bot.modelSelection,
        runtimeMode: "auto",
        enabled: true,
      });
    }
    expect(nightly.schedule).toEqual({ type: "fixed_time", timeOfDay: "03:00" });
    expect(daily).toMatchObject({
      title: "Parte",
      prompt: "Resume el día",
      schedule: { type: "fixed_time", timeOfDay: "08:30" },
    });
    expect(webhook.schedule).toEqual({ type: "webhook" });
  });
});
