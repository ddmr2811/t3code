// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  placeThreadAttachments,
  removeThreadAttachmentsDir,
  threadAttachmentPath,
  threadAttachmentsDir,
} from "./threadAttachments.ts";

const file = {
  type: "file" as const,
  id: "thread-a-00000000-0000-4000-8000-0000000000aa-txt",
  name: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: 5,
};
const threadId = "thread-b";

function makeStore() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-thread-attachments-"));
  const attachmentsDir = NodePath.join(root, "userdata", "attachments");
  NodeFS.mkdirSync(attachmentsDir, { recursive: true });
  const stored = NodePath.join(attachmentsDir, `${file.id}.txt`);
  NodeFS.writeFileSync(stored, "notes");
  NodeFS.writeFileSync(`${stored}.txt`, "extracted");
  const outside = NodePath.join(root, "outside");
  NodeFS.mkdirSync(outside);
  NodeFS.writeFileSync(NodePath.join(outside, "keep.txt"), "keep");
  const input = { attachmentsDir, threadId };
  return {
    input,
    stored,
    outside,
    folder: threadAttachmentsDir(input)!,
    [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true, force: true }),
  };
}

const outsideEntries = (outside: string) => NodeFS.readdirSync(outside).toSorted();

describe("thread attachment folders", () => {
  it.effect("places a read-only copy whose writes never reach the store", () =>
    Effect.gen(function* () {
      using store = makeStore();
      yield* placeThreadAttachments({ ...store.input, attachments: [file] });
      const path = threadAttachmentPath({ ...store.input, attachment: file })!;
      expect(path).toBe(NodePath.join(store.folder, `${file.id}.txt`));
      expect(NodeFS.readdirSync(store.folder).toSorted()).toEqual([
        `${file.id}.txt`,
        `${file.id}.txt.txt`,
      ]);
      const stats = NodeFS.lstatSync(path);
      expect(stats.isFile()).toBe(true);
      expect(stats.mode & 0o777).toBe(0o444);
      expect(stats.ino).not.toBe(NodeFS.statSync(store.stored).ino);
      NodeFS.chmodSync(path, 0o644);
      NodeFS.writeFileSync(path, "changed by the agent");
      expect(NodeFS.readFileSync(store.stored, "utf8")).toBe("notes");
      expect(NodeFS.readFileSync(`${path}.txt`, "utf8")).toBe("extracted");
    }),
  );

  it.effect("places stored files by id and leaves missing ones unavailable", () =>
    Effect.gen(function* () {
      using store = makeStore();
      const missing = { ...file, id: "thread-a-00000000-0000-4000-8000-0000000000bb-txt" };
      yield* placeThreadAttachments({ ...store.input, attachmentIds: [file.id, missing.id] });
      expect(threadAttachmentPath({ ...store.input, attachment: file })).not.toBeNull();
      expect(threadAttachmentPath({ ...store.input, attachment: missing })).toBeNull();
    }),
  );

  it.effect("replaces a symlink at the destination without writing through it", () =>
    Effect.gen(function* () {
      using store = makeStore();
      NodeFS.mkdirSync(store.folder, { recursive: true });
      const victim = NodePath.join(store.outside, "keep.txt");
      NodeFS.symlinkSync(victim, NodePath.join(store.folder, `${file.id}.txt`));
      yield* placeThreadAttachments({ ...store.input, attachments: [file] });
      const path = threadAttachmentPath({ ...store.input, attachment: file })!;
      expect(NodeFS.lstatSync(path).isSymbolicLink()).toBe(false);
      expect(NodeFS.readFileSync(path, "utf8")).toBe("notes");
      expect(NodeFS.readFileSync(victim, "utf8")).toBe("keep");
    }),
  );

  it.effect.each(["thread folder", "folder root"] as const)(
    "never writes or removes through a symlinked %s",
    (linked) =>
      Effect.gen(function* () {
        using store = makeStore();
        const link = linked === "thread folder" ? store.folder : NodePath.dirname(store.folder);
        NodeFS.mkdirSync(NodePath.dirname(link), { recursive: true });
        NodeFS.symlinkSync(store.outside, link);
        yield* placeThreadAttachments({ ...store.input, attachments: [file] });
        expect(outsideEntries(store.outside)).toEqual(["keep.txt"]);
        expect(threadAttachmentPath({ ...store.input, attachment: file })).toBeNull();
        yield* removeThreadAttachmentsDir(store.input);
        expect(outsideEntries(store.outside)).toEqual(["keep.txt"]);
        expect(NodeFS.readFileSync(store.stored, "utf8")).toBe("notes");
      }),
  );

  it.effect("removes the thread folder without touching the store", () =>
    Effect.gen(function* () {
      using store = makeStore();
      yield* placeThreadAttachments({ ...store.input, attachments: [file] });
      NodeFS.symlinkSync(store.outside, NodePath.join(store.folder, "planted"));
      yield* removeThreadAttachmentsDir(store.input);
      expect(NodeFS.existsSync(store.folder)).toBe(false);
      expect(outsideEntries(store.outside)).toEqual(["keep.txt"]);
      expect(NodeFS.readFileSync(store.stored, "utf8")).toBe("notes");
    }),
  );

  it("keeps ids that sanitize alike in separate folders", () => {
    expect(
      threadAttachmentsDir({ attachmentsDir: "/state/attachments", threadId: "A:b" }),
    ).not.toBe(threadAttachmentsDir({ attachmentsDir: "/state/attachments", threadId: "a-b" }));
  });
});
