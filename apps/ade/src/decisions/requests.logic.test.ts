import { userInputDraftKey } from "@t3tools/client-runtime/state/thread-requests";
import { describe, expect, it } from "vite-plus/test";

import { approvalChoices, approvalFiles, orphanedAnswerTexts } from "./requests.logic.ts";

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
