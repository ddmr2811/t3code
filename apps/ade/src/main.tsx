import { RegistryContext, useAtom, useAtomValue } from "@effect/atom-react";
import { ArrowsLeftRightIcon } from "@phosphor-icons/react/dist/csr/ArrowsLeftRight";
import { UserCircleIcon } from "@phosphor-icons/react/dist/csr/UserCircle";
import { FoldersIcon } from "@phosphor-icons/react/dist/csr/Folders";
import { ListIcon } from "@phosphor-icons/react/dist/csr/List";
import { SidebarSimpleIcon } from "@phosphor-icons/react/dist/csr/SidebarSimple";
import { SquaresFourIcon } from "@phosphor-icons/react/dist/csr/SquaresFour";
import { TrayIcon } from "@phosphor-icons/react/dist/csr/Tray";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { useShortcut, useShortcutHint } from "@ui-sdk/react/shortcuts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@ui-sdk/react/tooltip";
import { StrictMode, useContext, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import "./ade.css";
import { BackgroundLayer, BackgroundPicker, useBackground } from "./Background.tsx";
import { followMachine } from "./connection/pairing.ts";
import { connectionAtomRuntime } from "./connection/runtime.ts";
import { onMachinesChanged } from "./connection/tabs.ts";
import { DecisionsPanel } from "./decisions/DecisionsPanel.tsx";
import { ConnectionSummary, hasInitialPairingRequest, MachinesSidebar } from "./Machines.tsx";
import { Overview, viewAtom, ViewNav } from "./overview/Overview.tsx";
import {
  mobileSidebarOpenAtom,
  narrowViewportAtom,
  NeedsYouBlock,
  ProjectRail,
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
  const { threads, open: trayOpen, setOpen: setTrayOpen } = useDecisionsPanel();
  const pendingCount = threads.length;

  const goView = (target: "resumen" | "proyectos" | "bots" | "respaldo") => {
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
          !drawerOpen && !trayOpen && !threadOpen && view === "resumen" ? "page" : undefined
        }
        onClick={() => goView("resumen")}
      >
        <SquaresFourIcon size={20} aria-hidden />
        <span>Resumen</span>
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
        aria-current={
          !drawerOpen && !trayOpen && !threadOpen && view === "respaldo" ? "page" : undefined
        }
        onClick={() => goView("respaldo")}
      >
        <ArrowsLeftRightIcon size={20} aria-hidden />
        <span>Respaldo</span>
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
        disabled={pendingCount === 0}
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

const isFocusInTerminal = () =>
  typeof document !== "undefined" &&
  document.activeElement instanceof Element &&
  document.activeElement.closest(".ade-terminal") !== null;

function Shell() {
  const registry = useContext(RegistryContext);
  const background = useBackground();
  const [drawerOpen, setDrawerOpen] = useAtom(mobileSidebarOpenAtom);
  const narrowViewport = useAtomValue(narrowViewportAtom);
  // Start collapsed on desktop unless a pairing link arrived in the URL and needs the form.
  const [sidebarExpanded, setSidebarExpanded] = useState(
    () => hasInitialPairingRequest || readSidebarExpanded(),
  );
  const toggleSidebar = () => {
    setSidebarExpanded((current) => {
      const next = !current;
      writeSidebarExpanded(next);
      return next;
    });
  };
  useShortcut("mod+b", toggleSidebar, {
    when: () => !narrowViewport && !isFocusInTerminal(),
    description: "Alternar la barra lateral",
  });
  const toggleHint = useShortcutHint("mod+b");
  const collapsed = !narrowViewport && !sidebarExpanded;
  const shortcutLabel = toggleHint.text || "Ctrl+B";

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
          {collapsed ? (
            <div className="ade-rail">
              <div className="ade-rail-brand" aria-hidden>
                <AdeMark />
              </div>
              <span className="ade-rail-sep" aria-hidden />
              <Tooltip>
                <TooltipTrigger
                  type="button"
                  className="ade-rail-button"
                  aria-label="Desplegar barra lateral"
                  aria-expanded={false}
                  aria-keyshortcuts={toggleHint.ariaKeyshortcuts}
                  onClick={toggleSidebar}
                >
                  <SidebarSimpleIcon size={19} aria-hidden />
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8} className="ade-rail-tooltip">
                  Desplegar · {shortcutLabel}
                </TooltipContent>
              </Tooltip>
              <ViewNav compact />
              <span className="ade-rail-sep" aria-hidden />
              <ProjectRail />
              <div className="ade-rail-footer">
                <BackgroundPicker compact {...background} />
              </div>
            </div>
          ) : (
            <>
              <div className="ade-brand-row">
                <div className="ade-brand">
                  <AdeMark className="ade-brand-mark" />
                  <span>ADE</span>
                </div>
                <Tooltip>
                  <TooltipTrigger
                    type="button"
                    className="ade-icon-button ade-sidebar-toggle"
                    aria-label="Recoger barra lateral"
                    aria-expanded={true}
                    aria-keyshortcuts={toggleHint.ariaKeyshortcuts}
                    onClick={toggleSidebar}
                  >
                    <SidebarSimpleIcon size={17} aria-hidden />
                  </TooltipTrigger>
                  <TooltipContent side="right" sideOffset={8} className="ade-rail-tooltip">
                    Recoger · {shortcutLabel}
                  </TooltipContent>
                </Tooltip>
                <button
                  type="button"
                  className="ade-icon-button ade-mobile-drawer-close"
                  aria-label="Cerrar menú lateral"
                  onClick={() => setDrawerOpen(false)}
                >
                  <XIcon size={18} aria-hidden />
                </button>
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
        <main className="ade-main">
          <MainContent />
        </main>
        <DecisionsPanel />
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
