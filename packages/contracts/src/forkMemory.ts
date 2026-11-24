import * as Schema from "effect/Schema";
import { IsoDateTime, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Fork: per-project memory notes shared by the project's coordinator and its threads. */
export const FORK_MEMORY_PROTOCOL_VERSION = 1;
export const FORK_MEMORY_MAX_NOTES_PER_PROJECT = 256;
export const FORK_MEMORY_NOTE_MAX_LENGTH = 1000;
/** UTF-8 bytes of every essential note's text in one project; essentials ride along each turn. */
export const FORK_MEMORY_ESSENTIAL_MAX_BYTES = 8 * 1024;
export const FORK_MEMORY_MAX_FILE_BYTES = 8 * 1024 * 1024;

const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const ForkMemoryNoteId = TrimmedNonEmptyString.check(
  Schema.makeFilter((value: string) => SAFE_ID_PATTERN.test(value) && !value.includes(".."), {
    expected: "a safe memory note identifier",
  }),
);
export type ForkMemoryNoteId = typeof ForkMemoryNoteId.Type;

export const ForkMemoryText = TrimmedNonEmptyString.check(
  Schema.isMaxLength(FORK_MEMORY_NOTE_MAX_LENGTH),
  Schema.makeFilter((value: string) => !CONTROL_PATTERN.test(value), {
    expected: "one line of text without control characters",
  }),
);

export const ForkMemoryInclusion = Schema.Literals(["essential", "searchable"]);
export type ForkMemoryInclusion = typeof ForkMemoryInclusion.Type;

export const ForkMemoryOrigin = Schema.Literals(["user", "agent"]);
export type ForkMemoryOrigin = typeof ForkMemoryOrigin.Type;

export const ForkMemoryNote = Schema.Struct({
  id: ForkMemoryNoteId,
  projectId: ProjectId,
  text: ForkMemoryText,
  inclusion: ForkMemoryInclusion,
  origin: ForkMemoryOrigin,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ForkMemoryNote = typeof ForkMemoryNote.Type;

export const ForkMemoryListInput = Schema.Struct({ projectId: ProjectId });
export type ForkMemoryListInput = typeof ForkMemoryListInput.Type;

export const ForkMemoryListResult = Schema.Struct({
  notes: Schema.Array(ForkMemoryNote).check(Schema.isMaxLength(FORK_MEMORY_MAX_NOTES_PER_PROJECT)),
});
export type ForkMemoryListResult = typeof ForkMemoryListResult.Type;

export const ForkMemoryUpsertInput = Schema.Struct({
  id: Schema.optionalKey(ForkMemoryNoteId),
  projectId: ProjectId,
  text: ForkMemoryText,
  inclusion: ForkMemoryInclusion,
});
export type ForkMemoryUpsertInput = typeof ForkMemoryUpsertInput.Type;

export const ForkMemoryRemoveInput = Schema.Struct({ projectId: ProjectId, id: ForkMemoryNoteId });
export type ForkMemoryRemoveInput = typeof ForkMemoryRemoveInput.Type;

export const ForkMemoryRemoveResult = Schema.Struct({
  id: ForkMemoryNoteId,
  removed: Schema.Boolean,
});
export type ForkMemoryRemoveResult = typeof ForkMemoryRemoveResult.Type;

export const ForkMemoryErrorReason = Schema.Literals([
  "invalidInput",
  "limitExceeded",
  "notFound",
  "storageFailed",
]);
export type ForkMemoryErrorReason = typeof ForkMemoryErrorReason.Type;

export class ForkMemoryError extends Schema.TaggedError<ForkMemoryError>()("ForkMemoryError", {
  reason: ForkMemoryErrorReason,
  message: Schema.String,
}) {}

/** What the essentials of one project weigh against `FORK_MEMORY_ESSENTIAL_MAX_BYTES`. */
export function forkMemoryEssentialBytes(notes: ReadonlyArray<ForkMemoryNote>): number {
  const encoder = new TextEncoder();
  let total = 0;
  for (const note of notes) {
    if (note.inclusion === "essential") total += encoder.encode(note.text).byteLength;
  }
  return total;
}
