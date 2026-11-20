// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ChatAttachment } from "@t3tools/contracts";

import { resolveAttachmentRelativePath } from "./attachmentPaths.ts";
import {
  attachmentRelativePath,
  resolveAttachmentPathById,
  toSafeThreadAttachmentSegment,
} from "./attachmentStore.ts";

// Every thread's files share one store, so a provider session is handed only a per-thread folder
// of hard links (copies across file systems) to the files that thread holds. Never symlinks:
// following one leads back into the shared store the session must not be granted.
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

function exists(path: string): boolean {
  try {
    NodeFS.lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function linkOrCopy(source: string, target: string) {
  try {
    NodeFS.linkSync(source, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOENT") return;
    try {
      NodeFS.copyFileSync(source, target, NodeFS.constants.COPYFILE_EXCL);
    } catch (copyError) {
      if ((copyError as NodeJS.ErrnoException).code !== "EEXIST") throw copyError;
    }
  }
}

/** Links one stored file and its extracted-text sidecar into the thread folder. */
function linkStoredFile(input: {
  readonly attachmentsDir: string;
  readonly threadDir: string;
  readonly relativePath: string;
}): string | null {
  const source = resolveAttachmentRelativePath({
    attachmentsDir: input.attachmentsDir,
    relativePath: input.relativePath,
  });
  const target = resolveAttachmentRelativePath({
    attachmentsDir: input.threadDir,
    relativePath: input.relativePath,
  });
  if (source === null || target === null) return null;
  try {
    NodeFS.mkdirSync(input.threadDir, { recursive: true, mode: 0o700 });
    for (const suffix of ["", ".txt"]) {
      if (!exists(`${target}${suffix}`) && exists(`${source}${suffix}`)) {
        linkOrCopy(`${source}${suffix}`, `${target}${suffix}`);
      }
    }
  } catch {
    // An unplaceable file reads as unavailable; the shared store is never the fallback.
  }
  return exists(target) ? target : null;
}

/** Creates the thread folder a provider session may be granted, and returns its path. */
export function ensureThreadAttachmentsDir(input: {
  readonly attachmentsDir: string;
  readonly threadId: string;
}): string | null {
  const threadDir = threadAttachmentsDir(input);
  if (threadDir === null) return null;
  try {
    NodeFS.mkdirSync(threadDir, { recursive: true, mode: 0o700 });
    return threadDir;
  } catch {
    return null;
  }
}

/** The path a thread's provider sees for an attachment, linked into its folder first. */
export function threadAttachmentPath(input: {
  readonly attachmentsDir: string;
  readonly threadId: string;
  readonly attachment: ChatAttachment;
}): string | null {
  const threadDir = threadAttachmentsDir(input);
  const relativePath = attachmentRelativePath(input.attachment);
  if (threadDir === null || relativePath === null) return null;
  return linkStoredFile({ attachmentsDir: input.attachmentsDir, threadDir, relativePath });
}

/** Links stored files by id; ids whose file is gone are skipped. */
export function linkThreadAttachmentIds(input: {
  readonly attachmentsDir: string;
  readonly threadId: string;
  readonly attachmentIds: ReadonlyArray<string>;
}): void {
  const threadDir = ensureThreadAttachmentsDir(input);
  if (threadDir === null) return;
  for (const attachmentId of new Set(input.attachmentIds)) {
    const source = resolveAttachmentPathById({
      attachmentsDir: input.attachmentsDir,
      attachmentId,
    });
    if (source === null) continue;
    linkStoredFile({
      attachmentsDir: input.attachmentsDir,
      threadDir,
      relativePath: NodePath.basename(source),
    });
  }
}

export function removeThreadAttachmentsDir(input: {
  readonly attachmentsDir: string;
  readonly threadId: string;
}): void {
  const threadDir = threadAttachmentsDir(input);
  if (threadDir !== null) NodeFS.rmSync(threadDir, { recursive: true, force: true });
}
