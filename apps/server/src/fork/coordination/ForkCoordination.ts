// @effect-diagnostics nodeBuiltinImport:off -- O_NOFOLLOW, O_NONBLOCK, lstat, realpath, and O_CREAT|O_EXCL 0600 require direct fs flags.
// Fork-only: project coordination board persisted atomically in `<stateDir>/fork/coordination.json`.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

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
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
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

const READ_FLAGS =
  NodeFS.constants.O_RDONLY |
  (NodeFS.constants.O_NOFOLLOW ?? 0) |
  (NodeFS.constants.O_NONBLOCK ?? 0);

const WRITE_TEMP_FLAGS =
  NodeFS.constants.O_CREAT |
  NodeFS.constants.O_EXCL |
  NodeFS.constants.O_WRONLY |
  (NodeFS.constants.O_NOFOLLOW ?? 0);

const invalidInput = (message: string) =>
  new ForkCoordinationError({ reason: "invalidInput", message });

const storageFailed = (message: string) =>
  new ForkCoordinationError({ reason: "storageFailed", message });

class CoordinationFsError extends Schema.TaggedError<CoordinationFsError>()("CoordinationFsError", {
  code: Schema.UndefinedOr(Schema.String),
  cause: Schema.Defect(),
}) {}

const errnoCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : undefined
    : undefined;

const attemptFs = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new CoordinationFsError({ code: errnoCode(cause), cause }),
  });

const failStorageWithLog = (publicMessage: string, logMessage: string, cause: unknown) =>
  Effect.logWarning(logMessage, { cause }).pipe(
    Effect.andThen(Effect.fail(storageFailed(publicMessage))),
  );

const tryFs = <A>(run: () => Promise<A>, publicMessage: string, logMessage: string) =>
  attemptFs(run).pipe(
    Effect.catch((error) => failStorageWithLog(publicMessage, logMessage, error.cause)),
  );

async function readRegularBounded(
  handle: NodeFSP.FileHandle,
  maxBytes: number,
): Promise<
  | { readonly kind: "ok"; readonly text: string }
  | { readonly kind: "notFile" }
  | { readonly kind: "tooLarge" }
> {
  const info = await handle.stat();
  if (!info.isFile()) return { kind: "notFile" };
  if (info.size > maxBytes) return { kind: "tooLarge" };
  // Read up to maxBytes + 1 so concurrent growth past the cap is caught without trusting stat alone.
  const buffer = new Uint8Array(maxBytes + 1);
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  if (total > maxBytes) return { kind: "tooLarge" };
  return { kind: "ok", text: new TextDecoder("utf-8").decode(buffer.subarray(0, total)) };
}

async function writeAll(handle: NodeFSP.FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
    if (bytesWritten <= 0) throw new Error("Short write while persisting coordination store.");
    offset += bytesWritten;
  }
}

