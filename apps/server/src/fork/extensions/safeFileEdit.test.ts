import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ForkExtensionsError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import { readWithFingerprint, writeIfUnchanged } from "./safeFileEdit.ts";

const alwaysValid = () => true;

const withTempFile = <A, E, R>(
  body: (input: {
    readonly fs: FileSystem.FileSystem;
    readonly dir: string;
    readonly file: string;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-safe-edit-" });
    return yield* body({ fs, dir, file: path.join(dir, "config.toml") });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("safeFileEdit", () => {
  it.effect("writeIfUnchanged aborts with configChanged when the file changed after reading", () =>
    withTempFile(({ fs, file }) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(file, "a = 1\n");
        const read = yield* readWithFingerprint(file);
        yield* fs.writeFileString(file, "a = 2 # edited from the terminal\n");
        const error = yield* writeIfUnchanged(file, read.fingerprint, "a = 3\n", alwaysValid).pipe(
          Effect.flip,
        );
        expect(error).toBeInstanceOf(ForkExtensionsError);
        expect(error.problem.reason).toBe("configChanged");
        expect(error.problem.nextStep).toBe("Refresh the page and try again.");
        expect(yield* fs.readFileString(file)).toBe("a = 2 # edited from the terminal\n");
      }),
    ),
  );

  it.effect("writes atomically and leaves a .bak", () =>
    withTempFile(({ fs, dir, file }) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(file, "a = 1\n");
        yield* TestClock.setTime(Date.UTC(2026, 10, 12, 9, 8, 7));
        const read = yield* readWithFingerprint(file);
        yield* writeIfUnchanged(file, read.fingerprint, "a = 2\n", alwaysValid);
        expect(yield* fs.readFileString(file)).toBe("a = 2\n");
        const entries = yield* fs.readDirectory(dir);
        expect(entries.toSorted()).toEqual(["config.toml", "config.toml.t3-20261112-090807.bak"]);
        expect(yield* fs.readFileString(`${file}.t3-20261112-090807.bak`)).toBe("a = 1\n");
      }),
    ),
  );

  it.effect("rejects invalid output with invalidInput and leaves the file alone", () =>
    withTempFile(({ fs, dir, file }) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(file, "a = 1\n");
        const read = yield* readWithFingerprint(file);
        const error = yield* writeIfUnchanged(file, read.fingerprint, "oops", () => false).pipe(
          Effect.flip,
        );
        expect(error.problem.reason).toBe("invalidInput");
        expect(yield* fs.readFileString(file)).toBe("a = 1\n");
        expect(yield* fs.readDirectory(dir)).toEqual(["config.toml"]);
      }),
    ),
  );

  it.effect("keeps only the 5 most recent backups", () =>
    withTempFile(({ fs, dir, file }) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(file, "v0\n");
        for (let i = 1; i <= 7; i += 1) {
          yield* TestClock.setTime(Date.UTC(2026, 0, 1, 0, 0, i));
          const read = yield* readWithFingerprint(file);
          yield* writeIfUnchanged(file, read.fingerprint, `v${i}\n`, alwaysValid);
        }
        const backups = (yield* fs.readDirectory(dir)).filter((name) => name.endsWith(".bak"));
        expect(backups.toSorted()).toEqual([
          "config.toml.t3-20260101-000003.bak",
          "config.toml.t3-20260101-000004.bak",
          "config.toml.t3-20260101-000005.bak",
          "config.toml.t3-20260101-000006.bak",
          "config.toml.t3-20260101-000007.bak",
        ]);
      }),
    ),
  );

  it.effect("treats a missing file as absent and skips the .bak", () =>
    withTempFile(({ fs, dir, file }) =>
      Effect.gen(function* () {
        const read = yield* readWithFingerprint(file);
        expect(read).toEqual({ text: "", fingerprint: "absent" });
        yield* writeIfUnchanged(file, read.fingerprint, "a = 1\n", alwaysValid);
        expect(yield* fs.readFileString(file)).toBe("a = 1\n");
        expect(yield* fs.readDirectory(dir)).toEqual(["config.toml"]);
      }),
    ),
  );

  it.effect("absent fingerprint aborts with configChanged when the file appeared", () =>
    withTempFile(({ fs, file }) =>
      Effect.gen(function* () {
        const read = yield* readWithFingerprint(file);
        yield* fs.writeFileString(file, "created = true\n");
        const error = yield* writeIfUnchanged(file, read.fingerprint, "a = 1\n", alwaysValid).pipe(
          Effect.flip,
        );
        expect(error.problem.reason).toBe("configChanged");
        expect(yield* fs.readFileString(file)).toBe("created = true\n");
      }),
    ),
  );
});
