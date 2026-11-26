import { useAtom } from "@effect/atom-react";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { useShortcutHint } from "@ui-sdk/react/shortcuts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@ui-sdk/react/tooltip";
import { Atom } from "effect/reactivity";

/** Open, closed, or open on the projects alone (Inicio's «Más…»). */
export const searchOpenAtom = Atom.make<boolean | "proyectos">(false).pipe(
  Atom.keepAlive,
  Atom.withLabel("ade-search-open"),
);

const LABEL = "Buscar o ir a…";

/** Opens the search: a pill in the thread header, an icon on the rail and in the sidebar. */
export function SearchButton(props: { variant?: "rail" | "icon" }) {
  const [open, setOpen] = useAtom(searchOpenAtom);
  const hint = useShortcutHint("mod+k");
  const keys = hint.text || "Ctrl+K";
  if (props.variant === undefined) {
    return (
      <button
        type="button"
        className="ade-search-button"
        aria-label="Buscar"
        aria-haspopup="dialog"
        aria-expanded={open !== false}
        aria-keyshortcuts={hint.ariaKeyshortcuts}
        onClick={() => setOpen(true)}
      >
        <MagnifyingGlassIcon size={15} aria-hidden />
        <span className="ade-search-button-text">Buscar</span>
        <kbd>{keys}</kbd>
      </button>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger
        type="button"
        className={props.variant === "rail" ? "ade-rail-button" : "ade-icon-button"}
        aria-label={LABEL}
        aria-haspopup="dialog"
        aria-expanded={open !== false}
        aria-keyshortcuts={hint.ariaKeyshortcuts}
        onClick={() => setOpen(true)}
      >
        <MagnifyingGlassIcon size={props.variant === "rail" ? 19 : 17} aria-hidden />
      </TooltipTrigger>
      <TooltipContent
        side={props.variant === "rail" ? "right" : "bottom"}
        sideOffset={8}
        className="ade-rail-tooltip"
      >
        {LABEL} · {keys}
      </TooltipContent>
    </Tooltip>
  );
}
