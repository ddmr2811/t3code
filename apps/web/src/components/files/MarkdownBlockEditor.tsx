import type { ChainedCommands, Editor } from "@tiptap/core";
import { Placeholder } from "@tiptap/extensions";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
  EditorContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type NodeViewProps,
  useEditor,
} from "@tiptap/react";
import {
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ListIcon,
  ListOrderedIcon,
  ListTodoIcon,
  type LucideIcon,
  MinusIcon,
  PilcrowIcon,
  SquareCodeIcon,
  TextQuoteIcon,
} from "lucide-react";
import { createContext, type ReactNode, use, useRef, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { cn } from "~/lib/utils";

import {
  MarkdownRawBlock,
  markdownBlockExtensions,
  parseMarkdownBlocks,
  serializeMarkdownBlocks,
} from "./markdownBlocks";

const RawBlockRenderContext = createContext<((source: string) => ReactNode) | null>(null);

function RawBlockView({ node, selected }: NodeViewProps) {
  const renderSource = use(RawBlockRenderContext);
  return (
    <NodeViewWrapper
      className={cn("markdown-block-editor-raw", selected && "is-selected")}
      contentEditable={false}
      title="Edit this block from the Markdown source view"
    >
      {renderSource?.(String(node.attrs.source ?? ""))}
    </NodeViewWrapper>
  );
}

const EDITOR_EXTENSIONS = [
  ...markdownBlockExtensions(
    MarkdownRawBlock.extend({ addNodeView: () => ReactNodeViewRenderer(RawBlockView) }),
  ),
  Placeholder.configure({
    placeholder: ({ node }) =>
      node.type.name === "heading" ? `Heading ${node.attrs.level}` : "Type '/' for commands",
  }),
];

interface SlashCommand {
  readonly label: string;
  readonly keywords: readonly string[];
  readonly icon: LucideIcon;
  readonly apply: (chain: ChainedCommands) => ChainedCommands;
}

const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    label: "Text",
    keywords: ["paragraph", "plain"],
    icon: PilcrowIcon,
    apply: (c) => c.setParagraph(),
  },
  {
    label: "Heading 1",
    keywords: ["h1", "title"],
    icon: Heading1Icon,
    apply: (c) => c.setHeading({ level: 1 }),
  },
  {
    label: "Heading 2",
    keywords: ["h2", "subtitle"],
    icon: Heading2Icon,
    apply: (c) => c.setHeading({ level: 2 }),
  },
  {
    label: "Heading 3",
    keywords: ["h3"],
    icon: Heading3Icon,
    apply: (c) => c.setHeading({ level: 3 }),
  },
  {
    label: "Bulleted list",
    keywords: ["ul", "unordered", "bullet"],
    icon: ListIcon,
    apply: (c) => c.toggleBulletList(),
  },
  {
    label: "Numbered list",
    keywords: ["ol", "ordered", "number"],
    icon: ListOrderedIcon,
    apply: (c) => c.toggleOrderedList(),
  },
  {
    label: "To-do list",
    keywords: ["todo", "task", "checkbox"],
    icon: ListTodoIcon,
    apply: (c) => c.toggleTaskList(),
  },
  {
    label: "Code block",
    keywords: ["code", "snippet", "pre"],
    icon: SquareCodeIcon,
    apply: (c) => c.setCodeBlock(),
  },
  {
    label: "Quote",
    keywords: ["blockquote", "quote"],
    icon: TextQuoteIcon,
    apply: (c) => c.setBlockquote(),
  },
  {
    label: "Divider",
    keywords: ["hr", "rule", "separator", "divider"],
    icon: MinusIcon,
    apply: (c) => c.setHorizontalRule(),
  },
];

function filterSlashCommands(query: string): readonly SlashCommand[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter(
    (command) =>
      command.label.toLowerCase().includes(needle) ||
      command.keywords.some((keyword) => keyword.startsWith(needle)),
  );
}

interface SlashTrigger {
  /** Document position of the `/`. */
  readonly from: number;
  readonly to: number;
  readonly query: string;
}

/** A `/` that starts a top-level paragraph opens the block menu, as in Notion. */
function readSlashTrigger(editor: Editor): SlashTrigger | null {
  const { selection } = editor.state;
  if (!selection.empty) return null;
  const { $from } = selection;
  if ($from.depth !== 1 || $from.parent.type.name !== "paragraph") return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼");
  const match = /^\/([\w-]{0,24})$/.exec(before);
  if (!match) return null;
  return { from: $from.start(), to: $from.pos, query: match[1] ?? "" };
}

