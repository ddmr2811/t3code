// Fork-only: per-project memory notes. Storage is provisional and stays behind this service.
import {
  FORK_MEMORY_ESSENTIAL_MAX_BYTES,
  FORK_MEMORY_MAX_FILE_BYTES,
  FORK_MEMORY_MAX_NOTES_PER_PROJECT,
  FORK_MEMORY_PROTOCOL_VERSION,
  ForkMemoryError,
  ForkMemoryListInput,
  type ForkMemoryListResult,
  ForkMemoryNote,
  type ForkMemoryNoteId,
  type ForkMemoryOrigin,
  ForkMemoryRemoveInput,
  type ForkMemoryRemoveResult,
  ForkMemoryUpsertInput,
  IsoDateTime,
  type ProjectId,
  forkMemoryEssentialBytes,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ProjectService from "../../project/ProjectService.ts";
import { makeForkJsonFileStore } from "../jsonFileStore.ts";

/** At most this many notes come back from one search. */
const FORK_MEMORY_SEARCH_LIMIT = 50;

interface ForkMemorySearchResult {
  readonly notes: ReadonlyArray<ForkMemoryNote>;
  /** Every note that matched, before the limit. */
  readonly total: number;
}

export class ForkProjectMemory extends Context.Service<
  ForkProjectMemory,
  {
    readonly list: (
      input: ForkMemoryListInput,
    ) => Effect.Effect<ForkMemoryListResult, ForkMemoryError>;
    /** `replaces` removes those notes of the same project in the same save, to merge them. */
    readonly upsert: (
      input: ForkMemoryUpsertInput,
      origin: ForkMemoryOrigin,
      replaces?: ReadonlyArray<ForkMemoryNoteId>,
    ) => Effect.Effect<ForkMemoryNote, ForkMemoryError>;
    readonly remove: (
      input: ForkMemoryRemoveInput,
    ) => Effect.Effect<ForkMemoryRemoveResult, ForkMemoryError>;
    /** Plain-text search: every word must appear. An empty query lists the newest notes. */
    readonly search: (
      projectId: ProjectId,
      query: string,
    ) => Effect.Effect<ForkMemorySearchResult, ForkMemoryError>;
    /** The essential notes, oldest first, as they are injected into a coordinator's turn. */
    readonly essentials: (
      projectId: ProjectId,
    ) => Effect.Effect<ReadonlyArray<ForkMemoryNote>, ForkMemoryError>;
  }
>()("t3/fork/memory/ForkProjectMemory") {}

const uniqueIds = Schema.makeFilter(
  (notes: ReadonlyArray<ForkMemoryNote>) =>
    new Set(notes.map((note) => note.id)).size === notes.length,
  { expected: "unique memory note ids" },
);

const StoredMemory = Schema.Struct({
  version: Schema.Literal(FORK_MEMORY_PROTOCOL_VERSION),
  updatedAt: Schema.NullOr(IsoDateTime),
  notes: Schema.Array(ForkMemoryNote).check(uniqueIds),
});
type StoredMemory = typeof StoredMemory.Type;

const EMPTY_MEMORY: StoredMemory = {
  version: FORK_MEMORY_PROTOCOL_VERSION,
  updatedAt: null,
  notes: [],
};

const decodeStoredMemory = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredMemory));
const decodeListInput = Schema.decodeUnknownEffect(ForkMemoryListInput);
const decodeUpsertInput = Schema.decodeUnknownEffect(ForkMemoryUpsertInput);
const decodeRemoveInput = Schema.decodeUnknownEffect(ForkMemoryRemoveInput);

const invalidInput = (message: string) => new ForkMemoryError({ reason: "invalidInput", message });
const limitExceeded = (message: string) =>
  new ForkMemoryError({ reason: "limitExceeded", message });

const byNewest = (left: ForkMemoryNote, right: ForkMemoryNote) =>
  right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id);
const byOldest = (left: ForkMemoryNote, right: ForkMemoryNote) =>
  left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);

