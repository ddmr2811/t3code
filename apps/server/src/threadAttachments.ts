// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { ChatAttachment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { resolveAttachmentRelativePath } from "./attachmentPaths.ts";
import {
  attachmentRelativePath,
  parseAttachmentFileExtension,
  toSafeThreadAttachmentSegment,
} from "./attachmentStore.ts";
import { SAFE_IMAGE_FILE_EXTENSIONS } from "./imageMime.ts";

// Every thread's files share one store, so a provider session is handed only a per-thread folder
// holding read-only copies of the files that thread can see. Copies, not links: a hard link lets
// a write through the thread's folder change the store, and a symlink leads back into it.
const THREAD_ATTACHMENTS_DIRECTORY = "attachments-by-thread";

export function threadAttachmentsDir(input: {
  readonly attachmentsDir: string;
  readonly threadId: string;
}): string | null {
  const segment = toSafeThreadAttachmentSegment(input.threadId);
  if (segment === null) return null;
  // Sanitizing folds distinct ids together; the hash keeps each thread's folder its own.
  const hash = NodeCrypto.createHash("sha256").update(input.threadId).digest("hex").slice(0, 12);
  return NodePath.join(
    NodePath.dirname(NodePath.resolve(input.attachmentsDir)),
    THREAD_ATTACHMENTS_DIRECTORY,
    `${segment}-${hash}`,
  );
}

const ownedByServer = (stats: NodeFS.Stats) =>
  process.getuid === undefined || stats.uid === process.getuid();

function isServerDirectorySync(path: string): boolean {
  try {
    const stats = NodeFS.lstatSync(path);
    return stats.isDirectory() && ownedByServer(stats);
  } catch {
    return false;
  }
}

function folderFileName(attachment: ChatAttachment): string | null {
  const name = attachmentRelativePath(attachment);
  return name !== null && NodePath.basename(name) === name ? name : null;
}

/** The thread folder, only while it and its parent are the server's own directories. */
function existingThreadAttachmentsDir(input: {
  readonly attachmentsDir: string;
  readonly threadId: string;
}): string | null {
  const threadDir = threadAttachmentsDir(input);
  return threadDir !== null &&
    isServerDirectorySync(NodePath.dirname(threadDir)) &&
    isServerDirectorySync(threadDir)
    ? threadDir
    : null;
}

/** The copy a thread's provider may read, or null; the shared store is never the fallback. */
export function threadAttachmentPath(input: {
  readonly attachmentsDir: string;
  readonly threadId: string;
  readonly attachment: ChatAttachment;
}): string | null {
  const threadDir = existingThreadAttachmentsDir(input);
  const fileName = folderFileName(input.attachment);
  if (threadDir === null || fileName === null) return null;
  const target = NodePath.join(threadDir, fileName);
  try {
    return NodeFS.lstatSync(target).isFile() ? target : null;
  } catch {
    return null;
  }
}

async function lstatOrNull(path: string) {
  return NodeFSP.lstat(path).catch(() => null);
}

async function serverDirectory(path: string, create: boolean): Promise<boolean> {
  let stats = await lstatOrNull(path);
  if (stats === null && create) {
    await NodeFSP.mkdir(path, { mode: 0o700 }).catch(() => undefined);
    stats = await lstatOrNull(path);
  }
  return stats !== null && stats.isDirectory() && ownedByServer(stats);
}

async function ensureFolder(input: {
  readonly attachmentsDir: string;
  readonly threadId: string;
}): Promise<string | null> {
  const threadDir = threadAttachmentsDir(input);
  if (threadDir === null) return null;
  return (await serverDirectory(NodePath.dirname(threadDir), true)) &&
    (await serverDirectory(threadDir, true))
    ? threadDir
    : null;
}

