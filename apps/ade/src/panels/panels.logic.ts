/**
 * The tool panel open beside the reading column. The terminal belongs to the thread it was opened
 * for, under that pairing: selecting another thread never starts a shell by itself.
 */
export type ToolPanel =
  | { readonly kind: "terminal"; readonly key: string | null; readonly pairing: string | null }
  | { readonly kind: "actividad" };

/**
 * Ctrl+J closes the terminal of the thread on screen; anything else (no terminal, another
 * thread's, or one from an older pairing) gives way to a terminal for the thread on screen.
 */
export function terminalAfterShortcut(
  panel: ToolPanel | null,
  selectedKey: string | null,
  pairing: string | null,
): ToolPanel | null {
  const showsThisOne =
    panel?.kind === "terminal" && panel.key === selectedKey && panel.pairing === pairing;
  return showsThisOne ? null : { kind: "terminal", key: selectedKey, pairing };
}
