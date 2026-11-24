import { describe, expect, it } from "vite-plus/test";
import { validateBotDraft } from "./bots.logic.ts";

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
    });
    expect(result.ok).toBe(true);
  });
});
