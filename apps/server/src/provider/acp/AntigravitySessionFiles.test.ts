// @effect-diagnostics nodeBuiltinImport:off -- fixtures write a native session database.
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import {
  removeAntigravitySessionFiles,
  retireAntigravityRuntimeTempDirs,
} from "./AntigravitySessionFiles.ts";

// Only there does a sandboxed agent write the profile, and only there is its `brain` kept.
const sandboxed = HostProcess.Platform.defaultValue() === "linux";
const SESSION_ID = "047c62f6-607b-44db-bfbe-f83b67e9e8b1";
const OTHER_SESSION_ID = "9b2b7a98-28db-4422-9f46-70e106319548";

const varint = (value: number): number[] => {
  const bytes: number[] = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value = Math.floor(value / 0x80);
  }
  return [...bytes, value];
};
const protoField = (number: number, value: string | Uint8Array) => {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return [...varint(number * 8 + 2), ...varint(bytes.length), ...bytes];
};
const proto = (...parts: number[][]) => Uint8Array.from(parts.flat());

function encodeTrajectoryMetadata(input: {
  readonly sessionId?: string;
  readonly workspaceUris: ReadonlyArray<string>;
}) {
  return proto(
    ...input.workspaceUris.map((uri) => protoField(1, proto(protoField(1, uri)))),
    ...(input.sessionId === undefined ? [] : [protoField(6, input.sessionId)]),
    ...input.workspaceUris.map((uri) => protoField(7, uri)),
  );
}

function writeNativeSessionDb(dbPath: string, blob?: Uint8Array) {
  const database = new NodeSqlite.DatabaseSync(dbPath);
  try {
    database.exec("CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB)");
    if (blob !== undefined) {
      database
        .prepare("INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)")
        .run("main", blob);
    }
  } finally {
    database.close();
  }
}

const makeNativeSessionFixture = Effect.fn("makeNativeSessionFixture")(function* (input: {
  readonly sessionId?: string;
  readonly workspacePaths: ReadonlyArray<string>;
  readonly metadataSessionId?: string;
  readonly corruptBlob?: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-session-files-" });
  const profileDirectory = path.join(root, "profile");
  const acpDirectory = path.join(profileDirectory, "antigravity-acp");
  const conversations = path.join(acpDirectory, "conversations");
  const annotations = path.join(acpDirectory, "annotations");
  const sessionId = input.sessionId ?? SESSION_ID;
  const brain = path.join(acpDirectory, "brain", sessionId);
  const base = path.join(conversations, sessionId);
  const annotationFile = path.join(annotations, `${sessionId}.pbtxt`);

  yield* fs.makeDirectory(conversations, { recursive: true });
  yield* fs.makeDirectory(annotations, { recursive: true });
  yield* fs.makeDirectory(brain, { recursive: true });

  const blob = input.corruptBlob
    ? Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff])
    : encodeTrajectoryMetadata({
        sessionId: input.metadataSessionId ?? sessionId,
        workspaceUris: input.workspacePaths.map((entry) => NodeURL.pathToFileURL(entry).href),
      });
  writeNativeSessionDb(`${base}.db`, blob);
  yield* fs.writeFileString(`${base}.db-wal`, "wal");
  yield* fs.writeFileString(`${base}.db-shm`, "shm");
  yield* fs.writeFileString(path.join(brain, "output.txt"), "artifact");
  yield* fs.writeFileString(annotationFile, "annotation");

  return { root, profileDirectory, base, brain, annotationFile, sessionId };
});

