import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

/**
 * Top-level positions a folded heading hides: every block after it up to the
 * next heading of the same or a higher level, as in a Notion toggle heading.
 */
export function foldedBlockPositions(
  doc: ProseMirrorNode,
  foldedHeadings: ReadonlySet<number>,
): number[] {
  const hidden: number[] = [];
  let foldLevel: number | null = null;
  doc.forEach((node, position) => {
    const level = node.type.name === "heading" ? Number(node.attrs.level) : null;
    if (foldLevel !== null) {
      if (level === null || level > foldLevel) {
        hidden.push(position);
        return;
      }
      foldLevel = null;
    }
    if (level !== null && foldedHeadings.has(position)) foldLevel = level;
  });
  return hidden;
}

/** Unfolds whichever sections hide `position`, so the caret is never in hidden text. */
export function revealPosition(
  doc: ProseMirrorNode,
  foldedHeadings: ReadonlySet<number>,
  position: number,
): ReadonlySet<number> {
  let folded = foldedHeadings;
  for (;;) {
    const hiddenStart = foldedBlockPositions(doc, folded).find((start) => {
      const node = doc.nodeAt(start);
      return node !== null && start <= position && position < start + node.nodeSize;
    });
    if (hiddenStart === undefined) return folded;
    const owner = Math.max(...[...folded].filter((heading) => heading < hiddenStart));
    if (!Number.isFinite(owner)) return folded;
    folded = new Set([...folded].filter((heading) => heading !== owner));
  }
}

interface FoldState {
  readonly folded: ReadonlySet<number>;
  readonly decorations: DecorationSet;
}

const foldKey = new PluginKey<FoldState>("markdownHeadingFold");

function foldToggle(view: EditorView, getPos: () => number | undefined, folded: boolean) {
  const button = document.createElement("button");
  button.type = "button";
  button.contentEditable = "false";
  button.className = "markdown-fold-toggle";
  button.setAttribute("aria-label", folded ? "Expand section" : "Collapse section");
  button.setAttribute("aria-expanded", String(!folded));
  // Keep the caret where it was; clicking only folds.
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", (event) => {
    event.preventDefault();
    const widgetPosition = getPos();
    if (widgetPosition === undefined) return;
    view.dispatch(view.state.tr.setMeta(foldKey, widgetPosition - 1));
  });
  return button;
}

function buildDecorations(doc: ProseMirrorNode, folded: ReadonlySet<number>): DecorationSet {
  const hidden = new Set(foldedBlockPositions(doc, folded));
  const decorations: Decoration[] = [];
  doc.forEach((node, position) => {
    const end = position + node.nodeSize;
    if (hidden.has(position)) {
      decorations.push(Decoration.node(position, end, { class: "markdown-fold-hidden" }));
      return;
    }
    if (node.type.name !== "heading") return;
    const isFolded = folded.has(position);
    decorations.push(
      Decoration.node(position, end, {
        class: isFolded ? "markdown-fold-heading is-folded" : "markdown-fold-heading",
      }),
      Decoration.widget(position + 1, (view, getPos) => foldToggle(view, getPos, isFolded), {
        side: -1,
        ignoreSelection: true,
        key: `fold:${isFolded}`,
      }),
    );
  });
  return DecorationSet.create(doc, decorations);
}

function nextFolded(state: FoldState, tr: Transaction, newState: EditorState) {
  let folded = state.folded;
  if (tr.docChanged) {
    folded = new Set(
      [...folded]
        .map((position) => tr.mapping.mapResult(position))
        .filter((result) => !result.deleted)
        .map((result) => result.pos)
        .filter((position) => newState.doc.nodeAt(position)?.type.name === "heading"),
    );
  }
  const toggled = tr.getMeta(foldKey) as number | undefined;
  if (toggled !== undefined) {
    const next = new Set(folded);
    if (!next.delete(toggled)) next.add(toggled);
    folded = next;
  }
  if (folded.size > 0 && (tr.docChanged || tr.selectionSet)) {
    folded = revealPosition(newState.doc, folded, newState.selection.from);
  }
  return folded;
}

/** Folds sections under headings in the view only; the file never changes. */
export const MarkdownHeadingFold = Extension.create({
  name: "markdownHeadingFold",
  addProseMirrorPlugins() {
    return [
      new Plugin<FoldState>({
        key: foldKey,
        state: {
          init: (_config, state) => ({
            folded: new Set(),
            decorations: buildDecorations(state.doc, new Set()),
          }),
          apply: (tr, value, _oldState, newState) => {
            const folded = nextFolded(value, tr, newState);
            if (!tr.docChanged && folded === value.folded) return value;
            return { folded, decorations: buildDecorations(newState.doc, folded) };
          },
        },
        props: {
          decorations: (state) => foldKey.getState(state)?.decorations,
        },
      }),
    ];
  },
});