/** Publishes a read-only copy by rename, so a reader never sees a partial file. */
async function copyStoredFile(source: string, threadDir: string, fileName: string) {
  const sourceStats = await lstatOrNull(source);
  if (sourceStats === null || !sourceStats.isFile()) return;
  const target = NodePath.join(threadDir, fileName);
  const existing = await lstatOrNull(target);
  if (existing?.isFile()) return;
  // rm does not follow links; rename below replaces any other non-directory without following it.
  if (existing?.isDirectory()) await NodeFSP.rm(target, { recursive: true, force: true });
  const temporary = NodePath.join(threadDir, `.${fileName}.${NodeCrypto.randomUUID()}.tmp`);
  try {
    await NodeFSP.copyFile(
      source,
      temporary,
      NodeFS.constants.COPYFILE_EXCL | NodeFS.constants.COPYFILE_FICLONE,
    );
    const handle = await NodeFSP.open(
      temporary,
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
    );
    try {
      await handle.chmod(0o444);
    } finally {
      await handle.close();
    }
    await NodeFSP.rename(temporary, target);
  } finally {
    await NodeFSP.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function storedFileName(attachmentsDir: string, attachmentId: string) {
  const extension = parseAttachmentFileExtension(attachmentId);
  for (const suffix of extension ? [`.${extension}`] : [...SAFE_IMAGE_FILE_EXTENSIONS, ".bin"]) {
    const fileName = `${attachmentId}${suffix}`;
    const path = resolveAttachmentRelativePath({ attachmentsDir, relativePath: fileName });
    if (
      path !== null &&
      NodePath.basename(path) === fileName &&
      (await lstatOrNull(path))?.isFile()
    )
      return fileName;
  }
  return null;
}

async function place(input: {
  readonly attachmentsDir: string;
  readonly threadId: string;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
  readonly attachmentIds?: ReadonlyArray<string>;
}) {
  const threadDir = await ensureFolder(input);
  if (threadDir === null) return;
  const fileNames = new Set<string>();
  for (const attachment of input.attachments ?? []) {
    const fileName = folderFileName(attachment);
    if (fileName !== null) fileNames.add(fileName);
  }
  for (const attachmentId of new Set(input.attachmentIds)) {
    const fileName = await storedFileName(input.attachmentsDir, attachmentId);
    if (fileName !== null) fileNames.add(fileName);
  }
  for (const fileName of fileNames) {
    for (const name of [fileName, `${fileName}.txt`]) {
      // A file that cannot be copied reads as unavailable to the provider.
      await copyStoredFile(NodePath.join(input.attachmentsDir, name), threadDir, name).catch(
        () => undefined,
      );
    }
  }
}

async function remove(input: { readonly attachmentsDir: string; readonly threadId: string }) {
  const threadDir = threadAttachmentsDir(input);
  // Through a linked parent the folder path would name a directory elsewhere.
  if (threadDir === null || !(await serverDirectory(NodePath.dirname(threadDir), false))) return;
  await NodeFSP.rm(threadDir, { recursive: true, force: true });
}

const folderWork = new Map<string, Promise<unknown>>();

/** One thread folder changes one operation at a time. */
function serialized<A>(threadId: string, work: () => Promise<A>): Promise<A> {
  const previous = folderWork.get(threadId) ?? Promise.resolve();
  const next = previous.then(work, work);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  folderWork.set(threadId, settled);
  void settled.then(() => {
    if (folderWork.get(threadId) === settled) folderWork.delete(threadId);
  });
  return next;
}

/** Creates the thread folder a provider session may be granted. */
export const ensureThreadAttachmentsDir = Effect.fn("ThreadAttachments.ensureDir")(
  function* (input: { readonly attachmentsDir: string; readonly threadId: string }) {
    return yield* Effect.promise(() => serialized(input.threadId, () => ensureFolder(input)));
  },
);

/** Copies stored files, by attachment or by id, into the thread folder; missing ones are skipped. */
export const placeThreadAttachments = Effect.fn("ThreadAttachments.place")(function* (input: {
  readonly attachmentsDir: string;
  readonly threadId: string;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
  readonly attachmentIds?: ReadonlyArray<string>;
}) {
  yield* Effect.promise(() => serialized(input.threadId, () => place(input)));
});

export class ThreadAttachmentsRemoveError extends Schema.TaggedError<ThreadAttachmentsRemoveError>()(
  "ThreadAttachmentsRemoveError",
  { threadId: Schema.String, cause: Schema.Defect() },
) {}

export const removeThreadAttachmentsDir = Effect.fn("ThreadAttachments.remove")(function* (input: {
  readonly attachmentsDir: string;
  readonly threadId: string;
}) {
  yield* Effect.tryPromise({
    try: () => serialized(input.threadId, () => remove(input)),
    catch: (cause) => new ThreadAttachmentsRemoveError({ threadId: input.threadId, cause }),
  });
});
