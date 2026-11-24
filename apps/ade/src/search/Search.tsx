import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { BellSimpleRingingIcon } from "@phosphor-icons/react/dist/csr/BellSimpleRinging";
import { BroadcastIcon } from "@phosphor-icons/react/dist/csr/Broadcast";
import { HardDrivesIcon } from "@phosphor-icons/react/dist/csr/HardDrives";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { NotePencilIcon } from "@phosphor-icons/react/dist/csr/NotePencil";
import { TerminalWindowIcon } from "@phosphor-icons/react/dist/csr/TerminalWindow";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandItemIcon,
  CommandList,
} from "@ui-sdk/react/command";
import { Dialog, DialogBackdrop, DialogContent, DialogTitle } from "@ui-sdk/react/dialog";
import { useShortcut, useShortcutHint } from "@ui-sdk/react/shortcuts";
import type { ReactNode } from "react";

import { VIEW_LINKS, viewAtom } from "../overview/Overview.tsx";
import { isFocusInTerminal } from "../panels/FloatingPanel.tsx";
import { useOpenToolPanel } from "../panels/ToolPanels.tsx";
import {
  listedThreadsAtom,
  ProjectTitle,
  selectedThreadKeyAtom,
  ThreadStateBadge,
  useDecisionsPanel,
} from "../sidebar/Sidebar.tsx";
import { threadState } from "../sidebar/sidebar.logic.ts";
import { searchOpenAtom } from "./SearchButton.tsx";

/**
 * Ctrl+K: the way to what is not on screen, the panels, the views, the machines and every
 * listed thread. Running a command closes it; the dialog gives focus back.
 */
export function Search(props: { onShowMachines: () => void; onNewThread: () => void }) {
  const [open, setOpen] = useAtom(searchOpenAtom);
  const threads = useAtomValue(listedThreadsAtom);
  const setSelected = useAtomSet(selectedThreadKeyAtom);
  const setView = useAtomSet(viewAtom);
  const openToolPanel = useOpenToolPanel();
  const decisions = useDecisionsPanel();
  const terminalKeys = useShortcutHint("mod+j").text || "Ctrl+J";
  const newThreadKeys = useShortcutHint("mod+shift+o").text || "Ctrl+Shift+O";
  useShortcut("mod+k", () => setOpen(!open), {
    when: () => !isFocusInTerminal(),
    description: "Buscar o ir a…",
  });
  const actions: Record<string, () => void> = {
    terminal: () => openToolPanel("terminal"),
    actividad: () => openToolPanel("actividad"),
    decisiones: () => decisions.setOpen(true),
    maquinas: props.onShowMachines,
    nuevo: props.onNewThread,
  };
  const item = (value: string, icon: ReactNode, label: string, aside?: ReactNode) => (
    <CommandItem key={value} value={value} label={label} className="ade-command-item">
      <CommandItemIcon>{icon}</CommandItemIcon>
      <span className="ade-command-label">{label}</span>
      {aside}
    </CommandItem>
  );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogBackdrop className="ade-search-backdrop" />
      <DialogContent className="ade-search">
        <DialogTitle className="ade-sr-only">Buscar o ir a…</DialogTitle>
        <Command
          className="ade-command"
          onAction={(value) => {
            setOpen(false);
            const view = VIEW_LINKS.find((link) => `vista:${link.target}` === value);
            if (value.startsWith("hilo:")) setSelected(value.slice("hilo:".length));
            else if (view !== undefined) setView(view.target);
            else actions[value]?.();
          }}
        >
          <div className="ade-command-row">
            <MagnifyingGlassIcon size={18} aria-hidden />
            <CommandInput
              aria-label="Buscar o ir a…"
              placeholder="Buscar hilos, vistas o paneles"
            />
            <kbd>Esc</kbd>
          </div>
          <CommandEmpty className="ade-panel-note">Nada coincide.</CommandEmpty>
          <CommandList className="ade-command-list">
            <CommandGroup>
              <CommandGroupLabel className="ade-command-group">Abrir</CommandGroupLabel>
              {item(
                "terminal",
                <TerminalWindowIcon size={16} aria-hidden />,
                "Terminal",
                <kbd>{terminalKeys}</kbd>,
              )}
              {item("actividad", <BroadcastIcon size={16} aria-hidden />, "Actividad en vivo")}
              {decisions.count === 0
                ? null
                : item(
                    "decisiones",
                    <BellSimpleRingingIcon size={16} aria-hidden />,
                    "Decisiones",
                    <span className="ade-command-aside">{decisions.count} te necesitan</span>,
                  )}
              {item(
                "maquinas",
                <HardDrivesIcon size={16} aria-hidden />,
                "Máquinas y emparejamiento",
              )}
              {item(
                "nuevo",
                <NotePencilIcon size={16} aria-hidden />,
                "Nuevo hilo",
                <kbd>{newThreadKeys}</kbd>,
              )}
            </CommandGroup>
            <CommandGroup>
              <CommandGroupLabel className="ade-command-group">Vistas</CommandGroupLabel>
              {VIEW_LINKS.map(({ target, label, Icon }) =>
                item(`vista:${target}`, <Icon size={16} aria-hidden />, label),
              )}
            </CommandGroup>
            {threads.length === 0 ? null : (
              <CommandGroup>
                <CommandGroupLabel className="ade-command-group">Hilos</CommandGroupLabel>
                {threads.map((thread) => {
                  const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
                  return (
                    <CommandItem
                      key={key}
                      value={`hilo:${key}`}
                      label={thread.title}
                      className="ade-command-item"
                    >
                      <CommandItemIcon>
                        <ThreadStateBadge state={threadState(thread)} />
                      </CommandItemIcon>
                      <span className="ade-command-label">{thread.title}</span>
                      <span className="ade-command-aside">
                        <ProjectTitle
                          environmentId={thread.environmentId}
                          projectId={thread.projectId}
                        />
                      </span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