async function syncDirectoryBestEffort(dirPath: string): Promise<void> {
  let handle: NodeFSP.FileHandle | undefined;
  try {
    handle = await NodeFSP.open(
      dirPath,
      NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
    );
    await handle.sync();
  } catch {
    // Some filesystems disallow directory fsync; the atomic rename already landed.
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** @public */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const writeLock = yield* Semaphore.make(1);

  const resolvedStateDir = path.resolve(config.stateDir);
  const forkDir = path.resolve(resolvedStateDir, "fork");
  const filePath = path.resolve(forkDir, "coordination.json");
  if (path.dirname(filePath) !== forkDir || path.dirname(forkDir) !== resolvedStateDir) {
    return yield* storageFailed("Coordination store path is invalid.");
  }

  const ensureSafeForkDir = Effect.fn("ForkCoordination.ensureSafeForkDir")(function* (options: {
    readonly create: boolean;
  }) {
    const existing = yield* attemptFs(() => NodeFSP.lstat(forkDir)).pipe(
      Effect.catch((error) =>
        error.code === "ENOENT"
          ? Effect.succeed(null)
          : failStorageWithLog(
              "Could not access coordination store directory.",
              "fork coordination lstat failed on fork directory",
              error.cause,
            ),
      ),
    );

    if (existing === null) {
      if (!options.create) return false;
      yield* tryFs(
        () => NodeFSP.mkdir(resolvedStateDir, { recursive: true }),
        "Could not prepare coordination store directory.",
        "fork coordination mkdir failed on stateDir",
      );
      yield* attemptFs(() => NodeFSP.mkdir(forkDir, { mode: 0o700 })).pipe(
        Effect.catch((error) =>
          error.code === "EEXIST"
            ? Effect.void
            : failStorageWithLog(
                "Could not prepare coordination store directory.",
                "fork coordination mkdir failed on fork directory",
                error.cause,
              ),
        ),
      );
    }

    const dirInfo = yield* tryFs(
      () => NodeFSP.lstat(forkDir),
      "Could not inspect coordination store directory.",
      "fork coordination lstat failed after preparing fork directory",
    );
    if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) {
      return yield* failStorageWithLog(
        "Coordination store directory is invalid.",
        "fork coordination refused non-directory or symlink fork directory",
        { isSymlink: dirInfo.isSymbolicLink(), isDirectory: dirInfo.isDirectory() },
      );
    }

    const [realState, realFork] = yield* tryFs(
      () => Promise.all([NodeFSP.realpath(resolvedStateDir), NodeFSP.realpath(forkDir)]),
      "Could not verify coordination store directory.",
      "fork coordination realpath check failed",
    );
    if (path.dirname(realFork) !== realState || path.basename(realFork) !== "fork") {
      return yield* failStorageWithLog(
        "Coordination store directory is invalid.",
        "fork coordination resolved fork directory escaped state directory",
        { realState, realFork },
      );
    }

    if (options.create && platform !== "win32") {
      yield* tryFs(
        () => NodeFSP.chmod(forkDir, 0o700),
        "Could not secure coordination store directory.",
        "fork coordination chmod 0700 failed on fork directory",
      );
    }

    return true;
  });

  const readBoard = Effect.fn("ForkCoordination.readBoard")(function* () {
    const dirExists = yield* ensureSafeForkDir({ create: false });
    if (!dirExists) return EMPTY_COORDINATION_BOARD;

    const opened = yield* attemptFs(() => NodeFSP.open(filePath, READ_FLAGS)).pipe(
      Effect.catch((error) =>
        error.code === "ENOENT"
          ? Effect.succeed(null)
          : failStorageWithLog(
              "Could not read coordination store.",
              "fork coordination open failed for read",
              error.cause,
            ),
      ),
    );
    if (opened === null) return EMPTY_COORDINATION_BOARD;

    const readResult = yield* Effect.ensuring(
      tryFs(
        () => readRegularBounded(opened, FORK_COORDINATION_MAX_FILE_BYTES),
        "Could not read coordination store.",
        "fork coordination bounded read failed",
      ),
      Effect.promise(() => opened.close().catch(() => {})),
    );

    if (readResult.kind === "notFile") {
      return yield* failStorageWithLog(
        "Coordination store is not a regular file.",
        "fork coordination refused non-regular file on read",
        { kind: readResult.kind },
      );
    }
    if (readResult.kind === "tooLarge") {
      return yield* new ForkCoordinationError({
        reason: "limitExceeded",
        message: `Coordination store exceeds the ${FORK_COORDINATION_MAX_FILE_BYTES}-byte limit.`,
      });
    }

    return yield* decodeStoredCoordinationBoard(readResult.text).pipe(
      Effect.catch((error) =>
        failStorageWithLog(
          "Coordination store is invalid.",
          "fork coordination store decode failed",
          error,
        ),
      ),
    );
  });

  const writeBoard = Effect.fn("ForkCoordination.writeBoard")(function* (
    board: StoredCoordinationBoard,
  ) {
    const serialized = serializeBoard(board);
    if (!serialized.ok) return yield* serialized.error;

    yield* ensureSafeForkDir({ create: true });

    const existingFile = yield* attemptFs(() => NodeFSP.lstat(filePath)).pipe(
      Effect.catch((error) =>
        error.code === "ENOENT"
          ? Effect.succeed(null)
          : failStorageWithLog(
              "Could not inspect coordination store.",
              "fork coordination lstat failed on target file",
              error.cause,
            ),
      ),
    );
    if (existingFile !== null && (existingFile.isSymbolicLink() || !existingFile.isFile())) {
      return yield* failStorageWithLog(
        "Coordination store target is not a regular file.",
        "fork coordination refused symlink or non-regular file on write",
        { isSymlink: existingFile.isSymbolicLink(), isFile: existingFile.isFile() },
      );
    }

    const tempPath = path.join(forkDir, `.coordination.${SecureRandom.uuidV4Unsafe()}.tmp`);
    const bytes = new TextEncoder().encode(serialized.json);
    let renamed = false;

    yield* Effect.ensuring(
      Effect.gen(function* () {
        const handle = yield* tryFs(
          () => NodeFSP.open(tempPath, WRITE_TEMP_FLAGS, 0o600),
          "Could not persist coordination store.",
          "fork coordination open temp file failed",
        );
        yield* Effect.ensuring(
          tryFs(
            async () => {
              if (platform !== "win32") {
                await handle.chmod(0o600);
              }
              await writeAll(handle, bytes);
              await handle.sync();
            },
            "Could not persist coordination store.",
            "fork coordination temp file write/sync failed",
          ),
          Effect.promise(() => handle.close().catch(() => {})),
        );
        yield* tryFs(
          () => NodeFSP.rename(tempPath, filePath),
          "Could not persist coordination store.",
          "fork coordination atomic rename failed",
        );
        renamed = true;
        if (platform !== "win32") {
          yield* Effect.promise(() => syncDirectoryBestEffort(forkDir));
        }
      }),
      Effect.suspend(() =>
        renamed ? Effect.void : Effect.promise(() => NodeFSP.unlink(tempPath).catch(() => {})),
      ),
    );
  });

  const list = Effect.fn("ForkCoordination.list")(function* (input: ForkCoordinationListInput) {
    const parsed = yield* decodeListInput(input).pipe(
      Effect.mapError(() => invalidInput("Invalid coordination filter.")),
    );
    const board = yield* writeLock.withPermits(1)(readBoard());
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
      Effect.mapError(() => invalidInput("Invalid coordination id.")),
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
