import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";
import { ForkFailoverTarget } from "./forkFailover.ts";
import { ForkBotIntegrations } from "./forkIntegrations.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { RuntimeMode } from "./providerPolicy.ts";

/** Fork: persistent bot directory protocol version. */
export const FORK_BOTS_PROTOCOL_VERSION = 1;
export const FORK_BOTS_MAX_COUNT = 100;
export const FORK_BOTS_MAX_FILE_BYTES = 1024 * 1024;
export const FORK_BOTS_NAME_MAX_LENGTH = 80;
export const FORK_BOTS_ROLE_MAX_LENGTH = 120;
export const FORK_BOTS_INSTRUCTIONS_MAX_LENGTH = 8000;
export const FORK_BOTS_MESSAGE_MAX_LENGTH = 32_000;
/** A handoff chain longer than this is cut and shown to the user instead of delivered. */
export const FORK_BOTS_HANDOFF_MAX_HOPS = 4;
/** Handoffs kept on disk; an id older than the last ones is no longer recognised as a repeat. */
export const FORK_BOTS_HANDOFF_HISTORY = 100;
export const FORK_BOTS_HANDOFF_PREVIEW_LENGTH = 200;
/** Bytes, not characters: an excerpt for the next bot, never the sender's whole history. */
export const FORK_BOTS_HANDOFF_CONTEXT_MAX_BYTES = 4096;
/** Shorter than a bot's own: every pending proposal of every project shares the bot file. */
const FORK_BOTS_PROPOSAL_INSTRUCTIONS_MAX_LENGTH = 4000;
const FORK_BOTS_PROPOSAL_NOTE_MAX_LENGTH = 500;
/** A coordinator proposes at most one bot per project within this window. */
export const FORK_BOTS_PROPOSAL_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

const SINGLE_LINE_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const MULTILINE_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const noSingleLineControl = Schema.makeFilter(
  (value: string) => !SINGLE_LINE_CONTROL_PATTERN.test(value),
  { expected: "a string without control characters" },
);
const noMultilineControl = Schema.makeFilter(
  (value: string) => !MULTILINE_CONTROL_PATTERN.test(value),
  { expected: "text without control characters" },
);
// Also C1 controls and lone UTF-16 surrogates, which encode as U+FFFD and could share a handoff id.
const HANDOFF_CONTEXT_UNSAFE_PATTERN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]|\p{Cs}/u;
const utf8 = new TextEncoder();
const withinHandoffContextBytes = Schema.makeFilter(
  (value: string) => utf8.encode(value).byteLength <= FORK_BOTS_HANDOFF_CONTEXT_MAX_BYTES,
  { expected: `at most ${FORK_BOTS_HANDOFF_CONTEXT_MAX_BYTES} bytes of UTF-8` },
);
const safeBotId = Schema.makeFilter(
  (value: string) => SAFE_ID_PATTERN.test(value) && !value.includes(".."),
  { expected: "a safe bot identifier" },
);

export const ForkBotId = TrimmedNonEmptyString.check(Schema.isMaxLength(128), safeBotId);
export type ForkBotId = typeof ForkBotId.Type;

export const ForkBotHandle = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9_-]{1,31}$/),
);
export type ForkBotHandle = typeof ForkBotHandle.Type;

export const ForkBotName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(FORK_BOTS_NAME_MAX_LENGTH),
  noSingleLineControl,
);
export const ForkBotRole = TrimmedNonEmptyString.check(
  Schema.isMaxLength(FORK_BOTS_ROLE_MAX_LENGTH),
  noSingleLineControl,
);
export const ForkBotInstructions = TrimmedString.check(
  Schema.isMaxLength(FORK_BOTS_INSTRUCTIONS_MAX_LENGTH),
  noMultilineControl,
);
export const ForkBotMessage = TrimmedNonEmptyString.check(
  Schema.isMaxLength(FORK_BOTS_MESSAGE_MAX_LENGTH),
  noMultilineControl,
);
export const ForkBotHandoffContext = TrimmedNonEmptyString.check(
  withinHandoffContextBytes,
  Schema.makeFilter((value: string) => !HANDOFF_CONTEXT_UNSAFE_PATTERN.test(value), {
    expected: "text without control characters or lone surrogates",
  }),
);

