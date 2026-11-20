// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { readAntigravityClientTextFile } from "./AntigravityClientFiles.ts";

function makeFolders() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-antigravity-reads-"));
  const folder = NodePath.join(root, "attachments-by-thread", "thread-a");
  const store = NodePath.join(root, "attachments");
  NodeFS.mkdirSync(NodePath.join(folder, "sub"), { recursive: true });
  NodeFS.mkdirSync(store, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(folder, "own.txt"), "own copy");
  NodeFS.writeFileSync(NodePath.join(folder, "sub", "own.txt"), "own copy");
  // Another thread's attachment, in the shared store.
  NodeFS.writeFileSync(NodePath.join(store, "own.txt"), "another thread's file");
  return {
    folder,
    store,
    [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true, force: true }),
  };
}

/** A file system whose check of `target` is followed at once by `swap`, as in a race. */
const swapAfterCheck = Effect.fnUntraced(function* (target: string, swap: () => void) {
  const fileSystem = yield* FileSystem.FileSystem;
  let swapped = false;
  return FileSystem.FileSystem.of({
    ...fileSystem,
    realPath: (path) =>
      fileSystem.realPath(path).pipe(
        Effect.tap((real) =>
          Effect.sync(() => {
            if (!swapped && real === target) {
              swapped = true;
              swap();
            }
          }),
        ),
      ),
  });
});

const read = Effect.fnUntraced(function* (
  fileSystem: FileSystem.FileSystem,
  folder: string,
  requestPath: string,
) {
  return yield* readAntigravityClientTextFile({
    fileSystem,
    path: yield* Path.Path,
    allowedRoots: [folder],
    request: { sessionId: "session", path: requestPath },
  }).pipe(Effect.exit);
});

describe("Antigravity client file reads", () => {
  it.effect("refuses a link in the thread folder to another thread's attachment", () =>
    Effect.gen(function* () {
      using folders = makeFolders();
      const link = NodePath.join(folders.folder, "link.txt");
      NodeFS.symlinkSync(NodePath.join(folders.store, "own.txt"), link);
      const exit = yield* read(yield* FileSystem.FileSystem, folders.folder, link);
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each(["file", "directory"] as const)(
    "reads nothing when a checked %s is swapped for a link before the read",
    (swapped) =>
      Effect.gen(function* () {
        using folders = makeFolders();
        const requestPath =
          swapped === "file"
            ? NodePath.join(folders.folder, "own.txt")
            : NodePath.join(folders.folder, "sub", "own.txt");
        const fileSystem = yield* swapAfterCheck(NodeFS.realpathSync(requestPath), () => {
          if (swapped === "file") {
            NodeFS.rmSync(requestPath);
            NodeFS.symlinkSync(NodePath.join(folders.store, "own.txt"), requestPath);
          } else {
            const sub = NodePath.join(folders.folder, "sub");
            NodeFS.rmSync(sub, { recursive: true });
            NodeFS.symlinkSync(folders.store, sub);
          }
        });
        const exit = yield* read(fileSystem, folders.folder, requestPath);
        expect(Exit.isFailure(exit)).toBe(true);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("still reads the thread's own copy", () =>
    Effect.gen(function* () {
      using folders = makeFolders();
      const exit = yield* read(
        yield* FileSystem.FileSystem,
        folders.folder,
        NodePath.join(folders.folder, "own.txt"),
      );
      expect(Exit.isSuccess(exit) ? exit.value.content : exit).toBe("own copy");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