const make = Effect.gen(function* () {
  const store = yield* makeForkJsonFileStore({
    fileName: "memory.json",
    label: "Memory store",
    maxBytes: FORK_MEMORY_MAX_FILE_BYTES,
    empty: EMPTY_MEMORY,
    decode: decodeStoredMemory,
    makeError: (reason, message) => new ForkMemoryError({ reason, message }),
  });
  const lock = yield* Semaphore.make(1);
  const projects = yield* ProjectService.ProjectService;
  const projectNotes = (projectId: ProjectId) =>
    lock
      .withPermits(1)(store.read())
      .pipe(Effect.map((memory) => memory.notes.filter((note) => note.projectId === projectId)));

  const list = Effect.fn("ForkProjectMemory.list")(function* (input: ForkMemoryListInput) {
    const parsed = yield* decodeListInput(input).pipe(
      Effect.mapError(() => invalidInput("Invalid memory filter.")),
    );
    return { notes: (yield* projectNotes(parsed.projectId)).toSorted(byNewest) };
  });

  const upsert = Effect.fn("ForkProjectMemory.upsert")(function* (
    input: ForkMemoryUpsertInput,
    origin: ForkMemoryOrigin,
    replaces: ReadonlyArray<ForkMemoryNoteId> = [],
  ) {
    const parsed = yield* decodeUpsertInput(input).pipe(
      Effect.mapError(() => invalidInput("Invalid memory note.")),
    );
    if (parsed.id === undefined) {
      const project = yield* projects.getById(parsed.projectId).pipe(
        Effect.mapError(
          () =>
            new ForkMemoryError({
              reason: "storageFailed",
              message: `Could not verify project ${parsed.projectId}.`,
            }),
        ),
      );
      if (Option.isNone(project)) {
        return yield* new ForkMemoryError({
          reason: "notFound",
          message: `Project ${parsed.projectId} was not found.`,
        });
      }
    }
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const memory = yield* store.read();
        const existing =
          parsed.id === undefined ? undefined : memory.notes.find((note) => note.id === parsed.id);
        if (parsed.id !== undefined && existing?.projectId !== parsed.projectId) {
          return yield* new ForkMemoryError({
            reason: "notFound",
            message: `Note ${parsed.id} was not found in project ${parsed.projectId}.`,
          });
        }
        const dropped = new Set(replaces.filter((id) => id !== parsed.id));
        for (const id of dropped) {
          const note = memory.notes.find((candidate) => candidate.id === id);
          if (note?.projectId !== parsed.projectId) {
            return yield* new ForkMemoryError({
              reason: "notFound",
              message: `Note ${id} to replace was not found in project ${parsed.projectId}.`,
            });
          }
          if (origin === "agent" && (note.origin !== "agent" || note.inclusion !== "searchable")) {
            return yield* new ForkMemoryError({
              reason: "invalidInput",
              message: `Note ${id} was written or promoted by the user; an agent can only propose replacing it.`,
            });
          }
        }
        const now = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
        const note: ForkMemoryNote = {
          id: existing?.id ?? `mem:${SecureRandom.uuidV4Unsafe()}`,
          projectId: parsed.projectId,
          text: parsed.text,
          inclusion: parsed.inclusion,
          // A note the user has edited is theirs, so no agent can merge it away afterwards.
          origin: origin === "user" ? "user" : (existing?.origin ?? origin),
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        const kept = memory.notes.filter((candidate) => !dropped.has(candidate.id));
        const notes =
          existing === undefined
            ? [...kept, note]
            : kept.map((candidate) => (candidate.id === note.id ? note : candidate));
        const project = notes.filter((candidate) => candidate.projectId === parsed.projectId);
        if (project.length > FORK_MEMORY_MAX_NOTES_PER_PROJECT) {
          return yield* limitExceeded(
            `Project ${parsed.projectId} already holds ${FORK_MEMORY_MAX_NOTES_PER_PROJECT} notes, the limit.`,
          );
        }
        if (forkMemoryEssentialBytes(project) > FORK_MEMORY_ESSENTIAL_MAX_BYTES) {
          return yield* limitExceeded(
            `Essential notes of project ${parsed.projectId} may total at most ${FORK_MEMORY_ESSENTIAL_MAX_BYTES} bytes. Save it as searchable, or make another essential note searchable first.`,
          );
        }
        yield* store.write({ ...memory, notes, updatedAt: now });
        return note;
      }),
    );
  });

  const remove = Effect.fn("ForkProjectMemory.remove")(function* (input: ForkMemoryRemoveInput) {
    const parsed = yield* decodeRemoveInput(input).pipe(
      Effect.mapError(() => invalidInput("Invalid memory note id.")),
    );
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const memory = yield* store.read();
        const notes = memory.notes.filter(
          (note) => note.id !== parsed.id || note.projectId !== parsed.projectId,
        );
        if (notes.length === memory.notes.length) return { id: parsed.id, removed: false };
        const now = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
        yield* store.write({ ...memory, notes, updatedAt: now });
        return { id: parsed.id, removed: true };
      }),
    );
  });

  const search = Effect.fn("ForkProjectMemory.search")(function* (
    projectId: ProjectId,
    query: string,
  ) {
    const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const matches = (yield* projectNotes(projectId))
      .filter((note) => {
        const text = note.text.toLocaleLowerCase();
        return terms.every((term) => text.includes(term));
      })
      .toSorted(byNewest);
    return { notes: matches.slice(0, FORK_MEMORY_SEARCH_LIMIT), total: matches.length };
  });

  const essentials = Effect.fn("ForkProjectMemory.essentials")(function* (projectId: ProjectId) {
    return (yield* projectNotes(projectId))
      .filter((note) => note.inclusion === "essential")
      .toSorted(byOldest);
  });

  return ForkProjectMemory.of({ list, upsert, remove, search, essentials });
});

export const layer = Layer.effect(ForkProjectMemory, make);
