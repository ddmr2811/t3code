import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { useShortcut } from "@ui-sdk/react/shortcuts";
import { Atom } from "effect/reactivity";
import { type ReactNode, useRef, useState } from "react";

import type { ToolPanel } from "./panels.logic.ts";

/**
 * Decisions keep their own open state, since they also open by themselves; they show only while
 * no tool panel is open, so one panel shows at a time.
 */
export const toolPanelAtom = Atom.make<ToolPanel | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("ade-tool-panel"),
);

/** The shell owns every key while it has focus, Ctrl+K, Ctrl+J, Ctrl+B and Escape included. */
export const isFocusInTerminal = () =>
  typeof document !== "undefined" &&
  document.activeElement instanceof Element &&
  document.activeElement.closest(".ade-terminal-mount") !== null;

/** App shortcuts stay out of the terminal and of a native dialog (the bot editor, an image). */
export const shortcutsFree = () =>
  !isFocusInTerminal() && document.querySelector("dialog[open]") === null;

/** Terminal, Actividad and Decisiones share this frame: a header with a close, Escape to close. */
export function FloatingPanel(props: {
  id?: string;
  label: string;
  icon: ReactNode;
  actions?: ReactNode;
  /** The terminal: wider, and the whole height. */
  wide?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  // Where focus was when the panel opened; closing gives it back if it had moved inside.
  const [before] = useState(() => document.activeElement);
  const focusIsOurs = () =>
    document.activeElement === document.body ||
    (ref.current?.contains(document.activeElement) ?? false);
  const close = () => {
    if (focusIsOurs()) {
      const target =
        before instanceof HTMLElement && before.isConnected
          ? before
          : document.querySelector<HTMLElement>(".ade-composer textarea, .ade-main");
      target?.focus();
    }
    props.onClose();
  };
  // Escape belongs to whatever has focus outside the panel: the composer, a menu, a search field.
  useShortcut("escape", close, {
    when: () => shortcutsFree() && focusIsOurs(),
    allowInInput: true,
    description: `Cerrar ${props.label}`,
  });
  return (
    <aside
      ref={ref}
      id={props.id}
      className="ade-panel"
      data-wide={props.wide ? "" : undefined}
      aria-label={props.label}
    >
      <header className="ade-panel-header">
        {props.icon}
        <h2 className="ade-panel-title">{props.label}</h2>
        {props.actions}
        <button
          type="button"
          className="ade-icon-button"
          aria-label={`Cerrar ${props.label.toLowerCase()}`}
          onClick={close}
        >
          <XIcon size={16} aria-hidden />
        </button>
      </header>
      {props.children}
    </aside>
  );
}
