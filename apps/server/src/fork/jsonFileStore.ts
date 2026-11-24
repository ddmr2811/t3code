// @effect-diagnostics nodeBuiltinImport:off -- O_NOFOLLOW, O_NONBLOCK, lstat, realpath, and O_CREAT|O_EXCL 0600 require direct fs flags.
// Fork-only: one bounded JSON document per file in `<stateDir>/fork/`, written atomically with 0600/0700.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

const READ_FLAGS =
  NodeFS.constants.O_RDONLY |
  (NodeFS.constants.O_NOFOLLOW ?? 0) |
  (NodeFS.constants.O_NONBLOCK ?? 0);
const WRITE_TEMP_FLAGS =
  NodeFS.constants.O_CREAT |
  NodeFS.constants.O_EXCL |
  NodeFS.constants.O_WRONLY |
  (NodeFS.constants.O_NOFOLLOW ?? 0);

class ForkFsError extends Schema.TaggedError<ForkFsError>()("ForkFsError", {
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
    catch: (cause) => new ForkFsError({ code: errnoCode(cause), cause }),
  });

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
    if (bytesWritten <= 0) throw new Error("Short write while persisting fork store.");
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

// The stored values are plain schema-decoded data, so stringify cannot throw here.
const prettyJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

type ForkStoreFailureReason = "storageFailed" | "limitExceeded";

/**
 * Callers keep their own lock around read-modify-write; this only guarantees each read and
 * write is bounded, symlink-safe, and atomic. Public error messages never include paths.
 */