export const ForkBot = Schema.Struct({
  id: ForkBotId,
  handle: ForkBotHandle,
  name: ForkBotName,
  role: ForkBotRole,
  instructions: ForkBotInstructions,
  projectId: ProjectId,
  threadId: Schema.NullOr(ThreadId),
  runtimeMode: RuntimeMode,
  modelSelection: ForkFailoverTarget,
  archived: Schema.Boolean,
  /** The project's one coordinator gets its essential memory injected into each turn. */
  coordinator: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Hash of the essential memory its thread last received; null until one was sent. */
  memoryHash: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Hops of the handoff that last reached it; a message from the user resets it to 0. */
  handoffHops: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  /** Its last finished turn ran on a provider that never reached T3's MCP, so it had no bot_handoff. */
  handoffToolsMissing: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** What it may do in outside apps; nothing unless the user grants it. */
  integrations: ForkBotIntegrations.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ForkBot = typeof ForkBot.Type;

export const ForkBotHandoffId = TrimmedNonEmptyString.check(Schema.isMaxLength(128), safeBotId);
export type ForkBotHandoffId = typeof ForkBotHandoffId.Type;

/**
 * `pending` and `failed` may be retried with the same id (`pending` is one a restart cut short);
 * `dismissed` is a cut handoff the user cleared.
 */
export const ForkBotHandoffStatus = Schema.Literals([
  "pending",
  "delivered",
  "cut",
  "failed",
  "dismissed",
]);
export type ForkBotHandoffStatus = typeof ForkBotHandoffStatus.Type;

export const ForkBotHandoff = Schema.Struct({
  id: ForkBotHandoffId,
  fromBotId: ForkBotId,
  toBotId: ForkBotId,
  /** `user`: typed as @mention in the ADE. `agent`: the bot's own thread called bot_handoff. */
  origin: Schema.Literals(["user", "agent"]),
  hops: Schema.Int,
  status: ForkBotHandoffStatus,
  preview: Schema.String.check(Schema.isMaxLength(FORK_BOTS_HANDOFF_PREVIEW_LENGTH)),
  createdAt: IsoDateTime,
});
export type ForkBotHandoff = typeof ForkBotHandoff.Type;

export const ForkBotProposalId = ForkBotHandoffId;
export type ForkBotProposalId = typeof ForkBotProposalId.Type;

export const ForkBotProposalInstructions = ForkBotInstructions.check(
  Schema.isMaxLength(FORK_BOTS_PROPOSAL_INSTRUCTIONS_MAX_LENGTH),
);

export const ForkBotProposalNote = TrimmedNonEmptyString.check(
  Schema.isMaxLength(FORK_BOTS_PROPOSAL_NOTE_MAX_LENGTH),
  noMultilineControl,
);

/** A bot the project's coordinator suggests; nothing is created until the user accepts it. */
export const ForkBotProposal = Schema.Struct({
  id: ForkBotProposalId,
  projectId: ProjectId,
  proposedBy: ForkBotId,
  handle: ForkBotHandle,
  name: ForkBotName,
  role: ForkBotRole,
  /** Emptied once answered: the bot then holds them, and a refusal needs only the handle. */
  instructions: ForkBotProposalInstructions,
  /** Described, not scheduled: the user adds it from the bot once it exists. */
  routine: ForkBotProposalNote,
  /** The repeated requests that led to it. */
  reason: ForkBotProposalNote,
  runtimeMode: RuntimeMode,
  modelSelection: ForkFailoverTarget,
  status: Schema.Literals(["pending", "accepted", "rejected"]),
  botId: Schema.NullOr(ForkBotId),
  createdAt: IsoDateTime,
  decidedAt: Schema.NullOr(IsoDateTime),
});
export type ForkBotProposal = typeof ForkBotProposal.Type;

export const ForkBotAnswerProposalInput = Schema.Struct({
  id: ForkBotProposalId,
  answer: Schema.Literals(["accept", "reject"]),
});
export type ForkBotAnswerProposalInput = typeof ForkBotAnswerProposalInput.Type;

export const ForkBotListInput = Schema.Struct({});
export type ForkBotListInput = typeof ForkBotListInput.Type;

export const ForkBotListResult = Schema.Struct({
  bots: Schema.Array(ForkBot).check(Schema.isMaxLength(FORK_BOTS_MAX_COUNT)),
  /** Oldest first. */
  handoffs: Schema.Array(ForkBotHandoff).check(Schema.isMaxLength(FORK_BOTS_HANDOFF_HISTORY)),
  /** Oldest first. A server without proposals sends none. */
  proposals: Schema.Array(ForkBotProposal).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  updatedAt: Schema.NullOr(IsoDateTime),
});
export type ForkBotListResult = typeof ForkBotListResult.Type;

export const ForkBotUpsertInput = Schema.Struct({
  id: Schema.optionalKey(ForkBotId),
  handle: ForkBotHandle,
  name: ForkBotName,
  role: ForkBotRole,
  instructions: ForkBotInstructions,
  projectId: ProjectId,
  runtimeMode: Schema.optionalKey(RuntimeMode),
  modelSelection: ForkFailoverTarget,
  coordinator: Schema.optionalKey(Schema.Boolean),
  integrations: Schema.optionalKey(ForkBotIntegrations),
});
export type ForkBotUpsertInput = typeof ForkBotUpsertInput.Type;

export const FORK_BOTS_DRAFT_TEXT_MAX_LENGTH = 2000;

/** One sentence describing the bot the user wants, for the project it should work in. */
export const ForkBotDraftInput = Schema.Struct({
  text: TrimmedNonEmptyString.check(
    Schema.isMaxLength(FORK_BOTS_DRAFT_TEXT_MAX_LENGTH),
    noMultilineControl,
  ),
  projectId: ProjectId,
});
export type ForkBotDraftInput = typeof ForkBotDraftInput.Type;

const ForkBotDraftModel = Schema.Struct({ instanceId: ProviderInstanceId, model: TrimmedString });

/**
 * A bot ready for `forkBots.upsert`. Mode, project and model are the server's, never the model's:
 * the safest mode, and never a coordinator.
 */
export const ForkBotDraft = Schema.Struct({
  handle: ForkBotHandle,
  name: ForkBotName,
  role: ForkBotRole,
  instructions: ForkBotInstructions,
  /** Described, not scheduled; empty when the sentence asks for none. */
  routine: TrimmedString.check(
    Schema.isMaxLength(FORK_BOTS_PROPOSAL_NOTE_MAX_LENGTH),
    noSingleLineControl,
  ),
  projectId: ProjectId,
  runtimeMode: Schema.Literal("approval-required"),
  modelSelection: ForkFailoverTarget,
  /** The model that wrote it; null when it was drafted from the sentence alone. */
  draftedBy: Schema.NullOr(ForkBotDraftModel),
  /**
   * Why no model wrote it: none allowed is usable, the chosen one is not on the allowed list, its
   * call failed, or its reply was not a valid bot. Null when `draftedBy` wrote it.
   */
  fallbackReason: Schema.NullOr(
    Schema.Literals(["noModel", "modelNotAllowed", "modelFailed", "invalidReply"]),
  ),
});
export type ForkBotDraft = typeof ForkBotDraft.Type;

/**
 * Drafting sends the user's sentence, which may carry project data, to the model. Only these
 * exact models may receive it, preferred first: Gemini Flash through Antigravity, then Kimi
 * through OpenCode Go.
 */
const FORK_BOT_DRAFT_MODELS = [
  { driver: "antigravity", model: "gemini-3.8-flash" },
  { driver: "antigravity", model: "gemini-3.8-flash-low" },
  { driver: "antigravity", model: "gemini-3.8-flash-medium" },
  { driver: "antigravity", model: "gemini-3.8-flash-high" },
  { driver: "antigravity", model: "gemini-3.7-flash-low" },
  { driver: "antigravity", model: "gemini-3.7-flash-medium" },
  { driver: "antigravity", model: "gemini-3.7-flash-high" },
  { driver: "antigravity", model: "gemini-3.6-flash-low" },
  { driver: "antigravity", model: "gemini-3.6-flash-medium" },
  { driver: "antigravity", model: "gemini-3.6-flash-high" },
  { driver: "opencode", model: "opencode-go/kimi-k3" },
  { driver: "opencode", model: "opencode-go/kimi-k3.1-pro" },
  { driver: "opencode", model: "opencode-go/kimi-k2.7-code" },
] as const;

export const isForkBotDraftModelAllowed = (driver: string, model: string): boolean =>
  FORK_BOT_DRAFT_MODELS.some((allowed) => allowed.driver === driver && allowed.model === model);

interface DraftModelProvider {
  readonly instanceId: ProviderInstanceId;
  readonly driver: string;
  readonly models: ReadonlyArray<{
    readonly slug: string;
    readonly isLegacy?: boolean | undefined;
  }>;
}

/**
 * The model that drafts bots among the usable `providers`: the chosen one if allowed and listed,
 * else, with none chosen, the first allowed one listed. Null drafts without a model.
 */
export function forkBotDraftModel(
  chosen: { readonly instanceId: ProviderInstanceId; readonly model: string } | null,
  providers: ReadonlyArray<DraftModelProvider>,
): { readonly instanceId: ProviderInstanceId; readonly model: string } | null {
  const offers = (provider: DraftModelProvider, model: string) =>
    isForkBotDraftModelAllowed(String(provider.driver), model) &&
    provider.models.some((listed) => listed.slug === model && listed.isLegacy !== true);
  if (chosen !== null) {
    const provider = providers.find((candidate) => candidate.instanceId === chosen.instanceId);
    return provider !== undefined && offers(provider, chosen.model)
      ? { instanceId: chosen.instanceId, model: chosen.model }
      : null;
  }
  for (const allowed of FORK_BOT_DRAFT_MODELS) {
    const provider = providers.find(
      (candidate) =>
        String(candidate.driver) === allowed.driver && offers(candidate, allowed.model),
    );
    if (provider !== undefined) return { instanceId: provider.instanceId, model: allowed.model };
  }
  return null;
}

export const ForkBotSetArchivedInput = Schema.Struct({
  id: ForkBotId,
  archived: Schema.Boolean,
});
export type ForkBotSetArchivedInput = typeof ForkBotSetArchivedInput.Type;

export const ForkBotRemoveInput = Schema.Struct({ id: ForkBotId });
export type ForkBotRemoveInput = typeof ForkBotRemoveInput.Type;

export const ForkBotRemoveResult = Schema.Struct({
  id: ForkBotId,
  removed: Schema.Boolean,
});
export type ForkBotRemoveResult = typeof ForkBotRemoveResult.Type;

export const ForkBotSendMessageInput = Schema.Struct({
  id: ForkBotId,
  text: ForkBotMessage,
});
export type ForkBotSendMessageInput = typeof ForkBotSendMessageInput.Type;

export const ForkBotSendMessageResult = Schema.Struct({
  bot: ForkBot,
  threadId: ThreadId,
  queued: Schema.Boolean,
});
export type ForkBotSendMessageResult = typeof ForkBotSendMessageResult.Type;

export const ForkBotHandoffInput = Schema.Struct({
  /** Chosen by the sender, so a retried send is recognised and not delivered twice. */
  id: ForkBotHandoffId,
  fromId: ForkBotId,
  toHandle: ForkBotHandle,
  text: ForkBotMessage,
  context: Schema.optionalKey(ForkBotHandoffContext),
});
export type ForkBotHandoffInput = typeof ForkBotHandoffInput.Type;

export const ForkBotHandoffResult = Schema.Struct({
  handoff: ForkBotHandoff,
  /** The thread that received it; null when it was cut. */
  threadId: Schema.NullOr(ThreadId),
  /** The id was already handled, so nothing was sent this time. */
  duplicate: Schema.Boolean,
});
export type ForkBotHandoffResult = typeof ForkBotHandoffResult.Type;

export const ForkBotDismissHandoffInput = Schema.Struct({ id: ForkBotHandoffId });
export type ForkBotDismissHandoffInput = typeof ForkBotDismissHandoffInput.Type;

export const ForkBotsErrorReason = Schema.Literals([
  "invalidInput",
  "permissionDenied",
  "limitExceeded",
  "notFound",
  "conflict",
  "unavailable",
  "dispatchFailed",
  "storageFailed",
]);
export type ForkBotsErrorReason = typeof ForkBotsErrorReason.Type;

export class ForkBotsError extends Schema.TaggedError<ForkBotsError>()("ForkBotsError", {
  reason: ForkBotsErrorReason,
  message: Schema.String,
}) {}
