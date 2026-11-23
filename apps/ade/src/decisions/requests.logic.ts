import type { PendingUserInputDraftAnswer } from "@t3tools/client-runtime/state/pending-user-input";
import { pruneResolvedUserInputDrafts } from "@t3tools/client-runtime/state/thread-requests";
import type {
  OrchestrationV2TurnItem,
  ProviderApprovalDecision,
  ProviderApprovalOption,
} from "@t3tools/contracts";

export interface ApprovalChoice {
  readonly decision: ProviderApprovalDecision;
  readonly label: string;
  readonly warning?: string;
  /** Grants more than this one request; its label and scope are the provider's own words. */
  readonly broad: boolean;
}

const ONE_TIME_TEXT = {
  accept: "Aprobar esta vez",
  decline: "Rechazar",
  cancel: "Cancelar",
} satisfies Partial<Record<ProviderApprovalDecision, string>>;

const isOneTime = (decision: ProviderApprovalDecision): decision is keyof typeof ONE_TIME_TEXT =>
  Object.hasOwn(ONE_TIME_TEXT, decision);

/**
 * The answers an approval offers. A grant wider than this one request is offered only when the
 * server lists it: without a list, a generic ACP agent takes "for this session" as its
 * `allow_always`, which an agent such as Hermes keeps for good.
 */
export function approvalChoices(
  options: ReadonlyArray<ProviderApprovalOption> | undefined,
): ApprovalChoice[] {
  if (options === undefined) {
    return (["accept", "decline", "cancel"] as const).map((decision) => ({
      decision,
      label: ONE_TIME_TEXT[decision],
      broad: false,
    }));
  }
  return options.map((option) => ({
    decision: option.decision,
    label: isOneTime(option.decision) ? ONE_TIME_TEXT[option.decision] : option.label,
    ...(option.warning === undefined ? {} : { warning: option.warning }),
    broad: !isOneTime(option.decision),
  }));
}

export type AnswerDrafts = Record<string, Record<string, PendingUserInputDraftAnswer>>;

/**
 * What the user typed for questions of this thread that are no longer pending and that this ADE
 * did not answer itself: answered elsewhere, the text would otherwise vanish with the question.
 */
export function orphanedAnswerTexts(
  drafts: AnswerDrafts,
  environmentId: string,
  threadId: string,
  pendingRequestIds: ReadonlyArray<string>,
  answeredHere: (requestKey: string) => boolean,
): Array<{ readonly requestKey: string; readonly text: string }> {
  const kept = pruneResolvedUserInputDrafts(drafts, environmentId, threadId, pendingRequestIds);
  return Object.entries(drafts).flatMap(([requestKey, answers]) => {
    if (Object.hasOwn(kept, requestKey) || answeredHere(requestKey)) return [];
    const text = Object.values(answers)
      .map((answer) => answer.customAnswer?.trim() ?? "")
      .filter((custom) => custom !== "")
      .join("\n");
    return text === "" ? [] : [{ requestKey, text }];
  });
}

/**
 * Every file an approval is about, with the diff the agent sent: the request's own text may name
 * none of them. Found through the tool call both rows come from, of the same provider and turn:
 * a native id alone can repeat. A row without a native id matches nothing.
 */
export function approvalFiles(
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
  requestId: string,
): {
  readonly paths: ReadonlyArray<string>;
  readonly diff?: string;
  /** The diff is the first file's only (Codex), or may be: the list of paths is the whole edit. */
  readonly diffIsPartial: boolean;
} | null {
  const request = turnItems.findLast(
    (item) => item.type === "approval_request" && item.requestId === requestId,
  );
  const ref = request?.nativeItemRef;
  if (request === undefined || ref?.nativeId == null) return null;
  const change = turnItems.findLast(
    (item) =>
      item.type === "file_change" &&
      item.nativeItemRef?.nativeId === ref.nativeId &&
      item.nativeItemRef.driver === ref.driver &&
      item.providerTurnId === request.providerTurnId,
  );
  if (change?.type !== "file_change") return null;
  const paths = [
    ...new Set([
      change.fileName,
      ...(change.changes ?? []).flatMap((file) =>
        file.oldPath === undefined ? [file.path] : [file.oldPath, file.path],
      ),
    ]),
  ];
  return {
    paths,
    ...(change.diffStr ? { diff: change.diffStr } : {}),
    diffIsPartial: Boolean(change.diffStr) && paths.length > 1,
  };
}

/**
 * Whether approving this one command may let the rest of the turn's commands through: an ACP
 * registry agent whose commands run in T3's terminals (Devin) cannot tie an approval to one
 * command, so the server grants execution for the turn.
 */
export function approvalMayCoverTurn(
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
  requestId: string,
): boolean {
  const request = turnItems.findLast(
    (item) => item.type === "approval_request" && item.requestId === requestId,
  );
  return (
    request?.type === "approval_request" &&
    request.requestKind === "command" &&
    request.nativeItemRef?.driver === "acpRegistry"
  );
}