export const makeForkJsonFileStore = Effect.fn("ForkJsonFileStore.make")(function* <S, E>(options: {
  /** File name inside `<stateDir>/fork/`, e.g. `bots.json`. */
  readonly fileName: string;
  /** Capitalized noun for public errors, e.g. `Bot store`. */
  readonly label: string;
  readonly maxBytes: number;
  readonly empty: S;
  readonly decode: (text: string) => Effect.Effect<S, Schema.SchemaError>;
  readonly makeError: (reason: ForkStoreFailureReason, message: string) => E;
}) {
  const { fileName, label, maxBytes, makeError } = options;
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const logPrefix = `fork ${fileName}`;
  const lowerLabel = label.toLowerCase();

  const failStorage = (publicMessage: string, logMessage: string, cause: unknown) =>
    Effect.logWarning(`${logPrefix} ${logMessage}`, { cause }).pipe(
      Effect.andThen(Effect.fail(makeError("storageFailed", publicMessage))),
    );
  const tryFs = <A>(run: () => Promise<A>, publicMessage: string, logMessage: string) =>
    attemptFs(run).pipe(
      Effect.catch((error) => failStorage(publicMessage, logMessage, error.cause)),
    );

  const resolvedStateDir = path.resolve(config.stateDir);
  const forkDir = path.resolve(resolvedStateDir, "fork");
  const filePath = path.resolve(forkDir, fileName);
  if (path.dirname(filePath) !== forkDir || path.dirname(forkDir) !== resolvedStateDir) {
    return yield* Effect.fail(makeError("storageFailed", `${label} path is invalid.`));
  }

  const ensureSafeForkDir = Effect.fn("ForkJsonFileStore.ensureSafeForkDir")(function* (
    create: boolean,
  ) {
    const existing = yield* attemptFs(() => NodeFSP.lstat(forkDir)).pipe(
      Effect.catch((error) =>
        error.code === "ENOENT"
          ? Effect.succeed(null)
          : failStorage(
              `Could not access ${lowerLabel} directory.`,
              "lstat failed on fork directory",
              error.cause,
            ),
      ),
    );
    if (existing === null) {
      if (!create) return false;
      yield* tryFs(
        () => NodeFSP.mkdir(resolvedStateDir, { recursive: true }),
        `Could not prepare ${lowerLabel} directory.`,
        "mkdir failed on stateDir",
      );
      yield* attemptFs(() => NodeFSP.mkdir(forkDir, { mode: 0o700 })).pipe(
        Effect.catch((error) =>
          error.code === "EEXIST"
            ? Effect.void
            : failStorage(
                `Could not prepare ${lowerLabel} directory.`,
                "mkdir failed on fork directory",
                error.cause,
              ),
        ),
      );
    }
    const dirInfo = yield* tryFs(
      () => NodeFSP.lstat(forkDir),
      `Could not inspect ${lowerLabel} directory.`,
      "lstat failed after preparing fork directory",
    );
    if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) {
      return yield* failStorage(
        `${label} directory is invalid.`,
        "refused non-directory or symlink fork directory",
        { isSymlink: dirInfo.isSymbolicLink(), isDirectory: dirInfo.isDirectory() },
      );
    }
    const [realState, realFork] = yield* tryFs(
      () => Promise.all([NodeFSP.realpath(resolvedStateDir), NodeFSP.realpath(forkDir)]),
      `Could not verify ${lowerLabel} directory.`,
      "realpath check failed",
    );
    if (path.dirname(realFork) !== realState || path.basename(realFork) !== "fork") {
      return yield* failStorage(
        `${label} directory is invalid.`,
        "resolved fork directory escaped state directory",
        { realState, realFork },
      );
    }
    if (create && platform !== "win32") {
      yield* tryFs(
        () => NodeFSP.chmod(forkDir, 0o700),
        `Could not secure ${lowerLabel} directory.`,
        "chmod 0700 failed on fork directory",
      );
    }
    return true;
  });

  const read = Effect.fn("ForkJsonFileStore.read")(function* () {
    if (!(yield* ensureSafeForkDir(false))) return options.empty;
    const opened = yield* attemptFs(() => NodeFSP.open(filePath, READ_FLAGS)).pipe(
      Effect.catch((error) =>
        error.code === "ENOENT"
          ? Effect.succeed(null)
          : failStorage(`Could not read ${lowerLabel}.`, "open failed for read", error.cause),
      ),
    );
    if (opened === null) return options.empty;
    const result = yield* Effect.ensuring(
      tryFs(
        () => readRegularBounded(opened, maxBytes),
        `Could not read ${lowerLabel}.`,
        "bounded read failed",
      ),
      Effect.promise(() => opened.close().catch(() => {})),
    );
    if (result.kind === "notFile") {
      return yield* failStorage(
        `${label} is not a regular file.`,
        "refused non-regular file on read",
        { kind: result.kind },
      );
    }
    if (result.kind === "tooLarge") {
      return yield* Effect.fail(
        makeError("limitExceeded", `${label} exceeds the ${maxBytes}-byte limit.`),
      );
    }
    return yield* options
      .decode(result.text)
      .pipe(Effect.catch((error) => failStorage(`${label} is invalid.`, "decode failed", error)));
  });

  const write = Effect.fn("ForkJsonFileStore.write")(function* (value: S) {
    const bytes = new TextEncoder().encode(prettyJson(value));
    if (bytes.byteLength > maxBytes) {
      yield* Effect.logWarning(`${logPrefix} write refused: ${bytes.byteLength} bytes`);
      return yield* Effect.fail(
        makeError("limitExceeded", `${label} exceeds the ${maxBytes}-byte limit.`),
      );
    }
    yield* ensureSafeForkDir(true);
    const existingFile = yield* attemptFs(() => NodeFSP.lstat(filePath)).pipe(
      Effect.catch((error) =>
        error.code === "ENOENT"
          ? Effect.succeed(null)
          : failStorage(
              `Could not inspect ${lowerLabel}.`,
              "lstat failed on target file",
              error.cause,
            ),
      ),
    );
    if (existingFile !== null && (existingFile.isSymbolicLink() || !existingFile.isFile())) {
      return yield* failStorage(
        `${label} target is not a regular file.`,
        "refused symlink or non-regular file on write",
        { isSymlink: existingFile.isSymbolicLink(), isFile: existingFile.isFile() },
      );
    }

    const tempPath = path.join(forkDir, `.${fileName}.${SecureRandom.uuidV4Unsafe()}.tmp`);
    const persistFailed = `Could not persist ${lowerLabel}.`;
    let renamed = false;
    yield* Effect.ensuring(
      Effect.gen(function* () {
        const handle = yield* tryFs(
          () => NodeFSP.open(tempPath, WRITE_TEMP_FLAGS, 0o600),
          persistFailed,
          "open temp file failed",
        );
        yield* Effect.ensuring(
          tryFs(
            async () => {
              if (platform !== "win32") await handle.chmod(0o600);
              await writeAll(handle, bytes);
              await handle.sync();
            },
            persistFailed,
            "temp file write/sync failed",
          ),
          Effect.promise(() => handle.close().catch(() => {})),
        );
        yield* tryFs(
          () => NodeFSP.rename(tempPath, filePath),
          persistFailed,
          "atomic rename failed",
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
