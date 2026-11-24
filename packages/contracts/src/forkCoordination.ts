import * as Schema from "effect/Schema";
import { IsoDateTime, ThreadId, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

/** Fork: Project coordination board protocol version. */
export const FORK_COORDINATION_PROTOCOL_VERSION = 1;

export const FORK_COORDINATION_MAX_ENTRIES = 200;
export const FORK_COORDINATION_MAX_FILE_BYTES = 512 * 1024;
const FORK_COORDINATION_ID_MAX_LENGTH = 128;
export const FORK_COORDINATION_PROJECT_KEY_MAX_LENGTH = 256;
export const FORK_COORDINATION_PROJECT_NAME_MAX_LENGTH = 160;
export const FORK_COORDINATION_AGENT_NAME_MAX_LENGTH = 120;
export const FORK_COORDINATION_MODEL_LABEL_MAX_LENGTH = 120;
export const FORK_COORDINATION_SHORT_TEXT_MAX_LENGTH = 500;
export const FORK_COORDINATION_SUMMARY_MAX_LENGTH = 1000;

// Disallow ASCII control characters on single-line identifiers and labels.
const SINGLE_LINE_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
// Allow tab and newline in multi-line status notes while blocking other control bytes.
const MULTILINE_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const ENTRY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PATH_TRAVERSAL_SEGMENT_PATTERN = /(?:^|[\\/])\.\.(?:$|[\\/])/;

const noSingleLineControl = Schema.makeFilter(
  (value: string) => !SINGLE_LINE_CONTROL_PATTERN.test(value),
  { expected: "a string without control characters" },
);

const noMultilineControl = Schema.makeFilter(
  (value: string) => !MULTILINE_CONTROL_PATTERN.test(value),
  { expected: "text without control characters" },
);

const noPathTraversal = Schema.makeFilter(
  (value: string) => !PATH_TRAVERSAL_SEGMENT_PATTERN.test(value) && !value.includes("\0"),
  { expected: "a key without path traversal segments" },
);

const isSafeEntryId = Schema.makeFilter(
  (value: string) => ENTRY_ID_PATTERN.test(value) && !value.includes(".."),
  { expected: "a safe coordination entry identifier" },
);

export const ForkCoordinationEntryId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(FORK_COORDINATION_ID_MAX_LENGTH),
  isSafeEntryId,
);
export type ForkCoordinationEntryId = typeof ForkCoordinationEntryId.Type;

export const ForkCoordinationProjectKey = TrimmedNonEmptyString.check(
  Schema.isMaxLength(FORK_COORDINATION_PROJECT_KEY_MAX_LENGTH),
  noSingleLineControl,
  noPathTraversal,
);
export type ForkCoordinationProjectKey = typeof ForkCoordinationProjectKey.Type;

export const ForkCoordinationProjectName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(FORK_COORDINATION_PROJECT_NAME_MAX_LENGTH),
  noSingleLineControl,
);
export type ForkCoordinationProjectName = typeof ForkCoordinationProjectName.Type;

export const ForkCoordinationAgentName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(FORK_COORDINATION_AGENT_NAME_MAX_LENGTH),
  noSingleLineControl,
);
export type ForkCoordinationAgentName = typeof ForkCoordinationAgentName.Type;

export const ForkCoordinationModelLabel = TrimmedNonEmptyString.check(
  Schema.isMaxLength(FORK_COORDINATION_MODEL_LABEL_MAX_LENGTH),
  noSingleLineControl,
);
export type ForkCoordinationModelLabel = typeof ForkCoordinationModelLabel.Type;

const ForkCoordinationThreadId = ThreadId.check(
  Schema.isMaxLength(FORK_COORDINATION_ID_MAX_LENGTH),
  noSingleLineControl,
);

export const ForkCoordinationShortText = TrimmedString.check(
  Schema.isMaxLength(FORK_COORDINATION_SHORT_TEXT_MAX_LENGTH),
  noMultilineControl,
);
export type ForkCoordinationShortText = typeof ForkCoordinationShortText.Type;

export const ForkCoordinationSummaryText = TrimmedString.check(
  Schema.isMaxLength(FORK_COORDINATION_SUMMARY_MAX_LENGTH),
  noMultilineControl,
);
export type ForkCoordinationSummaryText = typeof ForkCoordinationSummaryText.Type;

export const ForkCoordinationStatus = Schema.Literals(["working", "waiting", "blocked", "done"]);
export type ForkCoordinationStatus = typeof ForkCoordinationStatus.Type;

export const ForkCoordinationEntry = Schema.Struct({
  id: ForkCoordinationEntryId,
  projectKey: ForkCoordinationProjectKey,
  projectName: ForkCoordinationProjectName,
  threadId: Schema.optionalKey(ForkCoordinationThreadId),
  agentName: ForkCoordinationAgentName,
  status: ForkCoordinationStatus,
  workingOn: ForkCoordinationShortText,
  completedSummary: ForkCoordinationSummaryText,
  waitingFor: ForkCoordinationShortText,
  modelLabel: Schema.optionalKey(ForkCoordinationModelLabel),
  updatedAt: IsoDateTime,
});
export type ForkCoordinationEntry = typeof ForkCoordinationEntry.Type;

export const ForkCoordinationListInput = Schema.Struct({
  projectKey: Schema.optionalKey(ForkCoordinationProjectKey),
});
export type ForkCoordinationListInput = typeof ForkCoordinationListInput.Type;

export const ForkCoordinationListResult = Schema.Struct({
  entries: Schema.Array(ForkCoordinationEntry),
  updatedAt: Schema.NullOr(IsoDateTime),
});
export type ForkCoordinationListResult = typeof ForkCoordinationListResult.Type;

export const ForkCoordinationUpsertInput = Schema.Struct({
  id: Schema.optionalKey(ForkCoordinationEntryId),
  projectKey: ForkCoordinationProjectKey,
  projectName: ForkCoordinationProjectName,
  threadId: Schema.optionalKey(ForkCoordinationThreadId),
  agentName: ForkCoordinationAgentName,
  status: ForkCoordinationStatus,
  workingOn: ForkCoordinationShortText,
  completedSummary: ForkCoordinationSummaryText,
  waitingFor: ForkCoordinationShortText,
  modelLabel: Schema.optionalKey(ForkCoordinationModelLabel),
});
export type ForkCoordinationUpsertInput = typeof ForkCoordinationUpsertInput.Type;

export const ForkCoordinationRemoveInput = Schema.Struct({
  id: ForkCoordinationEntryId,
});
export type ForkCoordinationRemoveInput = typeof ForkCoordinationRemoveInput.Type;

export const ForkCoordinationRemoveResult = Schema.Struct({
  removed: Schema.Boolean,
  id: ForkCoordinationEntryId,
});
export type ForkCoordinationRemoveResult = typeof ForkCoordinationRemoveResult.Type;

export const ForkCoordinationErrorReason = Schema.Literals([
  "invalidInput",
  "limitExceeded",
  "notFound",
  "storageFailed",
]);
export type ForkCoordinationErrorReason = typeof ForkCoordinationErrorReason.Type;

export class ForkCoordinationError extends Schema.TaggedError<ForkCoordinationError>()(
  "ForkCoordinationError",
  {
    reason: ForkCoordinationErrorReason,
    message: Schema.String,
  },
) {}
