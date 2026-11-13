import { getSchema, type JSONContent } from "@tiptap/core";
import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { describe, expect, it } from "vite-plus/test";

import {
  markdownBlockExtensions,
  parseMarkdownBlocks,
  serializeMarkdownBlocks,
} from "./markdownBlocks";

const schema = getSchema(markdownBlockExtensions());

function edit(markdown: string, change: (content: JSONContent[]) => JSONContent[]): string {
  const { source, doc } = parseMarkdownBlocks(markdown);
  const initial = ProseMirrorNode.fromJSON(schema, doc);
  const next = ProseMirrorNode.fromJSON(schema, {
    ...doc,
    content: change(structuredClone(doc.content ?? [])),
  });
  return serializeMarkdownBlocks(source, initial, next);
}

const paragraph = (text: string): JSONContent => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

describe("markdown block editing", () => {
  it("returns the file byte for byte when nothing changed", () => {
    const markdown =
      "---\r\ntitle: Notes\r\n---\r\n\r\nSetext\r\n===\r\n\r\n* star   list\r\n\r\n| a | b |\r\n|---|---|\r\n";
    expect(edit(markdown, (content) => content)).toBe(markdown);
  });

  it("rewrites only the edited block and keeps its neighbours' formatting", () => {
    const markdown =
      "Intro  with __bold__\n\n- [ ] ship it\n- [ ] test it\n\n*   loose star list\n\n<details>raw</details>\n";
    const result = edit(markdown, (content) => {
      const taskList = content.find((node) => node.type === "taskList")!;
      taskList.content![0]!.attrs = { ...taskList.content![0]!.attrs, checked: true };
      return content;
    });
    expect(result).toBe(
      "Intro  with __bold__\n\n- [x] ship it\n- [ ] test it\n\n*   loose star list\n\n<details>raw</details>\n",
    );
  });

  it("keeps constructs the editor cannot represent as verbatim blocks", () => {
    const markdown =
      "| a | ![i](i.png) |\n|:--|--:|\n| 1 | 2 |\n\n![logo](./logo.png) badge\n\n[ref]: https://example.com\n";
    const { doc } = parseMarkdownBlocks(markdown);
    expect(doc.content?.map((node) => node.type)).toEqual([
      "markdownRawBlock",
      "markdownRawBlock",
      "markdownRawBlock",
    ]);
    const result = edit(markdown, (content) => [
      paragraph("Before"),
      ...content.slice(0, 2),
      paragraph("Between"),
      ...content.slice(2),
    ]);
    expect(result).toBe(
      "Before\n\n| a | ![i](i.png) |\n|:--|--:|\n| 1 | 2 |\n\n![logo](./logo.png) badge\n\nBetween\n\n[ref]: https://example.com\n",
    );
  });

  it("edits table cells as a GFM table that keeps alignment and escapes pipes", () => {
    const markdown = "Intro\n\n| Task | Done |\n|:--|--:|\n| Docs | no |\n\nOutro\n";
    const { doc } = parseMarkdownBlocks(markdown);
    expect(doc.content?.map((node) => node.type)).toEqual(["paragraph", "table", "paragraph"]);
    const result = edit(markdown, (content) => {
      const cell = content[1]!.content![1]!.content![1]!;
      cell.content = [paragraph("a | b")];
      return content;
    });
    expect(result).toBe(
      "Intro\n\n| Task | Done   |\n| :---- | ------: |\n| Docs | a \\| b |\n\nOutro\n",
    );
  });

  it("serializes block conversions as Markdown syntax", () => {
    const result = edit("# Plan\n\nfirst\n\nsecond\n", (content) => [
      content[0]!,
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "first" }] },
      {
        type: "codeBlock",
        attrs: { language: "ts" },
        content: [{ type: "text", text: "const second = 2;" }],
      },
    ]);
    expect(result).toBe("# Plan\n\n## first\n\n```ts\nconst second = 2;\n```\n");
  });

  it("keeps frontmatter and line endings when the first block changes", () => {
    const result = edit("---\r\ntags: [a]\r\n---\r\n# Old\r\n\r\nBody\r\n", (content) => [
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "New" }] },
      ...content.slice(1),
    ]);
    expect(result).toBe("---\r\ntags: [a]\r\n---\r\n# New\r\n\r\nBody\r\n");
  });

  it("drops deleted blocks and empty paragraphs without leaving gaps", () => {
    const result = edit("one\n\ntwo\n\nthree\n", (content) => [
      content[0]!,
      { type: "paragraph" },
      content[2]!,
    ]);
    expect(result).toBe("one\n\nthree\n");
    expect(edit("only\n", () => [{ type: "paragraph" }])).toBe("\n");
  });

  it("writes typed text into an empty file", () => {
    expect(edit("", () => [paragraph("Hello")])).toBe("Hello\n");
  });
});
