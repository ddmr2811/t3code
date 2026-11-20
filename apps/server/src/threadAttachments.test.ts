// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import {
  linkThreadAttachmentIds,
  removeThreadAttachmentsDir,
  threadAttachmentPath,
  threadAttachmentsDir,
} from "./threadAttachments.ts";

vi.mock("node:fs", { spy: true });

const sourceThread = "thread-a";
const file = {
  type: "file" as const,
  id: "thread-a-00000000-0000-4000-8000-0000000000aa-txt",
  name: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: 5,
};

function makeStore() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-thread-attachments-"));
  const attachmentsDir = NodePath.join(root, "attachments");
  NodeFS.mkdirSync(attachmentsDir);
  const stored = NodePath.join(attachmentsDir, `${file.id}.txt`);
  NodeFS.writeFileSync(stored, "notes");
  NodeFS.writeFileSync(`${stored}.txt`, "extracted");
  return {
    attachmentsDir,
    stored,
    [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true, force: true }),
  };
}

describe("thread attachment folders", () => {
  it("links a file another thread stored into the receiving thread's folder only", () => {
    using store = makeStore();
    const path = threadAttachmentPath({
      attachmentsDir: store.attachmentsDir,
      threadId: "thread-b",
      attachment: file,
    });
    const folder = threadAttachmentsDir({
      attachmentsDir: store.attachmentsDir,
      threadId: "thread-b",
    })!;
    expect(path).toBe(NodePath.join(folder, `${file.id}.txt`));
    expect(folder.startsWith(`${store.attachmentsDir}${NodePath.sep}`)).toBe(false);
    expect(NodeFS.lstatSync(path!).isSymbolicLink()).toBe(false);
    expect(NodeFS.statSync(path!).ino).toBe(NodeFS.statSync(store.stored).ino);
    expect(NodeFS.readFileSync(`${path}.txt`, "utf8")).toBe("extracted");
    expect(
      NodeFS.existsSync(
        threadAttachmentsDir({ attachmentsDir: store.attachmentsDir, threadId: sourceThread })!,
      ),
    ).toBe(false);
  });

  it("copies when the store cannot be hard linked, and never falls back to the store", () => {
    using store = makeStore();
    vi.mocked(NodeFS.linkSync).mockImplementation(() => {
      throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
    });
    try {
      const path = threadAttachmentPath({
        attachmentsDir: store.attachmentsDir,
        threadId: "thread-b",
        attachment: file,
      })!;
      expect(NodeFS.lstatSync(path).isFile()).toBe(true);
      expect(NodeFS.statSync(path).ino).not.toBe(NodeFS.statSync(store.stored).ino);
      expect(NodeFS.readFileSync(path, "utf8")).toBe("notes");
      vi.mocked(NodeFS.copyFileSync).mockImplementationOnce(() => {
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      });
      expect(
        threadAttachmentPath({
          attachmentsDir: store.attachmentsDir,
          threadId: "thread-c",
          attachment: file,
        }),
      ).toBeNull();
    } finally {
      vi.mocked(NodeFS.linkSync).mockRestore();
    }
  });

  it("fills a folder from stored ids and removes it without touching the store", () => {
    using store = makeStore();
    const input = { attachmentsDir: store.attachmentsDir, threadId: "thread-b" };
    linkThreadAttachmentIds({ ...input, attachmentIds: [file.id, "thread-a-missing"] });
    const folder = threadAttachmentsDir(input)!;
    expect(NodeFS.readdirSync(folder).toSorted()).toEqual([`${file.id}.txt`, `${file.id}.txt.txt`]);
    removeThreadAttachmentsDir(input);
    expect(NodeFS.existsSync(folder)).toBe(false);
    expect(NodeFS.readFileSync(store.stored, "utf8")).toBe("notes");
  });

  it("keeps ids that sanitize alike in separate folders", () => {
    expect(
      threadAttachmentsDir({ attachmentsDir: "/state/attachments", threadId: "A:b" }),
    ).not.toBe(threadAttachmentsDir({ attachmentsDir: "/state/attachments", threadId: "a-b" }));
  });
});
