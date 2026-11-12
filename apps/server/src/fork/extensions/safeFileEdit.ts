// @effect-diagnostics nodeBuiltinImport:off - sha256 of the config text has no Effect equivalent.
import * as NodeCrypto from "node:crypto";

import { ForkExtensionsError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

/** Fingerprint used for a file that does not exist yet. */
const ABSENT_FINGERPRINT = "absent";

const BACKUPS_TO_KEEP = 5;

export interface FileSnapshot {
  readonly text: string;
  readonly fingerprint: string;
}

const sha256 = (text: string): string => NodeCrypto.createHash("sha256").update(text).digest("hex");

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

/** Reads a file and fingerprints it; a missing file reads as `{ "", "absent" }`. */
export const readWithFingerprint = Effect.fn("ForkExtensions.readWithFingerprint")(function* (
  path: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs.exists(path).pipe(Effect.mapError((cause) => fileProblem(path, cause)));
  if (!exists) {
    return { text: "", fingerprint: ABSENT_FINGERPRINT } satisfies FileSnapshot;
  }
  const text = yield* fs
    .readFileString(path)
    .pipe(Effect.mapError((cause) => fileProblem(path, cause)));
  return { text, fingerprint: sha256(text) } satisfies FileSnapshot;
});

const pruneBackups = Effect.fn("ForkExtensions.pruneBackups")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const directory = pathService.dirname(path);
  const prefix = `${pathService.basename(path)}.t3-`;
  const names = yield* fs.readDirectory(directory);
  // The fixed-width UTC stamp sorts lexicographically in chronological order.
  const backups = names
    .filter((name) => name.startsWith(prefix) && name.endsWith(".bak"))
    .toSorted();
  for (const stale of backups.slice(0, Math.max(0, backups.length - BACKUPS_TO_KEEP))) {
    yield* fs.remove(pathService.join(directory, stale));
  }
});

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
  const current = yield* readWithFingerprint(path);
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
  const temporaryPath = `${path}.t3-tmp`;
  yield* Effect.gen(function* () {
    if (expectedFingerprint !== ABSENT_FINGERPRINT) {
      yield* fs.writeFileString(`${path}.t3-${backupStamp(now)}.bak`, current.text);
    }
    yield* fs.makeDirectory(pathService.dirname(path), { recursive: true });
    yield* fs.writeFileString(temporaryPath, nextText);
    yield* fs.rename(temporaryPath, path);
    yield* pruneBackups(path);
  }).pipe(
    Effect.tapError(() => fs.remove(temporaryPath, { force: true }).pipe(Effect.ignore)),
    Effect.mapError((cause) => fileProblem(path, cause)),
  );
});
