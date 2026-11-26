import { userInputDraftKey } from "@t3tools/client-runtime/state/thread-requests";
import { describe, expect, it } from "vite-plus/test";

import {
  approvalChoices,
  approvalFiles,
  botQuickAnswer,
  literalFits,
  orphanedAnswerTexts,
  quickAnswer,
} from "./requests.logic.ts";

const texts = (result: ReturnType<typeof botQuickAnswer>) =>
  result.kind === "yes-no" ? result.literals.map((literal) => literal.text) : [];

describe("approvalChoices", () => {
  it("offers no grant wider than this request when the server lists no options", () => {
    expect(approvalChoices(undefined).map((choice) => choice.decision)).toEqual([
      "accept",
      "decline",
      "cancel",
    ]);
  });

  it("keeps the provider's own words and warning on a wider grant the server lists", () => {
    const choices = approvalChoices([
      { decision: "accept", label: "Allow once" },
      { decision: "acceptForSession", label: "Always allow", warning: "Saves a workspace rule" },
    ]);
    expect(choices.map((choice) => choice.broad)).toEqual([false, true]);
    expect(choices[1]).toMatchObject({ label: "Always allow", warning: "Saves a workspace rule" });
  });
});

describe("orphanedAnswerTexts", () => {
  const key = (threadId: string, requestId: string) =>
    userInputDraftKey("env", threadId, requestId);
  const drafts = {
    [key("t1", "gone")]: {
      q1: { customAnswer: " usa pnpm " },
      q2: { selectedOptionValues: ["a"] },
    },
    [key("t1", "pending")]: { q1: { customAnswer: "sigue pendiente" } },
    [key("t1", "mine")]: { q1: { customAnswer: "la envié yo" } },
    [key("t1", "options-only")]: { q1: { selectedOptionValues: ["a"] } },
    [key("t2", "other-thread")]: { q1: { customAnswer: "otro hilo" } },
  };

  it("returns only text typed for a question of this thread that was resolved elsewhere", () => {
    expect(
      orphanedAnswerTexts(drafts, "env", "t1", ["pending"], (k) => k === key("t1", "mine")),
    ).toEqual([{ requestKey: key("t1", "gone"), text: "usa pnpm" }]);
  });
});

describe("approvalFiles", () => {
  const item = (fields: object) => fields as Parameters<typeof approvalFiles>[0][number];
  const ref = (nativeId: string | null, driver = "codex", providerTurnId = "turn-1") => ({
    nativeItemRef: { driver, nativeId },
    providerTurnId,
  });
  const change = (fileName: string, at: object, more: object = {}) =>
    item({ type: "file_change", fileName, ...at, ...more });
  const request = (requestId: string, at: object) =>
    item({ type: "approval_request", requestId, ...at });

  it("names the file of the tool call the approval belongs to, not another edit", () => {
    const items = [
      change("a.ts", ref("call-1")),
      change("b.ts", ref("call-2")),
      request("r2", ref("call-2")),
    ];
    expect(approvalFiles(items, "r2")).toEqual({ paths: ["b.ts"], diffIsPartial: false });
  });

  it("names every file of a multi-file edit and says its diff is not the whole edit", () => {
    const edit = change("a.ts", ref("call-1"), {
      diffStr: "+a",
      changes: [
        { operation: "update", path: "a.ts" },
        { operation: "delete", path: "secrets.env" },
        { operation: "update", path: "new.ts", oldPath: "old.ts" },
      ],
    });
    expect(approvalFiles([edit, request("r1", ref("call-1"))], "r1")).toEqual({
      paths: ["a.ts", "secrets.env", "old.ts", "new.ts"],
      diff: "+a",
      diffIsPartial: true,
    });
  });

  it.each([
    ["no native id to match on", ref(null), ref(null)],
    ["the same native id from another provider", ref("call-1", "claude"), ref("call-1")],
    ["the same native id in another turn", ref("call-1", "codex", "turn-0"), ref("call-1")],
  ])("names nothing for an edit with %s", (_name, changeAt, requestAt) => {
    expect(approvalFiles([change("a.ts", changeAt), request("r1", requestAt)], "r1")).toBeNull();
  });
});

