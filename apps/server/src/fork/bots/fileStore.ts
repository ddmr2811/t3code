// @effect-diagnostics nodeBuiltinImport:off -- O_NOFOLLOW, O_NONBLOCK, lstat, realpath, and O_CREAT|O_EXCL 0600 require direct fs flags.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import { FORK_BOTS_MAX_FILE_BYTES, ForkBotsError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import {
  decodeStoredBotDirectory,
  EMPTY_BOT_DIRECTORY,
  serializeBotDirectory,
  type StoredBotDirectory,
} from "./store.ts";

const READ_FLAGS =
  NodeFS.constants.O_RDONLY |
  (NodeFS.constants.O_NOFOLLOW ?? 0) |
  (NodeFS.constants.O_NONBLOCK ?? 0);
const WRITE_TEMP_FLAGS =
  NodeFS.constants.O_CREAT |
  NodeFS.constants.O_EXCL |
  NodeFS.constants.O_WRONLY |
  (NodeFS.constants.O_NOFOLLOW ?? 0);

const storageFailed = (message: string) => new ForkBotsError({ reason: "storageFailed", message });

class BotFsError extends Schema.TaggedError<BotFsError>()("BotFsError", {
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
    catch: (cause) => new BotFsError({ code: errnoCode(cause), cause }),
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
): Promise<
  | { readonly kind: "ok"; readonly text: string }
  | { readonly kind: "notFile" }
  | { readonly kind: "tooLarge" }
> {
  const info = await handle.stat();
  if (!info.isFile()) return { kind: "notFile" };
  if (info.size > FORK_BOTS_MAX_FILE_BYTES) return { kind: "tooLarge" };
  const buffer = new Uint8Array(FORK_BOTS_MAX_FILE_BYTES + 1);
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  if (total > FORK_BOTS_MAX_FILE_BYTES) return { kind: "tooLarge" };
  return { kind: "ok", text: new TextDecoder("utf-8").decode(buffer.subarray(0, total)) };
}

async function writeAll(handle: NodeFSP.FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
    if (bytesWritten <= 0) throw new Error("Short write while persisting bot directory.");
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

export const makeBotFileStore = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const resolvedStateDir = path.resolve(config.stateDir);
  const forkDir = path.resolve(resolvedStateDir, "fork");
  const filePath = path.resolve(forkDir, "bots.json");
  if (path.dirname(filePath) !== forkDir || path.dirname(forkDir) !== resolvedStateDir) {
    return yield* storageFailed("Bot store path is invalid.");
  }

  const ensureSafeForkDir = Effect.fn("ForkBots.ensureSafeForkDir")(function* (options: {
    readonly create: boolean;
  }) {
    const existing = yield* attemptFs(() => NodeFSP.lstat(forkDir)).pipe(
      Effect.catch((error) =>
        error.code === "ENOENT"
          ? Effect.succeed(null)
          : failStorageWithLog(
              "Could not access bot store directory.",
              "fork bots lstat failed on fork directory",
              error.cause,
            ),
      ),
    );
    if (existing === null) {
      if (!options.create) return false;
      yield* tryFs(
        () => NodeFSP.mkdir(resolvedStateDir, { recursive: true }),
        "Could not prepare bot store directory.",
        "fork bots mkdir failed on stateDir",
      );
      yield* attemptFs(() => NodeFSP.mkdir(forkDir, { mode: 0o700 })).pipe(
        Effect.catch((error) =>
          error.code === "EEXIST"
            ? Effect.void
            : failStorageWithLog(
                "Could not prepare bot store directory.",
                "fork bots mkdir failed on fork directory",
                error.cause,
              ),
        ),
      );
    }

    const dirInfo = yield* tryFs(
      () => NodeFSP.lstat(forkDir),
      "Could not inspect bot store directory.",
      "fork bots lstat failed after preparing fork directory",
    );
    if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) {
      return yield* failStorageWithLog(
        "Bot store directory is invalid.",
        "fork bots refused non-directory or symlink fork directory",
        { isSymlink: dirInfo.isSymbolicLink(), isDirectory: dirInfo.isDirectory() },
      );
    }
    const [realState, realFork] = yield* tryFs(
      () => Promise.all([NodeFSP.realpath(resolvedStateDir), NodeFSP.realpath(forkDir)]),
      "Could not verify bot store directory.",
      "fork bots realpath check failed",
    );
    if (path.dirname(realFork) !== realState || path.basename(realFork) !== "fork") {
      return yield* failStorageWithLog(
        "Bot store directory is invalid.",
        "fork bots resolved fork directory escaped state directory",
        { realState, realFork },
      );
    }
    if (options.create && platform !== "win32") {
      yield* tryFs(
        () => NodeFSP.chmod(forkDir, 0o700),
        "Could not secure bot store directory.",
        "fork bots chmod 0700 failed on fork directory",
      );
    }
    return true;
  });

  const read = Effect.fn("ForkBots.readDirectory")(function* () {
    const dirExists = yield* ensureSafeForkDir({ create: false });
    if (!dirExists) return EMPTY_BOT_DIRECTORY;
    const opened = yield* attemptFs(() => NodeFSP.open(filePath, READ_FLAGS)).pipe(
      Effect.catch((error) =>
        error.code === "ENOENT"
          ? Effect.succeed(null)
          : failStorageWithLog(
              "Could not read bot store.",
              "fork bots open failed for read",
              error.cause,
            ),
      ),
    );
    if (opened === null) return EMPTY_BOT_DIRECTORY;
    const result = yield* Effect.ensuring(
      tryFs(
        () => readRegularBounded(opened),
        "Could not read bot store.",
        "fork bots bounded read failed",
      ),
      Effect.promise(() => opened.close().catch(() => {})),
    );
    if (result.kind === "notFile") {
      return yield* failStorageWithLog(
        "Bot store is not a regular file.",
        "fork bots refused non-regular file on read",
        { kind: result.kind },
      );
    }
    if (result.kind === "tooLarge") {
      return yield* new ForkBotsError({
        reason: "limitExceeded",
        message: `Bot store exceeds the ${FORK_BOTS_MAX_FILE_BYTES}-byte limit.`,
      });
    }
    return yield* decodeStoredBotDirectory(result.text).pipe(
      Effect.catch((error) =>
        failStorageWithLog("Bot store is invalid.", "fork bots store decode failed", error),
      ),
    );
  });

  const write = Effect.fn("ForkBots.writeDirectory")(function* (directory: StoredBotDirectory) {
    const serialized = serializeBotDirectory(directory);
    if (!serialized.ok) return yield* serialized.error;
    yield* ensureSafeForkDir({ create: true });
    const existingFile = yield* attemptFs(() => NodeFSP.lstat(filePath)).pipe(
      Effect.catch((error) =>
        error.code === "ENOENT"
          ? Effect.succeed(null)
          : failStorageWithLog(
              "Could not inspect bot store.",
              "fork bots lstat failed on target file",
              error.cause,
            ),
      ),
    );
    if (existingFile !== null && (existingFile.isSymbolicLink() || !existingFile.isFile())) {
      return yield* failStorageWithLog(
        "Bot store target is not a regular file.",
        "fork bots refused symlink or non-regular file on write",
        { isSymlink: existingFile.isSymbolicLink(), isFile: existingFile.isFile() },
      );
    }

    const tempPath = path.join(forkDir, `.bots.${SecureRandom.uuidV4Unsafe()}.tmp`);
    const bytes = new TextEncoder().encode(serialized.json);
    let renamed = false;
    yield* Effect.ensuring(
      Effect.gen(function* () {
        const handle = yield* tryFs(
          () => NodeFSP.open(tempPath, WRITE_TEMP_FLAGS, 0o600),
          "Could not persist bot store.",
          "fork bots open temp file failed",
        );
        yield* Effect.ensuring(
          tryFs(
            async () => {
              if (platform !== "win32") await handle.chmod(0o600);
              await writeAll(handle, bytes);
              await handle.sync();
            },
            "Could not persist bot store.",
            "fork bots temp file write/sync failed",
          ),
          Effect.promise(() => handle.close().catch(() => {})),
        );
        yield* tryFs(
          () => NodeFSP.rename(tempPath, filePath),
          "Could not persist bot store.",
          "fork bots atomic rename failed",
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

  return { read, write };
});
