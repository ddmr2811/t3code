import { type AnyExtension, type JSONContent, mergeAttributes, Node } from "@tiptap/core";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import {
  renderTableToMarkdown,
  Table,
  TableCell,
  TableHeader,
  TableRow,
} from "@tiptap/extension-table";
import { MarkdownManager } from "@tiptap/markdown";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import { maskMarkdownFrontmatter } from "@t3tools/shared/markdownFrontmatter";

/**
 * A top-level Markdown construct the block editor cannot represent, such as an
 * image or raw HTML. It shows rendered and saves its source verbatim.
 */
export const MarkdownRawBlock = Node.create({
  name: "markdownRawBlock",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      source: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-markdown-source") ?? "",
        renderHTML: (attributes) => ({ "data-markdown-source": attributes.source }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-markdown-raw-block]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-markdown-raw-block": "" })];
  },
  renderMarkdown: (node) => String(node.attrs?.source ?? ""),
});

// Two private-use characters, as wide as the escaped pipe that replaces them, keep columns aligned.
const PIPE_PLACEHOLDER = String.fromCharCode(0xe000, 0xe001);

function withPipePlaceholders(node: JSONContent): JSONContent {
  return {
    ...node,
    ...(node.text === undefined ? {} : { text: node.text.replaceAll("|", PIPE_PLACEHOLDER) }),
    ...(node.content === undefined ? {} : { content: node.content.map(withPipePlaceholders) }),
  };
}

/** GFM needs every `|` in a cell escaped, even in code spans; Tiptap's renderer leaves them bare. */
const MarkdownTable = Table.extend({
  renderMarkdown: (node, helpers) =>
    renderTableToMarkdown(withPipePlaceholders(node), helpers).replaceAll(PIPE_PLACEHOLDER, "\\|"),
}).configure({ resizable: false });

/** Underline has no Markdown syntax, so Mod-U must not invent one. */
export const markdownBlockExtensions = (rawBlock: AnyExtension = MarkdownRawBlock) => [
  StarterKit.configure({ underline: false, link: { openOnClick: false } }),
  TaskList,
  TaskItem.configure({ nested: true }),
  MarkdownTable,
  TableRow,
  TableHeader,
  TableCell,
  rawBlock,
];

let sharedManager: MarkdownManager | null = null;
function markdownBlockManager(): MarkdownManager {
  sharedManager ??= new MarkdownManager({ extensions: markdownBlockExtensions() });
  return sharedManager;
}

// Every marked token the extensions above parse and serialize without loss.
const EDITABLE_TOKEN_TYPES = new Set([
  "blockquote",
  "br",
  "checkbox",
  "code",
  "codespan",
  "del",
  "em",
  "escape",
  "heading",
  "hr",
  "link",
  "list",
  "list_item",
  "paragraph",
  "space",
  "strong",
  "table",
  "taskItem",
  "taskList",
  "text",
]);

interface LexedToken {
  readonly type: string;
  readonly raw: string;
  readonly tokens?: readonly LexedToken[] | undefined;
  readonly items?: readonly LexedToken[] | undefined;
  readonly header?: readonly { readonly tokens: readonly LexedToken[] }[] | undefined;
  readonly rows?: readonly (readonly { readonly tokens: readonly LexedToken[] }[])[] | undefined;
}

function tokenIsEditable(token: LexedToken, inTableCell = false): boolean {
  // Table cells keep line breaks as `<br>`, which the table parser reads back as hard breaks.
  if (inTableCell && token.type === "html" && /^<br\s*\/?>$/i.test(token.raw)) return true;
  if (!EDITABLE_TOKEN_TYPES.has(token.type)) return false;
  const cells = [...(token.header ?? []), ...(token.rows ?? []).flat()];
  return (
    [...(token.tokens ?? []), ...(token.items ?? [])].every((child) =>
      tokenIsEditable(child, inTableCell),
    ) && cells.every((cell) => cell.tokens.every((child) => tokenIsEditable(child, true)))
  );
}

interface MarkdownBlockUnit {
  /** Source range in the LF-normalized text, without surrounding blank lines. */
  readonly start: number;
  readonly end: number;
  readonly nodeCount: number;
}

export interface MarkdownBlockSource {
  readonly original: string;
  readonly normalized: string;
  readonly crlf: boolean;
  readonly units: readonly MarkdownBlockUnit[];
}

export interface ParsedMarkdownBlocks {
  readonly source: MarkdownBlockSource;
  readonly doc: JSONContent;
}

