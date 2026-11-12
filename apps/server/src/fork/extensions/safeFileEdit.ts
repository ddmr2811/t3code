// @effect-diagnostics nodeBuiltinImport:off - sha256 of the config text has no Effect equivalent.
import * as NodeCrypto from "node:crypto";

import { ForkExtensionsError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Semaphore from "effect/Semaphore";

/** Fingerprint used for a file that does not exist yet. */
const ABSENT_FINGERPRINT = "absent";

const BACKUPS_TO_KEEP = 5;

export interface FileSnapshot {
  readonly text: string;
  readonly fingerprint: string;
}

const sha256 = (data: Uint8Array): string =>
  NodeCrypto.createHash("sha256").update(data).digest("hex");

const BOM = [0xef, 0xbb, 0xbf] as const;
const hasBom = (bytes: Uint8Array): boolean => BOM.every((byte, index) => bytes[index] === byte);

const fileProblem = (path: string, cause: PlatformError.PlatformError): ForkExtensionsError =>
  new ForkExtensionsError({
    problem: {
      reason: cause.reason._tag === "PermissionDenied" ? "permissionDenied" : "commandFailed",
      summary: `Could not access ${path}.`,
      nextStep: "Check the file's permissions and that no other program has it locked, then retry.",
      rawOutput: cause.message,
    },
  });

/** `yyyyMMdd-HHmmss` in UTC. */
const backupStamp = (epochMillis: number): string =>
  DateTime.formatIso(DateTime.makeUnsafe(epochMillis))
    .replace(/\.\d+Z$/, "")
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace("T", "-");

interface RawSnapshot extends FileSnapshot {
  readonly bytes: Uint8Array;
  readonly bom: boolean;
}

const readRaw = Effect.fn("ForkExtensions.readRaw")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs.exists(path).pipe(Effect.mapError((cause) => fileProblem(path, cause)));
  if (!exists) {
    return {
      text: "",
      fingerprint: ABSENT_FINGERPRINT,
      bytes: new Uint8Array(),
      bom: false,
    } satisfies RawSnapshot;
  }
  const bytes = yield* fs.readFile(path).pipe(Effect.mapError((cause) => fileProblem(path, cause)));
  const bom = hasBom(bytes);
  const decoded = yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bom ? bytes.subarray(3) : bytes),
    catch: () =>
      new ForkExtensionsError({
        problem: {
          reason: "invalidInput",
          summary: `${path} is not valid UTF-8; T3 won't edit it.`,
          nextStep: "Save it as UTF-8 and try again.",
          rawOutput: null,
        },
      }),
  });
  return { text: decoded, fingerprint: sha256(bytes), bytes, bom } satisfies RawSnapshot;
});

/** Reads a file and fingerprints its bytes; a missing file reads as `{ "", "absent" }`. */
export const readWithFingerprint = Effect.fn("ForkExtensions.readWithFingerprint")(function* (
  path: string,
) {
  const { text, fingerprint } = yield* readRaw(path);
  return { text, fingerprint } satisfies FileSnapshot;
});

const BACKUP_NAME = /\.t3-(\d{8}-\d{6})(?:-(\d+))?\.bak$/;

const pruneBackups = Effect.fn("ForkExtensions.pruneBackups")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const directory = pathService.dirname(path);
  const prefix = `${pathService.basename(path)}.t3-`;
  const names = yield* fs.readDirectory(directory);
  const backups = names
    .filter((name) => name.startsWith(prefix))
    .flatMap((name) => {
      const match = BACKUP_NAME.exec(name);
      return match === null ? [] : [{ name, stamp: match[1]!, sequence: Number(match[2] ?? 0) }];
    })
    .toSorted((a, b) => a.stamp.localeCompare(b.stamp) || a.sequence - b.sequence);
  for (const stale of backups.slice(0, Math.max(0, backups.length - BACKUPS_TO_KEEP))) {
    yield* fs.remove(pathService.join(directory, stale.name));
  }
});

/** Picks a backup path for this second that does not overwrite an earlier backup. */
const freeBackupPath = Effect.fn("ForkExtensions.freeBackupPath")(function* (
  path: string,
  now: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const base = `${path}.t3-${backupStamp(now)}`;
  let candidate = `${base}.bak`;
  for (let sequence = 1; yield* fs.exists(candidate); sequence += 1) {
    candidate = `${base}-${sequence}.bak`;
  }
  return candidate;
});

// One lock per file so concurrent edits of the same path run read-compare-write one at a time.
const pathLocks = new Map<string, Semaphore.Semaphore>();
const lockFor = (key: string): Semaphore.Semaphore => {
  let lock = pathLocks.get(key);
  if (lock === undefined) {
    lock = Semaphore.makeUnsafe(1);
    pathLocks.set(key, lock);
  }
  return lock;
};

/**
 * Writes `nextText` only if the file still has the content that was fingerprinted,
 * so edits made from the terminal in the meantime are never overwritten. Keeps a
 * `.bak` of the previous content and swaps the new content in with a rename.
 */
export const writeIfUnchanged = Effect.fn("ForkExtensions.writeIfUnchanged")(function* (
  path: string,
  expectedFingerprint: string,
  nextText: string,
  validate: (text: string) => boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const guarded = Effect.gen(function* () {
    const current = yield* readRaw(path);
    if (current.fingerprint !== expectedFingerprint) {
      return yield* new ForkExtensionsError({
        problem: {
          reason: "configChanged",
          summary: `${pathService.basename(path)} changed while T3 was editing it.`,
          nextStep: "Refresh the page and try again.",
          rawOutput: null,
        },
      });
    }
    if (!validate(nextText)) {
      return yield* new ForkExtensionsError({
        problem: {
          reason: "invalidInput",
          summary: `The edited ${pathService.basename(path)} would not be valid, so it was not saved.`,
          nextStep: "Nothing was changed. Retry, or edit the file by hand.",
          rawOutput: null,
        },
      });
    }

    const now = yield* Clock.currentTimeMillis;
    const temporaryPath = `${path}.t3-tmp-${NodeCrypto.randomUUID().slice(0, 8)}`;
    const encoded = new TextEncoder().encode(nextText);
    const output = new Uint8Array((current.bom ? BOM.length : 0) + encoded.length);
    if (current.bom) output.set(BOM, 0);
    output.set(encoded, current.bom ? BOM.length : 0);
    yield* Effect.gen(function* () {
      if (expectedFingerprint !== ABSENT_FINGERPRINT) {
        yield* fs.writeFile(yield* freeBackupPath(path, now), current.bytes);
      }
      yield* fs.makeDirectory(pathService.dirname(path), { recursive: true });
      yield* fs.writeFile(temporaryPath, output);
      yield* fs.rename(temporaryPath, path);
    }).pipe(
      Effect.tapError(() => fs.remove(temporaryPath, { force: true }).pipe(Effect.ignore)),
      Effect.mapError((cause) => fileProblem(path, cause)),
    );
    // The file is already written; a failed cleanup of old backups must not fail the edit.
    yield* pruneBackups(path).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not prune old config backups", { path, cause }),
      ),
    );
  });
  return yield* lockFor(pathService.resolve(path)).withPermits(1)(guarded);
});
