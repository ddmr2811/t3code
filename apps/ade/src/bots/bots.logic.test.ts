import {
  type ForkBot,
  ProjectId,
  ProviderInstanceId,
  RunId,
  type ScheduledTask,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  NIGHTLY_CONSOLIDATION_PROMPT,
  botState,
  coordinatorRoutineInput,
  isCustomNightly,
  isNightlyTask,
  nightlyPromptUpdate,
  parseMention,
  validateBotDraft,
} from "./bots.logic.ts";

type BotThread = NonNullable<Parameters<typeof botState>[1]>;
type RunStatus = "running" | "completed" | "failed" | "interrupted" | "cancelled";

// The run ended at 10:05; visits before that have not seen it, visits after have.
const botThread = (
  status: RunStatus,
  lastVisitedAt = "2026-11-23T09:00:00.000Z",
  overrides: Partial<BotThread> = {},
): BotThread => ({
  archivedAt: null,
  deletedAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  pendingGuestMessageCount: 0,
  interactionMode: "default",
  hasActionableProposedPlan: false,
  pendingSubagentRequest: null,
  latestRun: {
    runId: RunId.make("run-1"),
    status,
    requestedAt: "2026-11-23T10:00:00.000Z",
    startedAt: "2026-11-23T10:00:00.000Z",
    completedAt: status === "running" ? null : "2026-11-23T10:05:00.000Z",
    assistantMessageId: null,
  },
  runtime: {
    status: status === "completed" || status === "cancelled" ? "idle" : status,
    activeRunId: status === "running" ? RunId.make("run-1") : null,
  } as BotThread["runtime"],
  lastVisitedAt,
  ...overrides,
});
const SEEN = "2026-11-23T11:00:00.000Z";

describe("botState", () => {
  it.each([
    ["an archived bot, even mid-turn", true, botThread("running"), false, "asleep"],
    ["a bot that never wrote", false, undefined, false, "asleep"],
    [
      "a pending approval",
      false,
      botThread("running", undefined, { hasPendingApprovals: true }),
      false,
      "needs-you",
    ],
    ["a running turn", false, botThread("running"), false, "working"],
    ["a failure not yet opened", false, botThread("failed"), false, "error"],
    ["a turn cut and not yet opened", false, botThread("interrupted"), false, "error"],
    ["a turn the user stopped, not yet opened", false, botThread("cancelled"), false, "error"],
    ["a cut turn the user already opened", false, botThread("interrupted", SEEN), false, "asleep"],
    ["a finished turn not yet opened", false, botThread("completed"), false, "done"],
    [
      "a finished turn seen, with a routine coming",
      false,
      botThread("completed", SEEN),
      true,
      "done",
    ],
    ["a finished turn seen, nothing coming", false, botThread("completed", SEEN), false, "asleep"],
  ] as const)("%s → %s", (_name, archived, thread, routine, expected) => {
    expect(botState({ archived }, thread, routine).status).toBe(expected);
  });
});

describe("bots.logic", () => {
  it("hands work over only for a leading @handle of another bot with something to say", () => {
    const others = ["revisor", "QA-bot"];
    expect(parseMention("@revisor  mira el diff\nde hoy", others)).toEqual({
      handle: "revisor",
      text: "mira el diff\nde hoy",
    });
    expect(parseMention("@qa-bot prueba", others)).toEqual({ handle: "QA-bot", text: "prueba" });
    for (const text of [
      "dile a @revisor que mire",
      "@desconocido hola",
      "@revisor",
      "@revisor   ",
    ]) {
      expect(parseMention(text, others)).toBeNull();
    }
  });

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
      handoffHops: 0,
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
      schedule: { type: "fixed_time", timeOfDay: "08:30" },
    });
    expect(daily.prompt.endsWith("\n\nResume el día")).toBe(true);
    expect(webhook.schedule).toEqual({ type: "webhook" });

    // A coordinator's nightly task saved before F8, paused and moved to 04:15 by its user.
    const saved = {
      ...nightly,
      id: "task-nightly",
      enabled: false,
      schedule: { type: "fixed_time", timeOfDay: "04:15" },
      prompt: [
        "Consolidación nocturna de la memoria del proyecto.",
        "1. Repasa todas las notas con project_memory_search (consulta vacía; si hay más de 50, busca por temas).",
        "2. Fusiona duplicados entre notas de agentes en una sola con project_memory_save y `replaces`, sin perder información. Las notas del usuario y las esenciales no se pueden sustituir: si sobran o se repiten, propónlo.",
        "3. Si una nota de agente quedó obsoleta porque otra la sustituye, añádela a `replaces`.",
        "4. Termina proponiendo, con su id, qué notas esenciales bajarías a buscables y cuáles borrarías, para que el usuario decida.",
      ].join("\n"),
    } as unknown as ScheduledTask;
    expect(isNightlyTask(saved)).toBe(true);
    expect(isNightlyTask({ ...saved, prompt: "Resume la noche" })).toBe(false);
    // The user rewrote its prompt: neither updated nor created again beside it.
    expect(isCustomNightly({ ...saved, prompt: "Resume la noche" })).toBe(true);
    expect(isCustomNightly(saved)).toBe(false);
    expect(nightlyPromptUpdate(saved)).toMatchObject({
      id: "task-nightly",
      prompt: NIGHTLY_CONSOLIDATION_PROMPT,
      enabled: false,
      schedule: { type: "fixed_time", timeOfDay: "04:15" },
      title: nightly.title,
    });
  });
});
