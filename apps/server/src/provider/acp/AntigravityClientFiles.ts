// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

const CLIENT_FILE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Reads the checked path through one descriptor: opened without following a final link or
 * blocking on a FIFO, required to be a regular file, and required to still sit inside a root by
 * its own path after opening, so a link or directory swapped in after the check reads nothing.
 */
async function readContainedFile(
  filePath: string,
  inside: (candidate: string) => boolean,
): Promise<Uint8Array | "missing" | "outside" | "not-readable"> {
  const { O_NOFOLLOW, O_NONBLOCK, O_RDONLY } = NodeFS.constants;
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(filePath, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "outside";
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > CLIENT_FILE_MAX_BYTES) return "not-readable";
    // Linux names the descriptor's real location; elsewhere the path must still be this file.
    const opened = await NodeFSP.realpath(`/proc/self/fd/${handle.fd}`).catch(() => null);
    if (opened === null) {
      const again = await NodeFSP.realpath(filePath).catch(() => null);
      const current = again === null ? null : await NodeFSP.stat(again).catch(() => null);
      if (
        again === null ||
        !inside(again) ||
        current === null ||
        current.dev !== stats.dev ||
        current.ino !== stats.ino
      )
        return "outside";
    } else if (!inside(opened)) {
      return "outside";
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function isInsideRoot(path: Path.Path, root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Resolve all symlinks, including the final component, before checking workspace containment. */
const resolveClientFilePath = Effect.fn("AntigravityClientFiles.resolveClientFilePath")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly allowedRoots: ReadonlyArray<string>;
    readonly requestPath: string;
  }) {
    const { path } = input;
    const resolved = path.resolve(input.requestPath);
    const outside = EffectAcpErrors.AcpRequestError.invalidParams(
      `Path '${input.requestPath}' is outside the session workspace.`,
    );
    // Canonicalize the deepest existing ancestor, so a link above missing directories cannot escape.
    let candidate = resolved;
    const missingSuffix: Array<string> = [];
    let real: string;
    while (true) {
      const canonical = yield* input.fileSystem.realPath(candidate).pipe(Effect.option);
      if (Option.isSome(canonical)) {
        real = path.join(canonical.value, ...missingSuffix);
        break;
      }
      // Walk up only past missing entries, never dangling or unreadable links.
      const entryExists = yield* input.fileSystem.readLink(candidate).pipe(
        Effect.as(true),
        Effect.catch(() => input.fileSystem.exists(candidate)),
        Effect.orElseSucceed(() => true),
      );
      const parent = path.dirname(candidate);
      if (entryExists || parent === candidate) return yield* outside;
      missingSuffix.unshift(path.basename(candidate));
      candidate = parent;
    }
    const roots = yield* Effect.forEach(input.allowedRoots, (root) =>
      input.fileSystem.realPath(root).pipe(Effect.orElseSucceed(() => root)),
    );
    const inside = (candidate: string) => roots.some((root) => isInsideRoot(path, root, candidate));
    if (!inside(real)) {
      return yield* outside;
    }
    return { real, inside };
  },
);

export const readAntigravityClientTextFile = Effect.fn("AntigravityClientFiles.readTextFile")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly allowedRoots: ReadonlyArray<string>;
    readonly request: EffectAcpSchema.ReadTextFileRequest;
  }): Effect.fn.Return<EffectAcpSchema.ReadTextFileResponse, EffectAcpErrors.AcpError> {
    const resolved = yield* resolveClientFilePath({ ...input, requestPath: input.request.path });
    const read = yield* Effect.promise(() => readContainedFile(resolved.real, resolved.inside));
    if (read === "missing") {
      return yield* EffectAcpErrors.AcpRequestError.resourceNotFound(
        `File '${input.request.path}' not found.`,
      );
    }
    if (read === "outside") {
      return yield* EffectAcpErrors.AcpRequestError.invalidParams(
        `Path '${input.request.path}' is outside the session workspace.`,
      );
    }
    if (read === "not-readable") {
      return yield* EffectAcpErrors.AcpRequestError.invalidParams(
        `File '${input.request.path}' is not a readable text file under ${CLIENT_FILE_MAX_BYTES} bytes.`,
      );
    }
    const bytes = read;
    const text = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      catch: () =>
        EffectAcpErrors.AcpRequestError.invalidParams(
          `File '${input.request.path}' is not a UTF-8 text file.`,
        ),
    });
    if (text.includes("\0")) {
      return yield* EffectAcpErrors.AcpRequestError.invalidParams(
        `File '${input.request.path}' contains binary data.`,
      );
    }
    const line = input.request.line ?? undefined;
    const limit = input.request.limit ?? undefined;
    if (line === undefined && limit === undefined) {
      return { content: text };
    }
    // ACP lines are 1-indexed. `limit` is a line count.
    const lines = text.split("\n");
    const start = Math.max(0, (line ?? 1) - 1);
    const end = limit === undefined ? lines.length : Math.min(lines.length, start + limit);
    return { content: lines.slice(start, end).join("\n") };
  },
);
