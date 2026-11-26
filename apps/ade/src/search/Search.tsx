import { RegistryContext, useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { BellSimpleRingingIcon } from "@phosphor-icons/react/dist/csr/BellSimpleRinging";
import { BroadcastIcon } from "@phosphor-icons/react/dist/csr/Broadcast";
import { HardDrivesIcon } from "@phosphor-icons/react/dist/csr/HardDrives";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { FolderIcon } from "@phosphor-icons/react/dist/csr/Folder";
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
import { type ReactNode, type RefObject, useContext, useRef, useState } from "react";

import { homeProjectsAtom, selectedHomeProjectKeyAtom } from "../home/Home.tsx";
import { VIEW_LINKS, viewAtom } from "../overview/Overview.tsx";
import { shortcutsFree } from "../panels/FloatingPanel.tsx";
import { openToolPanel } from "../panels/ToolPanels.tsx";
import {
  listedThreadsAtom,
  ProjectTitle,
  selectedThreadKeyAtom,
  ThreadStateBadge,
  useDecisionsPanel,
} from "../sidebar/Sidebar.tsx";
import { resolveThreadStatusKind } from "@t3tools/client-runtime/state/thread-status";
import { searchOpenAtom } from "./SearchButton.tsx";

const RECENT_THREADS = 50;

/**
 * Ctrl+K: the way to what is not on screen, the panels, the views, the machines, the projects
 * (choosing one starts Inicio there) and the threads; Inicio's «Más…» opens it on the projects.
 * Its list mounts only while it is open; running a command closes it and the dialog gives focus
 * back.
 */
export function Search(props: { onShowMachines: () => void; onNewThread: () => void }) {
  const [open, setOpen] = useAtom(searchOpenAtom);
  const content = useRef<HTMLDivElement>(null);
  useShortcut("mod+k", () => setOpen(true), {
    when: shortcutsFree,
    description: "Buscar o ir a…",
  });
  return (
    <Dialog open={open !== false} onOpenChange={setOpen}>
      <DialogBackdrop className="ade-search-backdrop" />
      <DialogContent ref={content} className="ade-search">
        <DialogTitle className="ade-sr-only">Buscar o ir a…</DialogTitle>
        <SearchCommands
          {...props}
          onlyProjects={open === "proyectos"}
          layer={content}
          onClose={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function SearchCommands(props: {
  layer: RefObject<HTMLDivElement | null>;
  onlyProjects: boolean;
  onClose: () => void;
  onShowMachines: () => void;
  onNewThread: () => void;
}) {
  const registry = useContext(RegistryContext);
  const threads = useAtomValue(listedThreadsAtom);
  const setSelected = useAtomSet(selectedThreadKeyAtom);
  const setView = useAtomSet(viewAtom);
  const { projects, machineCount } = useAtomValue(homeProjectsAtom);
  const setHomeProject = useAtomSet(selectedHomeProjectKeyAtom);
  const decisions = useDecisionsPanel();
  const [query, setQuery] = useState("");
  const terminalKeys = useShortcutHint("mod+j").text || "Ctrl+J";
  const newThreadKeys = useShortcutHint("mod+shift+o").text || "Ctrl+Shift+O";
  // Page shortcuts pause while the dialog is open; this one belongs to it.
  useShortcut("mod+k", props.onClose, { layer: props.layer, description: "Cerrar el buscador" });
  // Before a query, only the most recent threads: every row reads its project's name.
  const shown =
    query.trim() === ""
      ? [...threads].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, RECENT_THREADS)
      : threads;
  const actions: Record<string, () => void> = {
    terminal: () => openToolPanel(registry, "terminal"),
    actividad: () => openToolPanel(registry, "actividad"),
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
    <Command
      className="ade-command"
      query={query}
      onQueryChange={(next) => setQuery(next)}
      onAction={(value) => {
        props.onClose();
        const view = VIEW_LINKS.find((link) => `vista:${link.target}` === value);
        if (value.startsWith("hilo:")) setSelected(value.slice("hilo:".length));
        else if (value.startsWith("proyecto:")) {
          setHomeProject(value.slice("proyecto:".length));
          setView("inicio");
        } else if (view !== undefined) setView(view.target);
        else actions[value]?.();
      }}
    >
      <div className="ade-command-row">
        <MagnifyingGlassIcon size={18} aria-hidden />
        <CommandInput
          aria-label={props.onlyProjects ? "Buscar proyecto" : "Buscar o ir a…"}
          placeholder={props.onlyProjects ? "Buscar proyecto" : "Buscar hilos, proyectos o vistas"}
        />
        <kbd>Esc</kbd>
      </div>
      <CommandEmpty className="ade-panel-note">Nada coincide.</CommandEmpty>
      <CommandList className="ade-command-list">
        {props.onlyProjects ? null : (
          <CommandGroup>
            <CommandGroupLabel className="ade-command-group">Abrir</CommandGroupLabel>
            {item(
              "terminal",
              <TerminalWindowIcon size={16} aria-hidden />,
              "Terminal",
              <kbd>{terminalKeys}</kbd>,
            )}
            {item("actividad", <BroadcastIcon size={16} aria-hidden />, "Actividad en vivo")}
            {decisions.count === 0 && decisions.snoozedCount === 0
              ? null
              : item(
                  "decisiones",
                  <BellSimpleRingingIcon size={16} aria-hidden />,
                  "Decisiones",
                  <span className="ade-command-aside">
                    {decisions.count > 0
                      ? `${decisions.count} te necesitan`
                      : `${decisions.snoozedCount} pospuestas`}
                  </span>,
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
        )}
        {props.onlyProjects ? null : (
          <CommandGroup>
            <CommandGroupLabel className="ade-command-group">Vistas</CommandGroupLabel>
            {VIEW_LINKS.map(({ target, label, Icon }) =>
              item(`vista:${target}`, <Icon size={16} aria-hidden />, label),
            )}
          </CommandGroup>
        )}
        {projects.length === 0 ? null : (
          <CommandGroup>
            <CommandGroupLabel className="ade-command-group">Proyectos</CommandGroupLabel>
            {projects.map((target) =>
              item(
                `proyecto:${target.key}`,
                <FolderIcon size={16} aria-hidden />,
                target.project.title,
                machineCount > 1 ? (
                  <span className="ade-command-aside">{target.machineLabel}</span>
                ) : undefined,
              ),
            )}
          </CommandGroup>
        )}
        {props.onlyProjects || shown.length === 0 ? null : (
          <CommandGroup>
            <CommandGroupLabel className="ade-command-group">Hilos</CommandGroupLabel>
            {shown.map((thread) => {
              const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
              return (
                <CommandItem
                  key={key}
                  value={`hilo:${key}`}
                  label={thread.title}
                  className="ade-command-item"
                >
                  <CommandItemIcon>
                    <ThreadStateBadge kind={resolveThreadStatusKind(thread)} />
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
  );
}