interface SlashMenuState extends SlashTrigger {
  readonly left: number;
  readonly top: number;
}

export function MarkdownBlockEditor(props: {
  readonly markdown: string;
  readonly onChange: (markdown: string) => void;
  readonly renderRawBlock: (source: string) => ReactNode;
}) {
  // Callers remount on external file changes, so the source parses once per mount.
  const [parsed] = useState(() => parseMarkdownBlocks(props.markdown));
  const initialDocRef = useRef<ProseMirrorNode | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const lastMarkdownRef = useRef(props.markdown);
  const containerRef = useRef<HTMLDivElement>(null);
  const [slash, setSlash] = useState<SlashMenuState | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const commands = slash ? filterSlashCommands(slash.query) : [];
  const highlightIndex = Math.min(highlight, Math.max(commands.length - 1, 0));
  const menuOpen = slash !== null && commands.length > 0;

  const syncSlashMenu = (editor: Editor) => {
    const trigger = readSlashTrigger(editor);
    const container = containerRef.current;
    if (!trigger || !container || trigger.from === dismissedAt) {
      if (!trigger) setDismissedAt(null);
      setSlash(null);
      return;
    }
    const caret = editor.view.coordsAtPos(trigger.from);
    const box = container.getBoundingClientRect();
    if (slash?.from !== trigger.from || slash.query !== trigger.query) setHighlight(0);
    setSlash({ ...trigger, left: caret.left - box.left, top: caret.bottom - box.top + 4 });
  };

  const handleUpdate = useStableCallback((editor: Editor) => {
    const initialDoc = initialDocRef.current;
    if (initialDoc) {
      const next = serializeMarkdownBlocks(parsed.source, initialDoc, editor.state.doc);
      if (next !== lastMarkdownRef.current) {
        lastMarkdownRef.current = next;
        props.onChange(next);
      }
    }
    syncSlashMenu(editor);
  });
  const handleSelectionUpdate = useStableCallback(syncSlashMenu);

  const runCommand = (editor: Editor, command: SlashCommand, trigger: SlashTrigger) => {
    setSlash(null);
    command.apply(editor.chain().focus().deleteRange({ from: trigger.from, to: trigger.to })).run();
  };

  const handleKeyDown = useStableCallback((event: KeyboardEvent): boolean => {
    const editor = editorRef.current;
    if (!menuOpen || !slash || !editor || event.isComposing) return false;
    switch (event.key) {
      case "ArrowDown":
        setHighlight((highlightIndex + 1) % commands.length);
        return true;
      case "ArrowUp":
        setHighlight((highlightIndex - 1 + commands.length) % commands.length);
        return true;
      case "Enter":
      case "Tab": {
        const command = commands[highlightIndex];
        if (!command) return false;
        runCommand(editor, command, slash);
        return true;
      }
      case "Escape":
        setDismissedAt(slash.from);
        setSlash(null);
        return true;
      default:
        return false;
    }
  });

  const editor = useEditor({
    extensions: EDITOR_EXTENSIONS,
    content: parsed.doc,
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: {
        class: "chat-markdown markdown-block-editor",
        "aria-label": "Markdown document",
        "data-workspace-focus-default": "",
      },
      handleKeyDown: (_view, event) => handleKeyDown(event),
    },
    onCreate: ({ editor: created }) => {
      editorRef.current = created;
      initialDocRef.current = created.state.doc;
    },
    onUpdate: ({ editor: updated }) => handleUpdate(updated),
    onSelectionUpdate: ({ editor: updated }) => handleSelectionUpdate(updated),
    onBlur: () => setSlash(null),
  });

  return (
    <RawBlockRenderContext value={props.renderRawBlock}>
      <div ref={containerRef} className="relative mx-auto max-w-4xl px-6 py-5">
        <EditorContent editor={editor} />
        {menuOpen ? (
          <div
            role="listbox"
            aria-label="Insert block"
            className="absolute z-20 flex w-56 flex-col gap-0.5 rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg"
            style={{ left: slash.left, top: slash.top }}
            // Keep focus, and so the caret, in the document while picking.
            onMouseDown={(event) => event.preventDefault()}
          >
            {commands.map((command, index) => {
              const Icon = command.icon;
              return (
                <div
                  key={command.label}
                  role="option"
                  aria-selected={index === highlightIndex}
                  className={cn(
                    "flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-sm",
                    index === highlightIndex && "bg-accent text-accent-foreground",
                  )}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => runCommand(editor, command, slash)}
                >
                  <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  {command.label}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </RawBlockRenderContext>
  );
}