it.layer(NodeServices.layer)("removeAntigravitySessionFiles", (it) => {
  it.effect(
    "removes Antigravity 1.5+ session files without a .meta sidecar when the DB matches cwd",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-antigravity-setup-" });
        const realCwd = yield* fs.realPath(cwd);
        const fixture = yield* makeNativeSessionFixture({
          workspacePaths: [realCwd, cwd],
        });

        yield* removeAntigravitySessionFiles({
          profileDirectory: fixture.profileDirectory,
          sessionId: fixture.sessionId,
          cwd,
        });

        expect(yield* fs.exists(`${fixture.base}.db`)).toBe(false);
        expect(yield* fs.exists(`${fixture.base}.db-wal`)).toBe(false);
        expect(yield* fs.exists(`${fixture.base}.db-shm`)).toBe(false);
        expect(yield* fs.exists(fixture.brain)).toBe(sandboxed);
        expect(yield* fs.exists(fixture.annotationFile)).toBe(false);
        expect(yield* fs.exists(path.dirname(fixture.base))).toBe(true);
      }),
  );

  it.effect(
    "leaves another folder alone when the agent put a link where its brain folder goes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "t3-antigravity-setup-" }),
        );
        const fixture = yield* makeNativeSessionFixture({ workspacePaths: [cwd] });
        const elsewhere = yield* fs.makeTempDirectoryScoped({ prefix: "t3-antigravity-other-" });
        const kept = path.join(elsewhere, fixture.sessionId, "notes.md");
        yield* fs.makeDirectory(path.dirname(kept));
        yield* fs.writeFileString(kept, "another thread's");
        yield* fs.remove(path.dirname(fixture.brain), { recursive: true });
        yield* fs.symlink(elsewhere, path.dirname(fixture.brain));

        yield* removeAntigravitySessionFiles({
          profileDirectory: fixture.profileDirectory,
          sessionId: fixture.sessionId,
          cwd,
        });

        expect(yield* fs.exists(`${fixture.base}.db`)).toBe(false);
        expect(yield* fs.readFileString(kept)).toBe("another thread's");
      }),
  );

  it.effect("matches a symlinked temporary cwd against the canonical path stored in the DB", () =>
    Effect.gen(function* () {
      if (!symlinksSupported) return;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-symlink-" });
      const targetCwd = path.join(parent, "real-temp");
      const linkCwd = path.join(parent, "link-temp");
      yield* fs.makeDirectory(targetCwd, { recursive: true });
      yield* fs.symlink(targetCwd, linkCwd);
      const fixture = yield* makeNativeSessionFixture({
        workspacePaths: [yield* fs.realPath(targetCwd)],
      });

      yield* removeAntigravitySessionFiles({
        profileDirectory: fixture.profileDirectory,
        sessionId: fixture.sessionId,
        cwd: linkCwd,
      });

      expect(yield* fs.exists(`${fixture.base}.db`)).toBe(false);
      expect(yield* fs.exists(fixture.annotationFile)).toBe(false);
    }),
  );

  it.effect.skipIf(!sandboxed)(
    "removes nothing through a link the agent left where its conversations or annotations go",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "t3-antigravity-setup-" }),
        );
        // Another profile's session of the same name, which this helper's folder never held.
        const other = yield* makeNativeSessionFixture({ workspacePaths: [cwd] });
        yield* fs.writeFileString(`${other.base}.meta`, JSON.stringify({ cwd }));
        const fixture = yield* makeNativeSessionFixture({ workspacePaths: [cwd] });
        const remove = removeAntigravitySessionFiles({
          profileDirectory: fixture.profileDirectory,
          sessionId: fixture.sessionId,
          cwd,
        });

        yield* fs.remove(path.dirname(fixture.annotationFile), { recursive: true });
        yield* fs.symlink(path.dirname(other.annotationFile), path.dirname(fixture.annotationFile));
        yield* remove;
        expect(yield* fs.exists(`${fixture.base}.db`)).toBe(false);
        expect(yield* fs.exists(other.annotationFile)).toBe(true);

        yield* fs.remove(path.dirname(fixture.base), { recursive: true });
        yield* fs.symlink(path.dirname(other.base), path.dirname(fixture.base));
        yield* remove;
        expect(yield* fs.exists(`${other.base}.db`)).toBe(true);
        expect(yield* fs.exists(`${other.base}.meta`)).toBe(true);
      }),
  );

  it.effect("keeps a 1.5+ session DB whose metadata belongs to a different workspace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const projectCwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-project-" });
      const helperCwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-helper-" });
      const fixture = yield* makeNativeSessionFixture({
        workspacePaths: [projectCwd],
      });

      yield* removeAntigravitySessionFiles({
        profileDirectory: fixture.profileDirectory,
        sessionId: fixture.sessionId,
        cwd: helperCwd,
      });

      expect(yield* fs.exists(`${fixture.base}.db`)).toBe(true);
      expect(yield* fs.exists(fixture.brain)).toBe(true);
      expect(yield* fs.exists(fixture.annotationFile)).toBe(true);
    }),
  );

  it.effect("keeps a 1.5+ session DB that also includes an additional workspace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const helperCwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-helper-" });
      const attachmentsDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-attachments-" });
      const fixture = yield* makeNativeSessionFixture({
        workspacePaths: [helperCwd, attachmentsDir],
      });

      yield* removeAntigravitySessionFiles({
        profileDirectory: fixture.profileDirectory,
        sessionId: fixture.sessionId,
        cwd: helperCwd,
      });

      expect(yield* fs.exists(`${fixture.base}.db`)).toBe(true);
      expect(yield* fs.exists(fixture.brain)).toBe(true);
      expect(yield* fs.exists(fixture.annotationFile)).toBe(true);
    }),
  );

  it.effect(
    "keeps a 1.5+ session DB when its embedded session id mismatches or metadata is corrupt",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const helperCwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-helper-" });
        const wrongId = yield* makeNativeSessionFixture({
          workspacePaths: [helperCwd],
          metadataSessionId: OTHER_SESSION_ID,
        });
        const corrupt = yield* makeNativeSessionFixture({
          workspacePaths: [helperCwd],
          corruptBlob: true,
        });

        yield* removeAntigravitySessionFiles({
          profileDirectory: wrongId.profileDirectory,
          sessionId: wrongId.sessionId,
          cwd: helperCwd,
        });
        yield* removeAntigravitySessionFiles({
          profileDirectory: corrupt.profileDirectory,
          sessionId: corrupt.sessionId,
          cwd: helperCwd,
        });

        expect(yield* fs.exists(`${wrongId.base}.db`)).toBe(true);
        expect(yield* fs.exists(`${corrupt.base}.db`)).toBe(true);
      }),
  );
});

