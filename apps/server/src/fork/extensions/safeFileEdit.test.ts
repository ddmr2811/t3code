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

  it.effect("serializes concurrent writes: one wins, the other gets configChanged", () =>
    withTempFile(({ fs, dir, file }) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(file, "a = 1\n");
        const read = yield* readWithFingerprint(file);
        const results = yield* Effect.all(
          [
            writeIfUnchanged(file, read.fingerprint, "winner = 1\n", alwaysValid).pipe(
              Effect.result,
            ),
            writeIfUnchanged(file, read.fingerprint, "winner = 2\n", alwaysValid).pipe(
              Effect.result,
            ),
          ],
          { concurrency: 2 },
        );
        const failures = results.flatMap((result) =>
          result._tag === "Failure" ? [result.failure] : [],
        );
        expect(failures).toHaveLength(1);
        expect(failures[0]?.problem.reason).toBe("configChanged");
        expect(["winner = 1\n", "winner = 2\n"]).toContain(yield* fs.readFileString(file));
        expect((yield* fs.readDirectory(dir)).filter((name) => name.includes("tmp"))).toEqual([]);
      }),
    ),
  );

  it.effect("does not overwrite a backup made in the same second", () =>
    withTempFile(({ fs, file }) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(file, "original\n");
        yield* TestClock.setTime(Date.UTC(2026, 0, 1, 0, 0, 1));
        let read = yield* readWithFingerprint(file);
        yield* writeIfUnchanged(file, read.fingerprint, "second\n", alwaysValid);
        read = yield* readWithFingerprint(file);
        yield* writeIfUnchanged(file, read.fingerprint, "third\n", alwaysValid);
        expect(yield* fs.readFileString(`${file}.t3-20260101-000001.bak`)).toBe("original\n");
        expect(yield* fs.readFileString(`${file}.t3-20260101-000001-1.bak`)).toBe("second\n");
      }),
    ),
  );

  it.effect("preserves a leading UTF-8 BOM", () =>
    withTempFile(({ fs, file }) =>
      Effect.gen(function* () {
        const original = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("a = 1\n")]);
        yield* fs.writeFile(file, original);
        const read = yield* readWithFingerprint(file);
        expect(read.text).toBe("a = 1\n");
        yield* writeIfUnchanged(file, read.fingerprint, "a = 2\n", alwaysValid);
        const bytes = yield* fs.readFile(file);
        expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
        expect(new TextDecoder().decode(bytes.subarray(3))).toBe("a = 2\n");
      }),
    ),
  );

  it.effect("rejects a file that is not valid UTF-8 without touching it", () =>
    withTempFile(({ fs, dir, file }) =>
      Effect.gen(function* () {
        const bad = new Uint8Array([0x61, 0x3d, 0xff, 0xfe, 0x0a]);
        yield* fs.writeFile(file, bad);
        const error = yield* readWithFingerprint(file).pipe(Effect.flip);
        expect(error.problem.reason).toBe("invalidInput");
        expect(error.problem.nextStep).toBe("Save it as UTF-8 and try again.");
        const writeError = yield* writeIfUnchanged(file, "whatever", "a = 1\n", alwaysValid).pipe(
          Effect.flip,
        );
        expect(writeError.problem.reason).toBe("invalidInput");
        expect([...(yield* fs.readFile(file))]).toEqual([...bad]);
        expect(yield* fs.readDirectory(dir)).toEqual(["config.toml"]);
      }),
    ),
  );
});
