import { RegistryContext, useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { FoldersIcon } from "@phosphor-icons/react/dist/csr/Folders";
import { ListIcon } from "@phosphor-icons/react/dist/csr/List";
import { NotePencilIcon } from "@phosphor-icons/react/dist/csr/NotePencil";
import { SidebarSimpleIcon } from "@phosphor-icons/react/dist/csr/SidebarSimple";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/dist/csr/MagnifyingGlass";
import { TrayIcon } from "@phosphor-icons/react/dist/csr/Tray";
import { UserCircleIcon } from "@phosphor-icons/react/dist/csr/UserCircle";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { useShortcut, useShortcutHint } from "@ui-sdk/react/shortcuts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@ui-sdk/react/tooltip";
import { StrictMode, useContext, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import "./ade.css";
import "./backroom/backroom.css";
import "./backroom/screens.css";
import { SideNav } from "./backroom/SideNav.tsx";
import { BackgroundLayer, BackgroundPicker, useBackground } from "./Background.tsx";
import { followMachine } from "./connection/pairing.ts";
import { connectionAtomRuntime, environmentCatalog } from "./connection/runtime.ts";
import { onMachinesChanged } from "./connection/tabs.ts";
import { DecisionsPanel } from "./decisions/DecisionsPanel.tsx";
import { shortcutsFree, toolPanelAtom } from "./panels/FloatingPanel.tsx";
import { ToolPanels } from "./panels/ToolPanels.tsx";
import { Search } from "./search/Search.tsx";
import { SearchButton, searchOpenAtom } from "./search/SearchButton.tsx";
import {
  ConnectionSummary,
  hasInitialPairingRequest,
  MachinesSidebar,
  MachineSwitch,
} from "./Machines.tsx";
import { Overview, viewAtom, ViewNav } from "./overview/Overview.tsx";
import {
  mobileSidebarOpenAtom,
  crowdedViewportAtom,
  narrowViewportAtom,
  NeedsYouBlock,
  SelectedThread,
  selectedThreadKeyAtom,
  ThreadTree,
  useDecisionsPanel,
} from "./sidebar/Sidebar.tsx";
import { readSidebarExpanded, writeSidebarExpanded } from "./sidebar/sidebar.logic.ts";

function MainContent() {
  return useAtomValue(selectedThreadKeyAtom) === null ? <Overview /> : <SelectedThread />;
}

function MobileBottomNav() {
  const [view, setView] = useAtom(viewAtom);
  const [drawerOpen, setDrawerOpen] = useAtom(mobileSidebarOpenAtom);
  const threadOpen = useAtomValue(selectedThreadKeyAtom) !== null;
  const {
    count: pendingCount,
    snoozedCount,
    open: trayOpen,
    setOpen: setTrayOpen,
  } = useDecisionsPanel();

  const setSearchOpen = useAtomSet(searchOpenAtom);
  const goView = (target: "inicio" | "proyectos" | "bots") => {
    setDrawerOpen(false);
    setTrayOpen(false);
    setView(target);
  };

  return (
    <nav className="ade-mobile-nav" aria-label="Navegación móvil">
      <button
        type="button"
        className="ade-mobile-nav-item"
        aria-current={
          !drawerOpen && !trayOpen && !threadOpen && view === "inicio" ? "page" : undefined
        }
        onClick={() => goView("inicio")}
      >
        <NotePencilIcon size={20} aria-hidden />
        <span>Inicio</span>
      </button>
      {/* Resumen and the other views are in the search, as on the desktop rail. */}
      <button
        type="button"
        className="ade-mobile-nav-item"
        aria-haspopup="dialog"
        onClick={() => {
          setDrawerOpen(false);
          setSearchOpen(true);
        }}
      >
        <MagnifyingGlassIcon size={20} aria-hidden />
        <span>Buscar</span>
      </button>
      <button
        type="button"
        className="ade-mobile-nav-item"
        aria-current={
          !drawerOpen && !trayOpen && !threadOpen && view === "proyectos" ? "page" : undefined
        }
        onClick={() => goView("proyectos")}
      >
        <FoldersIcon size={20} aria-hidden />
        <span>Proyectos</span>
      </button>
      <button
        type="button"
        className="ade-mobile-nav-item"
        aria-current={
          !drawerOpen && !trayOpen && !threadOpen && view === "bots" ? "page" : undefined
        }
        onClick={() => goView("bots")}
      >
        <UserCircleIcon size={20} aria-hidden />
        <span>Bots</span>
      </button>
      <button
        type="button"
        className="ade-mobile-nav-item"
        aria-pressed={drawerOpen}
        onClick={() => {
          setTrayOpen(false);
          setDrawerOpen(!drawerOpen);
        }}
      >
        <ListIcon size={20} aria-hidden />
        <span>Hilos</span>
      </button>
      <button
        type="button"
        className="ade-mobile-nav-item"
        data-has-pending={pendingCount > 0 ? "" : undefined}
        aria-pressed={trayOpen}
        disabled={pendingCount === 0 && snoozedCount === 0}
        onClick={() => {
          setDrawerOpen(false);
          setTrayOpen(!trayOpen);
        }}
      >
        <span className="ade-mobile-nav-icon">
          <TrayIcon size={20} aria-hidden />
          {pendingCount > 0 ? <span className="ade-mobile-nav-badge">{pendingCount}</span> : null}
        </span>
        <span>Bandeja</span>
      </button>
    </nav>
  );
}

function AdeMark(props: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      className={props.className}
      aria-hidden
    >
      <path d="M5 12a7 7 0 0 1 14 0H5Z" fill="currentColor" />
      <rect x="4" y="14.5" width="16" height="1.8" rx="0.9" fill="currentColor" opacity="0.82" />
      <rect x="6.5" y="18" width="11" height="1.6" rx="0.8" fill="currentColor" opacity="0.56" />
    </svg>
  );
}

function Shell() {
  const registry = useContext(RegistryContext);
  const background = useBackground();
  const [drawerOpen, setDrawerOpen] = useAtom(mobileSidebarOpenAtom);
  const [view, setView] = useAtom(viewAtom);
  const threadOpen = useAtomValue(selectedThreadKeyAtom) !== null;
  const narrowViewport = useAtomValue(narrowViewportAtom);
  const crowdedViewport = useAtomValue(crowdedViewportAtom);
  const [toolPanel, setToolPanel] = useAtom(toolPanelAtom);
  const toolPanelOpen = toolPanel !== null;
  const { open: decisionsOpen, setOpen: setDecisionsOpen } = useDecisionsPanel();
  const panelOpen = toolPanelOpen || decisionsOpen;
  const hasMachines = useAtomValue(environmentCatalog.catalogValueAtom).entries.size > 0;
  // Start collapsed on desktop unless a pairing link arrived in the URL and needs the form.
  const [sidebarExpanded, setSidebarExpanded] = useState(
    () => hasInitialPairingRequest || readSidebarExpanded(),
  );
  const setExpanded = (next: boolean) => {
    setSidebarExpanded(next);
    writeSidebarExpanded(next);
  };
  // Keep the sidebar expanded while there are no machines so the pairing UI stays reachable.
  // A panel on a window under 1200 px folds the sidebar to its rail while it is open, so the
  // reading column keeps its room; the saved choice stays as it was.
  const collapsed =
    !narrowViewport && hasMachines && (!sidebarExpanded || (crowdedViewport && panelOpen));
  // Expanding a sidebar folded only by a panel closes the panel instead of flipping the choice.
  const expandSidebar = () => {
    if (sidebarExpanded) {
      setToolPanel(null);
      setDecisionsOpen(false);
    } else setExpanded(true);
  };
  const toggleSidebar = () => (collapsed ? expandSidebar() : setExpanded(false));
  const openHome = () => {
    setDrawerOpen(false);
    setView("inicio");
  };
  // Machines and pairing live in the expanded sidebar (the drawer on a phone).
  const showMachines = () => {
    if (narrowViewport) setDrawerOpen(true);
    else expandSidebar();
    requestAnimationFrame(() => document.getElementById("ade-add-machine")?.focus());
  };
  useShortcut("mod+b", toggleSidebar, {
    when: () => !narrowViewport && hasMachines && shortcutsFree(),
    description: "Alternar la barra lateral",
  });
  useShortcut("mod+shift+o", openHome, {
    when: () => hasMachines && shortcutsFree(),
    description: "Nuevo hilo",
  });
  const toggleHint = useShortcutHint("mod+b");
  const newThreadHint = useShortcutHint("mod+shift+o");
  const shortcutLabel = toggleHint.text || "Ctrl+B";
  const newThreadShortcutLabel = newThreadHint.text || "Ctrl+Shift+O";
  const isHome = hasMachines && !threadOpen && view === "inicio";

  // The Backroom sidebar is the folded state; unfolding it shows the threads and the machines.
  const sideNav = collapsed || (narrowViewport && hasMachines);
  const sidebarToggle = (
    <Tooltip>
      <TooltipTrigger
        type="button"
        className="ade-icon-button ade-sidebar-toggle"
        aria-label={collapsed ? "Ver hilos y máquinas" : "Volver al menú"}
        aria-expanded={!collapsed}
        aria-keyshortcuts={toggleHint.ariaKeyshortcuts}
        onClick={toggleSidebar}
      >
        <SidebarSimpleIcon size={17} aria-hidden />
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={8} className="ade-rail-tooltip">
        {collapsed ? "Hilos y máquinas" : "Menú"} · {shortcutLabel}
      </TooltipContent>
    </Tooltip>
  );
  const closeDrawer = (
    <button
      type="button"
      className="ade-icon-button ade-mobile-drawer-close"
      aria-label="Cerrar menú lateral"
      onClick={() => setDrawerOpen(false)}
    >
      <XIcon size={18} aria-hidden />
    </button>
  );

  useEffect(
    () =>
      onMachinesChanged((environmentId) =>
        environmentId === null
          ? registry.refresh(connectionAtomRuntime)
          : void runAtomCommand(registry, followMachine, environmentId),
      ),
    [registry],
  );
  return (
    <>
      <BackgroundLayer pref={background.pref} customImage={background.customImage} />
      <div
        className="ade-shell"
        data-mobile-drawer={drawerOpen ? "open" : undefined}
        data-sidebar={collapsed ? "collapsed" : "expanded"}
      >
        <aside className="ade-sidebar" aria-label="Barra lateral">
          {sideNav ? (
            <SideNav
              brand={
                <>
                  <AdeMark className="ade-brand-mark" />
                  <span>ADE</span>
                  <SearchButton variant="icon" />
                  {narrowViewport ? closeDrawer : sidebarToggle}
                </>
              }
              isHome={isHome}
              homeShortcut={newThreadHint.ariaKeyshortcuts}
              onHome={openHome}
              machines={<MachineSwitch onOpen={showMachines} />}
              settings={<BackgroundPicker compact {...background} />}
            >
              {/* On a phone this is the drawer, so the threads and the machines stay in reach. */}
              {narrowViewport ? (
                <>
                  <ThreadTree />
                  <MachinesSidebar />
                </>
              ) : null}
            </SideNav>
          ) : (
            <>
              <div className="ade-brand-row">
                <div className="ade-brand">
                  <AdeMark className="ade-brand-mark" />
                  <span>ADE</span>
                </div>
                <div className="ade-brand-actions">
                  {hasMachines ? <SearchButton variant="icon" /> : null}
                  {hasMachines ? (
                    <Tooltip>
                      <TooltipTrigger
                        type="button"
                        className="ade-icon-button ade-new-thread-button"
                        aria-label="Nuevo hilo"
                        aria-current={isHome ? "page" : undefined}
                        aria-keyshortcuts={newThreadHint.ariaKeyshortcuts}
                        onClick={openHome}
                      >
                        <NotePencilIcon size={17} aria-hidden />
                      </TooltipTrigger>
                      <TooltipContent side="bottom" sideOffset={8} className="ade-rail-tooltip">
                        Nuevo hilo · {newThreadShortcutLabel}
                      </TooltipContent>
                    </Tooltip>
                  ) : null}
                  {hasMachines ? sidebarToggle : null}
                  {closeDrawer}
                </div>
              </div>
              <NeedsYouBlock />
              <ViewNav />
              <ThreadTree />
              <MachinesSidebar />
              <div className="ade-sidebar-footer">
                <ConnectionSummary />
                <BackgroundPicker {...background} />
              </div>
            </>
          )}
        </aside>
        {/* Focusable so a closing panel has somewhere to give focus back to. */}
        <main className="ade-main" tabIndex={-1}>
          <MainContent />
        </main>
        <DecisionsPanel />
        <ToolPanels />
        <Search onShowMachines={showMachines} onNewThread={openHome} />
        <MobileBottomNav />
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
);
