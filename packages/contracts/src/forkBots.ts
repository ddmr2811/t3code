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

export const ForkBotListInput = Schema.Struct({});
export type ForkBotListInput = typeof ForkBotListInput.Type;

export const ForkBotListResult = Schema.Struct({
  bots: Schema.Array(ForkBot).check(Schema.isMaxLength(FORK_BOTS_MAX_COUNT)),
  /** Oldest first. */
  handoffs: Schema.Array(ForkBotHandoff).check(Schema.isMaxLength(FORK_BOTS_HANDOFF_HISTORY)),
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
});
export type ForkBotUpsertInput = typeof ForkBotUpsertInput.Type;

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
