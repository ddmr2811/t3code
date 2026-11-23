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
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../../config.ts";
import {
  decodeStoredCoordinationBoard,
  EMPTY_COORDINATION_BOARD,
  listBoardEntries,
  removeBoardEntry,
  serializeBoard,
  type StoredCoordinationBoard,
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

const storageFailed = (message: string) =>
  new ForkCoordinationError({ reason: "storageFailed", message });

/** @public */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const writeLock = yield* Semaphore.make(1);

  const forkDir = path.resolve(config.stateDir, "fork");
  const filePath = path.resolve(forkDir, "coordination.json");
  if (path.dirname(filePath) !== forkDir) {
    return yield* storageFailed("Resolved coordination path escaped the state directory.");
  }

  const readBoard = Effect.fn("ForkCoordination.readBoard")(function* () {
    const info = yield* fs.stat(filePath).pipe(
      Effect.map((stat) => stat),
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(null),
      ),
      Effect.mapError((error) =>
        storageFailed(`Could not inspect coordination store: ${error.message}`),
      ),
    );
    if (info === null) return EMPTY_COORDINATION_BOARD;
    if (Number(info.size) > FORK_COORDINATION_MAX_FILE_BYTES) {
      return yield* new ForkCoordinationError({
        reason: "limitExceeded",
        message: `Coordination store exceeds the ${FORK_COORDINATION_MAX_FILE_BYTES}-byte limit.`,
      });
    }
    const raw = yield* fs
      .readFileString(filePath)
      .pipe(
        Effect.mapError((error) =>
          storageFailed(`Could not read coordination store: ${error.message}`),
        ),
      );
    return yield* decodeStoredCoordinationBoard(raw).pipe(
      Effect.mapError((error) => storageFailed(`Coordination store is invalid: ${error.message}`)),
    );
  });

  const writeBoard = Effect.fn("ForkCoordination.writeBoard")(function* (
    board: StoredCoordinationBoard,
  ) {
    const serialized = serializeBoard(board);
    if (!serialized.ok) return yield* serialized.error;
    yield* fs
      .makeDirectory(forkDir, { recursive: true, mode: 0o700 })
      .pipe(
        Effect.mapError((error) =>
          storageFailed(`Could not prepare coordination directory: ${error.message}`),
        ),
      );
    yield* writeFileStringAtomically({ filePath, contents: serialized.json }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(HostProcess.Platform, platform),
      Effect.mapError((error) =>
        storageFailed(`Could not persist coordination store: ${error.message}`),
      ),
    );
    if (platform !== "win32") {
      // Tighten pre-existing looser files as well as freshly created ones.
      yield* fs
        .chmod(filePath, 0o600)
        .pipe(
          Effect.mapError((error) =>
            storageFailed(`Could not secure coordination store permissions: ${error.message}`),
          ),
        );
    }
  });

  const list = Effect.fn("ForkCoordination.list")(function* (input: ForkCoordinationListInput) {
    const parsed = yield* decodeListInput(input).pipe(
      Effect.mapError((error) => invalidInput(`Invalid coordination filter: ${error.message}`)),
    );
    const board = yield* writeLock.withPermits(1)(readBoard());
    return listBoardEntries(board, parsed.projectKey);
  });

  const upsert = Effect.fn("ForkCoordination.upsert")(function* (
    input: ForkCoordinationUpsertInput,
  ) {
    const parsed = yield* decodeUpsertInput(input).pipe(
      Effect.mapError((error) => invalidInput(`Invalid coordination entry: ${error.message}`)),
    );
    return yield* writeLock.withPermits(1)(
      Effect.gen(function* () {
        const board = yield* readBoard();
        const nowMs = yield* Clock.currentTimeMillis;
        const nowIso = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
        const resolvedId = parsed.id ?? `coord:${SecureRandom.uuidV4Unsafe()}`;
        const updated = upsertBoardEntry(board, parsed, resolvedId, nowIso);
        if (!updated.ok) return yield* updated.error;
        yield* writeBoard(updated.board);
        return updated.entry;
      }),
    );
  });

  const remove = Effect.fn("ForkCoordination.remove")(function* (
    input: ForkCoordinationRemoveInput,
  ) {
    const parsed = yield* decodeRemoveInput(input).pipe(
      Effect.mapError((error) => invalidInput(`Invalid coordination id: ${error.message}`)),
    );
    return yield* writeLock.withPermits(1)(
      Effect.gen(function* () {
        const board = yield* readBoard();
        const nowMs = yield* Clock.currentTimeMillis;
        const nowIso = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
        const result = removeBoardEntry(board, parsed.id, nowIso);
        if (result.removed) {
          yield* writeBoard(result.board);
        }
        return { removed: result.removed, id: parsed.id };
      }),
    );
  });

  return ForkCoordination.of({ list, upsert, remove });
});

export const layer = Layer.effect(ForkCoordination, make);