export function parseMarkdownBlocks(
  markdown: string,
  manager: MarkdownManager = markdownBlockManager(),
): ParsedMarkdownBlocks {
  const crlf = markdown.includes("\r\n");
  const normalized = crlf ? markdown.replace(/\r\n/g, "\n") : markdown;
  // Masking keeps offsets, so frontmatter stays in the untouched head of the file.
  const tokens = manager.instance.lexer(maskMarkdownFrontmatter(normalized)) as LexedToken[];
  const units: MarkdownBlockUnit[] = [];
  const content: JSONContent[] = [];
  let offset = 0;
  for (const token of tokens) {
    const tokenStart = offset;
    offset += token.raw.length;
    if (token.type === "space") continue;
    const start = tokenStart + (token.raw.length - token.raw.replace(/^\n+/, "").length);
    const end = tokenStart + token.raw.trimEnd().length;
    if (end <= start) continue;
    const text = normalized.slice(start, end);
    const nodes = tokenIsEditable(token)
      ? (manager.parse(text).content ?? []).filter((node) => !isEmptyParagraphJson(node))
      : [{ type: MarkdownRawBlock.name, attrs: { source: text } }];
    if (nodes.length === 0) continue;
    units.push({ start, end, nodeCount: nodes.length });
    content.push(...nodes);
  }
  return {
    source: { original: markdown, normalized, crlf, units },
    doc: { type: "doc", content: content.length > 0 ? content : [{ type: "paragraph" }] },
  };
}

function isEmptyParagraphJson(node: JSONContent): boolean {
  return node.type === "paragraph" && (node.content?.length ?? 0) === 0;
}

function significantChildren(doc: ProseMirrorNode): ProseMirrorNode[] {
  const children: ProseMirrorNode[] = [];
  doc.forEach((child) => {
    if (child.type.name === "paragraph" && child.childCount === 0) return;
    children.push(child);
  });
  return children;
}

/**
 * Serializes the edited document while keeping the original text of every
 * unchanged leading and trailing block, so an edit rewrites only the blocks
 * it touched instead of reformatting the whole file.
 */
export function serializeMarkdownBlocks(
  source: MarkdownBlockSource,
  initialDoc: ProseMirrorNode,
  currentDoc: ProseMirrorNode,
  manager: MarkdownManager = markdownBlockManager(),
): string {
  if (initialDoc.eq(currentDoc)) return source.original;
  const before = significantChildren(initialDoc);
  const after = significantChildren(currentDoc);
  const { normalized, units } = source;
  // A document the schema reshaped on load cannot be matched to the source blocks.
  const mappable = units.reduce((count, unit) => count + unit.nodeCount, 0) === before.length;
  const unitMatches = (unitIndex: number, beforeStart: number, afterStart: number) => {
    const { nodeCount } = units[unitIndex]!;
    if (afterStart < 0 || afterStart + nodeCount > after.length) return false;
    for (let index = 0; index < nodeCount; index += 1) {
      if (!before[beforeStart + index]!.eq(after[afterStart + index]!)) return false;
    }
    return true;
  };

  let prefixUnits = 0;
  let prefixNodes = 0;
  let suffixUnits = 0;
  let suffixNodes = 0;
  if (mappable) {
    while (prefixUnits < units.length && unitMatches(prefixUnits, prefixNodes, prefixNodes)) {
      prefixNodes += units[prefixUnits]!.nodeCount;
      prefixUnits += 1;
    }
    while (prefixUnits + suffixUnits < units.length) {
      const unitIndex = units.length - 1 - suffixUnits;
      const { nodeCount } = units[unitIndex]!;
      const afterStart = after.length - suffixNodes - nodeCount;
      if (afterStart < prefixNodes) break;
      if (!unitMatches(unitIndex, before.length - suffixNodes - nodeCount, afterStart)) break;
      suffixNodes += nodeCount;
      suffixUnits += 1;
    }
  }

  const middleNodes = after.slice(prefixNodes, after.length - suffixNodes);
  const middle =
    middleNodes.length === 0
      ? ""
      : manager
          .serialize({ type: "doc", content: middleNodes.map((node) => node.toJSON()) })
          .replace(/^\n+|\n+$/g, "");

  const parts: string[] = [];
  let previous: number | "middle" | null = null;
  const pushUnit = (unitIndex: number) => {
    const unit = units[unitIndex]!;
    if (typeof previous === "number") {
      parts.push(
        previous === unitIndex - 1 ? normalized.slice(units[previous]!.end, unit.start) : "\n\n",
      );
    } else if (previous === "middle") {
      parts.push("\n\n");
    }
    parts.push(normalized.slice(unit.start, unit.end));
    previous = unitIndex;
  };
  for (let index = 0; index < prefixUnits; index += 1) pushUnit(index);
  if (middle.length > 0) {
    if (previous !== null) parts.push("\n\n");
    parts.push(middle);
    previous = "middle";
  }
  for (let index = units.length - suffixUnits; index < units.length; index += 1) pushUnit(index);

  const firstUnit = units[0];
  const lastUnit = units.at(-1);
  const head = firstUnit
    ? normalized.slice(0, firstUnit.start)
    : normalized.trimEnd() + (normalized.trim().length > 0 ? "\n\n" : "");
  const tail = lastUnit
    ? normalized.slice(lastUnit.end)
    : normalized === "" || normalized.endsWith("\n")
      ? "\n"
      : "";
  const body = parts.join("");
  const result = body.length > 0 ? head + body + tail : head.trimEnd() + tail;
  return source.crlf ? result.replace(/\n/g, "\r\n") : result;
}
