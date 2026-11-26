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
  ForkMemoryPrevious,
  ForkMemoryRemoveInput,
  type ForkMemoryRemoveResult,
  ForkMemoryRestoreInput,
  ForkMemoryUpsertInput,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  type ThreadId,
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
    /**
     * Keeps the project's notes as they are now, replacing the version kept before, if the
     * project is still at `revision`. `undo` puts the version kept before back, for a
     * correction that never reached its coordinator; `attach` records the thread it reached.
     */
    readonly checkpoint: (
      projectId: ProjectId,
      correction: string,
      revision: number,
    ) => Effect.Effect<
      {
        readonly previous: ForkMemoryPrevious;
        readonly undo: Effect.Effect<void>;
        readonly attach: (threadId: ThreadId) => Effect.Effect<void>;
      },
      ForkMemoryError
    >;
    /** Swaps the notes with the kept version, which becomes the notes left behind; ForkBots
     * first checks no coordinator turn is still applying a correction. */
    readonly restore: (
      input: ForkMemoryRestoreInput,
    ) => Effect.Effect<ForkMemoryListResult, ForkMemoryError>;
  }
>()("t3/fork/memory/ForkProjectMemory") {}

const uniqueIds = Schema.makeFilter(
  (notes: ReadonlyArray<ForkMemoryNote>) =>
    new Set(notes.map((note) => note.id)).size === notes.length,
  { expected: "unique memory note ids" },
);

const ProjectState = Schema.Struct({
  revision: NonNegativeInt,
  updatedAt: IsoDateTime,
  previous: Schema.optionalKey(ForkMemoryPrevious),
});
type ProjectState = typeof ProjectState.Type;

const StoredMemory = Schema.Struct({
  version: Schema.Literal(FORK_MEMORY_PROTOCOL_VERSION),
  updatedAt: Schema.NullOr(IsoDateTime),
  notes: Schema.Array(ForkMemoryNote).check(uniqueIds),
  // Optional, so a file from before revisions still reads.
  projects: Schema.optionalKey(Schema.Record(Schema.String, ProjectState)),
});
type StoredMemory = typeof StoredMemory.Type;

/** A project saved before revisions starts at 1 if it has notes. */
function stateOf(memory: StoredMemory, projectId: ProjectId): ProjectState | undefined {
  const stored =
    memory.projects !== undefined && Object.hasOwn(memory.projects, projectId)
      ? memory.projects[projectId]
      : undefined;
  if (stored !== undefined) return stored;
  const notes = memory.notes.filter((note) => note.projectId === projectId);
  if (notes.length === 0) return undefined;
  const updatedAt = notes.map((note) => note.updatedAt).reduce((a, b) => (a > b ? a : b));
  return { revision: 1, updatedAt };
}

/** Every change to a project's notes goes through here, so its revision counts it. */
function withChange(
  memory: StoredMemory,
  projectId: ProjectId,
  notes: ReadonlyArray<ForkMemoryNote>,
  now: string,
  previous?: ForkMemoryPrevious,
): StoredMemory {
  const state = stateOf(memory, projectId);
  const kept = previous ?? state?.previous;
  const next: ProjectState = {
    revision: (state?.revision ?? 0) + 1,
    updatedAt: now,
    ...(kept === undefined ? {} : { previous: kept }),
  };
  return { ...memory, notes, updatedAt: now, projects: { ...memory.projects, [projectId]: next } };
}

const EMPTY_MEMORY: StoredMemory = {
  version: FORK_MEMORY_PROTOCOL_VERSION,
  updatedAt: null,
  notes: [],
};

const decodeStoredMemory = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredMemory));
const decodeListInput = Schema.decodeUnknownEffect(ForkMemoryListInput);
const decodeUpsertInput = Schema.decodeUnknownEffect(ForkMemoryUpsertInput);
const decodeRemoveInput = Schema.decodeUnknownEffect(ForkMemoryRemoveInput);
const decodeRestoreInput = Schema.decodeUnknownEffect(ForkMemoryRestoreInput);

const invalidInput = (message: string) => new ForkMemoryError({ reason: "invalidInput", message });
const limitExceeded = (message: string) =>
  new ForkMemoryError({ reason: "limitExceeded", message });
