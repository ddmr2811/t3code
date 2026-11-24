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
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ForkBot = typeof ForkBot.Type;

export const ForkBotListInput = Schema.Struct({});
export type ForkBotListInput = typeof ForkBotListInput.Type;

export const ForkBotListResult = Schema.Struct({
  bots: Schema.Array(ForkBot).check(Schema.isMaxLength(FORK_BOTS_MAX_COUNT)),
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

export const ForkBotsErrorReason = Schema.Literals([
  "invalidInput",
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
