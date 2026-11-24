// Fork-only: project coordination board persisted atomically in `<stateDir>/fork/coordination.json`.
import {
  FORK_COORDINATION_MAX_FILE_BYTES,
  type ForkCoordinationEntry,
  ForkCoordinationError,
  ForkCoordinationListInput,
  type ForkCoordinationListResult,
  ForkCoordinationRemoveInput,
  type ForkCoordinationRemoveResult,
  ForkCoordinationUpsertInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { makeForkJsonFileStore } from "../jsonFileStore.ts";
import {
  decodeStoredCoordinationBoard,
  EMPTY_COORDINATION_BOARD,
  listBoardEntries,
  removeBoardEntry,
  upsertBoardEntry,
} from "./store.ts";

export class ForkCoordination extends Context.Service<
  ForkCoordination,
  {
    readonly list: (
      input: ForkCoordinationListInput,
    ) => Effect.Effect<ForkCoordinationListResult, ForkCoordinationError>;
    readonly upsert: (
      input: ForkCoordinationUpsertInput,
    ) => Effect.Effect<ForkCoordinationEntry, ForkCoordinationError>;
    readonly remove: (
      input: ForkCoordinationRemoveInput,
    ) => Effect.Effect<ForkCoordinationRemoveResult, ForkCoordinationError>;
  }
>()("t3/fork/coordination/ForkCoordination") {}

const decodeListInput = Schema.decodeUnknownEffect(ForkCoordinationListInput);
const decodeUpsertInput = Schema.decodeUnknownEffect(ForkCoordinationUpsertInput);
const decodeRemoveInput = Schema.decodeUnknownEffect(ForkCoordinationRemoveInput);

const invalidInput = (message: string) =>
  new ForkCoordinationError({ reason: "invalidInput", message });

/** @public */
export const make = Effect.gen(function* () {
  const writeLock = yield* Semaphore.make(1);

  const store = yield* makeForkJsonFileStore({
    fileName: "coordination.json",
    label: "Coordination store",
    maxBytes: FORK_COORDINATION_MAX_FILE_BYTES,
    empty: EMPTY_COORDINATION_BOARD,
    decode: decodeStoredCoordinationBoard,
    makeError: (reason, message) => new ForkCoordinationError({ reason, message }),
  });

  const list = Effect.fn("ForkCoordination.list")(function* (input: ForkCoordinationListInput) {
    const parsed = yield* decodeListInput(input).pipe(
      Effect.mapError(() => invalidInput("Invalid coordination filter.")),
    );
    const board = yield* writeLock.withPermits(1)(store.read());
    return listBoardEntries(board, parsed.projectKey);
  });

  const upsert = Effect.fn("ForkCoordination.upsert")(function* (
    input: ForkCoordinationUpsertInput,
  ) {
    const parsed = yield* decodeUpsertInput(input).pipe(
      Effect.mapError(() => invalidInput("Invalid coordination entry.")),
    );
    return yield* writeLock.withPermits(1)(
      Effect.gen(function* () {
        const board = yield* store.read();
        const nowMs = yield* Clock.currentTimeMillis;
        const nowIso = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
        const resolvedId = parsed.id ?? `coord:${SecureRandom.uuidV4Unsafe()}`;
        const updated = upsertBoardEntry(board, parsed, resolvedId, nowIso);
        if (!updated.ok) return yield* updated.error;
        yield* store.write(updated.board);
        return updated.entry;
      }),
    );
  });

  const remove = Effect.fn("ForkCoordination.remove")(function* (
    input: ForkCoordinationRemoveInput,
  ) {
    const parsed = yield* decodeRemoveInput(input).pipe(
      Effect.mapError(() => invalidInput("Invalid coordination id.")),
    );
    return yield* writeLock.withPermits(1)(
      Effect.gen(function* () {
        const board = yield* store.read();
        const nowMs = yield* Clock.currentTimeMillis;
        const nowIso = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
        const result = removeBoardEntry(board, parsed.id, nowIso);
        if (result.removed) {
          yield* store.write(result.board);
        }
        return { removed: result.removed, id: parsed.id };
      }),
    );
  });

  return ForkCoordination.of({ list, upsert, remove });
});

export const layer = Layer.effect(ForkCoordination, make);