const staleRevision = (projectId: ProjectId, revision: number) =>
  new ForkMemoryError({
    reason: "conflict",
    message: `The memory of project ${projectId} changed after revision ${revision}; read it again.`,
  });

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

  const nowIso = Clock.currentTimeMillis.pipe(
    Effect.map((millis) => DateTime.formatIso(DateTime.makeUnsafe(millis))),
  );
  const snapshotOf = (
    memory: StoredMemory,
    projectId: ProjectId,
    includePrevious: boolean,
  ): ForkMemoryListResult => {
    const state = stateOf(memory, projectId);
    return {
      notes: memory.notes.filter((note) => note.projectId === projectId).toSorted(byNewest),
      ...(state === undefined
        ? {}
        : {
            revision: state.revision,
            updatedAt: state.updatedAt,
            ...(state.previous === undefined || !includePrevious
              ? {}
              : { previous: state.previous }),
          }),
    };
  };

  const list = Effect.fn("ForkProjectMemory.list")(function* (input: ForkMemoryListInput) {
    const parsed = yield* decodeListInput(input).pipe(
      Effect.mapError(() => invalidInput("Invalid memory filter.")),
    );
    const memory = yield* lock.withPermits(1)(store.read());
    return snapshotOf(memory, parsed.projectId, parsed.includePrevious === true);
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
        const now = yield* nowIso;
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
        yield* store.write(withChange(memory, parsed.projectId, notes, now));
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
        yield* store.write(withChange(memory, parsed.projectId, notes, yield* nowIso));
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

  const checkpoint = Effect.fn("ForkProjectMemory.checkpoint")(function* (
    projectId: ProjectId,
    correction: string,
    revision: number,
  ) {
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const memory = yield* store.read();
        const state = stateOf(memory, projectId);
        if ((state?.revision ?? 0) !== revision) return yield* staleRevision(projectId, revision);
        const now = yield* nowIso;
        const previous: ForkMemoryPrevious = {
          revision,
          savedAt: now,
          reason: "correction",
          correction,
          notes: memory.notes.filter((note) => note.projectId === projectId),
        };
        // A new copy is a change too, so a repeated or stale send finds the revision moved.
        const kept: ProjectState = { revision: revision + 1, updatedAt: now, previous };
        const others = { ...memory.projects };
        // Copies of deleted projects would hold the file's room for ever.
        for (const id of Object.keys(others)) {
          const found = yield* projects.getById(ProjectId.make(id)).pipe(Effect.option);
          if (Option.isSome(found) && Option.isNone(found.value)) delete others[id];
        }
        yield* store.write({ ...memory, projects: { ...others, [projectId]: kept } });
        const isOurs = (kept: ForkMemoryPrevious | undefined) =>
          kept?.savedAt === previous.savedAt &&
          kept.revision === previous.revision &&
          kept.correction === previous.correction;
        const attach = (threadId: ThreadId) =>
          lock
            .withPermits(1)(
              Effect.gen(function* () {
                const latest = yield* store.read();
                const current = stateOf(latest, projectId);
                if (current === undefined || !isOurs(current.previous)) return;
                yield* store.write({
                  ...latest,
                  projects: {
                    ...latest.projects,
                    [projectId]: { ...current, previous: { ...previous, threadId } },
                  },
                });
              }),
            )
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("fork memory could not note the correction's thread", {
                  projectId,
                  reason: error.reason,
                }),
              ),
            );
        const undo = lock
          .withPermits(1)(
            Effect.gen(function* () {
              const latest = yield* store.read();
              const current = stateOf(latest, projectId);
              // Another copy was kept since; this one is no longer the user's way back.
              if (current === undefined || !isOurs(current.previous)) return;
              const rest = Object.fromEntries(
                Object.entries(latest.projects ?? {}).filter(([id]) => id !== projectId),
              );
              // Untouched since, the copy goes; after another change, only the earlier copy returns.
              const back =
                current.revision === kept.revision
                  ? state
                  : {
                      revision: current.revision,
                      updatedAt: current.updatedAt,
                      ...(state?.previous === undefined ? {} : { previous: state.previous }),
                    };
              yield* store.write({
                ...latest,
                projects: back === undefined ? rest : { ...rest, [projectId]: back },
              });
            }),
          )
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("fork memory could not drop an undelivered copy", {
                projectId,
                reason: error.reason,
              }),
            ),
          );
        return { previous, undo, attach };
      }),
    );
  });

  const restore = Effect.fn("ForkProjectMemory.restore")(function* (input: ForkMemoryRestoreInput) {
    const parsed = yield* decodeRestoreInput(input).pipe(
      Effect.mapError(() => invalidInput("Invalid memory version.")),
    );
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const memory = yield* store.read();
        const state = stateOf(memory, parsed.projectId);
        const kept = state?.previous;
        if (state === undefined || state.revision !== parsed.revision) {
          return yield* staleRevision(parsed.projectId, parsed.revision);
        }
        if (kept === undefined) {
          return yield* new ForkMemoryError({
            reason: "notFound",
            message: `Project ${parsed.projectId} keeps no earlier version.`,
          });
        }
        const now = yield* nowIso;
        const current = memory.notes.filter((note) => note.projectId === parsed.projectId);
        const others = memory.notes.filter((note) => note.projectId !== parsed.projectId);
        const left: ForkMemoryPrevious = {
          revision: state.revision,
          savedAt: now,
          reason: "restore",
          notes: current,
        };
        const next = withChange(memory, parsed.projectId, [...others, ...kept.notes], now, left);
        yield* store.write(next);
        return snapshotOf(next, parsed.projectId, true);
      }),
    );
  });

  return ForkProjectMemory.of({
    list,
    upsert,
    remove,
    search,
    essentials,
    checkpoint,
    restore,
  });
});

export const layer = Layer.effect(ForkProjectMemory, make);
