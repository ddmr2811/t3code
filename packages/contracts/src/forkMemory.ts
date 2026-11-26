import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

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

const ProjectNotes = Schema.Array(ForkMemoryNote).check(
  Schema.isMaxLength(FORK_MEMORY_MAX_NOTES_PER_PROJECT),
);

/** The one earlier version of a project's notes the server keeps, so a correction can be undone. */
export const ForkMemoryPrevious = Schema.Struct({
  /** The revision these notes were at; `restore` names it so a stale screen restores nothing. */
  revision: NonNegativeInt,
  savedAt: IsoDateTime,
  /** Kept before a correction was sent, or left behind by going back to the version before. */
  reason: Schema.Literals(["correction", "restore"]),
  correction: Schema.optionalKey(ForkMemoryText),
  notes: ProjectNotes,
});
export type ForkMemoryPrevious = typeof ForkMemoryPrevious.Type;

export const ForkMemoryListResult = Schema.Struct({
  notes: ProjectNotes,
  // Optional: servers before revisions answer with the notes alone.
  /** Counts every change to this project's notes. */
  revision: Schema.optionalKey(NonNegativeInt),
  updatedAt: Schema.optionalKey(IsoDateTime),
  previous: Schema.optionalKey(ForkMemoryPrevious),
});
export type ForkMemoryListResult = typeof ForkMemoryListResult.Type;

/** One sentence the project's coordinator applies to the memory, after the server keeps a copy. */
export const ForkMemoryCorrectInput = Schema.Struct({
  projectId: ProjectId,
  text: ForkMemoryText,
});
export type ForkMemoryCorrectInput = typeof ForkMemoryCorrectInput.Type;

export const ForkMemoryCorrectResult = Schema.Struct({
  threadId: ThreadId,
  /** The coordinator was busy; the correction waits in its thread. */
  queued: Schema.Boolean,
  handle: Schema.String,
  previous: ForkMemoryPrevious,
});
export type ForkMemoryCorrectResult = typeof ForkMemoryCorrectResult.Type;

/** Swaps the notes with the kept version, so going back can itself be undone. */
export const ForkMemoryRestoreInput = Schema.Struct({
  projectId: ProjectId,
  revision: NonNegativeInt,
});
export type ForkMemoryRestoreInput = typeof ForkMemoryRestoreInput.Type;

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
