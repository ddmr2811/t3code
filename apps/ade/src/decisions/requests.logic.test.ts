import { userInputDraftKey } from "@t3tools/client-runtime/state/thread-requests";
import { describe, expect, it } from "vite-plus/test";

import { approvalChoices, approvalFile, orphanedAnswerTexts } from "./requests.logic.ts";

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

describe("approvalFile", () => {
  const item = (fields: object) => fields as Parameters<typeof approvalFile>[0][number];
  const ref = (nativeId: string | null) => ({ nativeItemRef: { nativeId } });
  const change = (fileName: string, nativeId: string | null) =>
    item({ type: "file_change", fileName, ...ref(nativeId) });
  const request = (requestId: string, nativeId: string | null) =>
    item({ type: "approval_request", requestId, ...ref(nativeId) });

  it("names the file of the tool call the approval belongs to, not another edit", () => {
    const items = [change("a.ts", "call-1"), change("b.ts", "call-2"), request("r2", "call-2")];
    expect(approvalFile(items, "r2")).toEqual({ path: "b.ts" });
  });

  it("names nothing when the rows carry no native id to match on", () => {
    expect(approvalFile([change("a.ts", null), request("r1", null)], "r1")).toBeNull();
  });
});
