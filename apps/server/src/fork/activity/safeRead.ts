// @effect-diagnostics nodeBuiltinImport:off -- O_NOFOLLOW, O_NONBLOCK and fstat on one descriptor.
// Fork-only: how the activity feed reads files other programs write. A symlink is refused at
// open, a FIFO or device opens without blocking and is refused by its own descriptor's type, and
// every read is bounded in bytes and in time.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface FileSlice {
  /** Where `bytes` start in the file. */
  readonly offset: number;
  readonly bytes: Uint8Array;
}

/** Never leaves this module: every failure reads as "no file". */
class FileReadError extends Schema.TaggedError<FileReadError>()("FileReadError", {
  cause: Schema.Defect(),
}) {}

const attempt = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new FileReadError({ cause }) });

const OPEN_FLAGS =
  NodeFS.constants.O_RDONLY |
  (NodeFS.constants.O_NOFOLLOW ?? 0) |
  (NodeFS.constants.O_NONBLOCK ?? 0);

async function readSlice(
  handle: NodeFSP.FileHandle,
  maxBytes: number,
  from: "start" | "end",
): Promise<FileSlice | null> {
  const info = await handle.stat();
  if (!info.isFile()) return null;
  const offset = from === "end" ? Math.max(0, info.size - maxBytes) : 0;
  const length = Math.max(0, Math.min(maxBytes, info.size - offset));
  const buffer = new Uint8Array(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await handle.read(buffer, read, length - read, offset + read);
    if (bytesRead === 0) break;
    read += bytesRead;
  }
  return { offset, bytes: buffer.subarray(0, read) };
}

/**
 * At most `maxBytes` of a regular file, from its start or its end. Null for a symlink, anything
 * but a regular file, an error, or a read that takes longer than `timeout`.
 */
export const readRegularFile = (
  path: string,
  options: {
    readonly maxBytes: number;
    readonly from: "start" | "end";
    readonly timeout: Duration.Input;
  },
): Effect.Effect<FileSlice | null> =>
  Effect.acquireUseRelease(
    attempt(() => NodeFSP.open(path, OPEN_FLAGS)),
    (handle) => attempt(() => readSlice(handle, options.maxBytes, options.from)),
    (handle) => attempt(() => handle.close()).pipe(Effect.ignore),
  ).pipe(
    Effect.timeoutOption(options.timeout),
    Effect.map(Option.getOrNull),
    Effect.orElseSucceed(() => null),
  );