describe("quickAnswer", () => {
  const approval = (
    overrides: Partial<Parameters<typeof quickAnswer>[0]["approvals"][number]> = {},
  ) => ({
    responseCapability: "live" as const,
    ...overrides,
  });
  const option = (label: string) => ({ label, description: label });
  const question = (
    overrides: { multiSelect?: boolean; options?: ReadonlyArray<ReturnType<typeof option>> } = {},
  ) => ({
    id: "q1",
    header: "Nombre",
    question: "¿Qué nombre le ponemos?",
    options: overrides.options ?? [option("Vega"), option("Nico")],
    multiSelect: overrides.multiSelect ?? false,
  });
  const prompt = (questions: ReadonlyArray<ReturnType<typeof question>>) => ({
    responseCapability: "live" as const,
    questions,
  });

  it("answers the first approval before any question, with «Rechazar» as its «No»", () => {
    const first = approval();
    const result = quickAnswer({ approvals: [first], userInputs: [prompt([question()])] });
    expect(result).toEqual({ kind: "approval", approval: first, no: "decline" });
  });

  it("takes «Cancelar» as the «No» of an agent that offers no «Rechazar»", () => {
    const result = quickAnswer({
      approvals: [
        approval({
          options: [
            { decision: "accept", label: "Allow" },
            { decision: "cancel", label: "Stop" },
          ],
        }),
      ],
      userInputs: [],
    });
    expect(result).toMatchObject({ kind: "approval", no: "cancel" });
  });

  it.each([
    ["one the agent can no longer take", approval({ responseCapability: "not_resumable" })],
    [
      "push hooks, whose commands do not fit a line",
      approval({ pushHooks: { branch: "main", files: [], commands: [] } }),
    ],
    [
      "a full-access override, which needs its reason",
      approval({ fullAccessOverride: "ask_rule" }),
    ],
    ["one with no «No» to give", approval({ options: [{ decision: "accept", label: "Allow" }] })],
  ])("opens the thread for an approval that is %s", (_, request) => {
    expect(quickAnswer({ approvals: [request], userInputs: [] })).toEqual({ kind: "open" });
  });

  it("offers a single question's options as one-tap picks", () => {
    const only = question();
    const asked = prompt([only]);
    expect(quickAnswer({ approvals: [], userInputs: [asked] })).toEqual({
      kind: "pick",
      prompt: asked,
      question: only,
    });
  });

  it.each([
    ["several answers", prompt([question({ multiSelect: true })])],
    ["no options", prompt([question({ options: [] })])],
    [
      "more options than fit",
      prompt([question({ options: ["a", "b", "c", "d", "e"].map(option) })]),
    ],
    ["two questions", prompt([question(), { ...question(), id: "q2" }])],
  ])("opens the thread for a question with %s", (_, asked) => {
    expect(quickAnswer({ approvals: [], userInputs: [asked] })).toEqual({ kind: "open" });
  });
});

describe("botQuickAnswer", () => {
  it("answers an install in place, asking twice, beside its exact command and way back", () => {
    const result = botQuickAnswer({
      type: "install",
      install: { command: "pnpm add -D knip", rollback: "pnpm remove knip" },
    });
    expect(result).toMatchObject({ kind: "yes-no", confirm: true });
    expect(texts(result)).toEqual(["pnpm add -D knip", "pnpm remove knip"]);
  });

  it("answers an outside-app action in place, asking twice, beside the arguments that will run", () => {
    const sent = '{"text":"Hola <b>mundo</b> **ya**","to":"@ade"}';
    const result = botQuickAnswer({ type: "integration", request: { arguments: sent } });
    expect(result).toMatchObject({ kind: "yes-no", confirm: true });
    const [shown] = texts(result);
    expect(JSON.parse(shown!)).toEqual(JSON.parse(sent));
    expect(shown).toContain("Hola <b>mundo</b> **ya**");
  });

  it("keeps arguments that are not JSON exactly as the bot sent them", () => {
    expect(texts(botQuickAnswer({ type: "integration", request: { arguments: "{roto" } }))).toEqual(
      ["{roto"],
    );
  });

  it("answers a proposed bot in place with one «Sí», beside its exact instructions", () => {
    const result = botQuickAnswer({
      type: "proposal",
      proposal: { instructions: "Revisa los PR." },
    });
    expect(result).toMatchObject({ kind: "yes-no", confirm: false });
    expect(texts(result)).toEqual(["Revisa los PR."]);
  });

  it.each(["handoff", "unreadable"] as const)("opens the panel for a %s notice", (type) => {
    expect(botQuickAnswer({ type })).toEqual({ kind: "open" });
  });
});

describe("literalFits", () => {
  it.each([
    ["a one-line command", "pnpm add -D knip", true],
    ["nine lines", Array.from({ length: 9 }, (_, i) => `línea ${i}`).join("\n"), false],
    ["one very long line", "x".repeat(481), false],
  ])("%s: %s", (_, text, fits) => {
    expect(literalFits(text)).toBe(fits);
  });
});
