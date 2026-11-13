import { getSchema, type JSONContent } from "@tiptap/core";
import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { describe, expect, it } from "vite-plus/test";

import { markdownBlockExtensions } from "./markdownBlocks";
import { foldedBlockPositions, revealPosition } from "./markdownHeadingFold";

const schema = getSchema(markdownBlockExtensions());
const heading = (level: number, text: string): JSONContent => ({
  type: "heading",
  attrs: { level },
  content: [{ type: "text", text }],
});
const paragraph = (text: string): JSONContent => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

// # A, text, ## B, text, # C, text
const doc = ProseMirrorNode.fromJSON(schema, {
  type: "doc",
  content: [
    heading(1, "A"),
    paragraph("a"),
    heading(2, "B"),
    paragraph("b"),
    heading(1, "C"),
    paragraph("c"),
  ],
});
const starts: number[] = [];
doc.forEach((_node, position) => starts.push(position));
const [a, aText, b, bText, c, cText] = starts as [number, number, number, number, number, number];

describe("heading folds", () => {
  it("hides blocks up to the next heading of the same or a higher level", () => {
    expect(foldedBlockPositions(doc, new Set([a]))).toEqual([aText, b, bText]);
    expect(foldedBlockPositions(doc, new Set([b]))).toEqual([bText]);
    expect(foldedBlockPositions(doc, new Set([c]))).toEqual([cText]);
    expect(foldedBlockPositions(doc, new Set([a, b]))).toEqual([aText, b, bText]);
  });

  it("unfolds every section hiding the caret, nested ones included", () => {
    expect([...revealPosition(doc, new Set([a, b, c]), bText + 1)]).toEqual([c]);
    expect([...revealPosition(doc, new Set([b]), a + 1)]).toEqual([b]);
  });
});
