import { describe, expect, it } from "vite-plus/test";
import { stripForkBotInitialMessage, validateBotDraft } from "./bots.logic.ts";

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
        instanceId: "codex" as never,
        model: "gpt-5.4",
        fallbackChainId: null,
        notifyOnNeedsYou: true,
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
      instanceId: "codex" as never,
      model: "gpt-5.4",
      fallbackChainId: null,
      notifyOnNeedsYou: true,
    });
    expect(result.ok).toBe(true);
  });

  it("strips bootstrap instructions from a front-layer message", () => {
    const text = [
      "Actúa como el bot «Bot». Rol: Tester.",
      "--- INSTRUCCIONES DEL BOT ---",
      "secret",
      "--- FIN DE INSTRUCCIONES ---",
      "",
      "--- SOLICITUD DEL USUARIO ---",
      "hola",
      "--- FIN DE SOLICITUD ---",
    ].join("\n");
    expect(stripForkBotInitialMessage(text)).toBe("hola");
  });
});
