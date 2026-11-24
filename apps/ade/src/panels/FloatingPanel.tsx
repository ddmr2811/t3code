import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { useShortcut } from "@ui-sdk/react/shortcuts";
import { Atom } from "effect/reactivity";
import { type ReactNode, useRef, useState } from "react";

/**
 * The tool panel open beside the reading column. Decisions keep their own open state, since they
 * also open by themselves; they show only while no tool panel is open, so one shows at a time.
 * The terminal keeps the pairing it was opened under: a re-paired machine is not reopened alone.
 */
export type ToolPanel =
  | { readonly kind: "terminal"; readonly pairing: string | null }
  | { readonly kind: "actividad" };

export const toolPanelAtom = Atom.make<ToolPanel | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("ade-tool-panel"),
);

/** The shell owns every key while it has focus, Ctrl+K, Ctrl+J, Ctrl+B and Escape included. */
export const isFocusInTerminal = () =>
  typeof document !== "undefined" &&
  document.activeElement instanceof Element &&
  document.activeElement.closest(".ade-terminal") !== null;

/** Terminal, Actividad and Decisiones share this frame: a header with a close, Escape to close. */
export function FloatingPanel(props: {
  id?: string;
  label: string;
  icon: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  // Where focus was when the panel opened; closing gives it back if it had moved inside.
  const [before] = useState(() => document.activeElement);
  const close = () => {
    if (ref.current?.contains(document.activeElement) && before instanceof HTMLElement) {
      before.focus();
    }
    props.onClose();
  };
  useShortcut("escape", close, {
    when: () => !isFocusInTerminal(),
    allowInInput: true,
    description: `Cerrar ${props.label}`,
  });
  return (
    <aside ref={ref} id={props.id} className="ade-panel" aria-label={props.label}>
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