it.layer(NodeServices.layer)("retireAntigravityRuntimeTempDirs", (it) => {
  it.effect("moves leftovers aside at once and deletes them, plus older retirees, later", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fs.makeTempDirectoryScoped();
      const runtimeTemp = path.join(parent, "abc123");
      const orphan = path.join(runtimeTemp, "run-orphan", "_MEI123");
      yield* fs.makeDirectory(orphan, { recursive: true });
      yield* fs.writeFileString(path.join(orphan, "payload.bin"), "stale");
      yield* fs.makeDirectory(path.join(parent, "abc123.old-unfinished", "runtime"), {
        recursive: true,
      });
      yield* fs.makeDirectory(path.join(parent, "other-instance"));

      const removeRetired = yield* retireAntigravityRuntimeTempDirs(runtimeTemp);
      expect(yield* fs.exists(runtimeTemp)).toBe(false);
      const retired = (yield* fs.readDirectory(parent)).filter((entry) =>
        entry.startsWith("abc123.old-"),
      );
      expect(retired).toHaveLength(2);

      yield* removeRetired;
      expect((yield* fs.readDirectory(parent)).toSorted()).toEqual(["other-instance"]);
    }),
  );

  it.effect(
    "deletes leftovers inline when they cannot be moved aside, such as on a full disk",
    () =>
      Effect.gen(function* () {
        const removed: Array<string> = [];
        const fs = FileSystem.makeNoop({
          exists: () => Effect.succeed(true),
          makeTempDirectory: () =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "Unknown",
                module: "FileSystem",
                method: "makeTempDirectory",
                description: "ENOSPC",
              }),
            ),
          remove: (path) => Effect.sync(() => void removed.push(path)),
          readDirectory: () => Effect.succeed([]),
        });

        const removeRetired = yield* retireAntigravityRuntimeTempDirs(
          "/state/antigravity-tmp/abc123",
        ).pipe(Effect.provideService(FileSystem.FileSystem, fs));
        yield* removeRetired;
        expect(removed).toEqual(["/state/antigravity-tmp/abc123"]);
      }),
  );
});
