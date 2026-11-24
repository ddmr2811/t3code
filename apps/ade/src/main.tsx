import { RegistryContext, useAtom, useAtomValue } from "@effect/atom-react";
import { ArrowsLeftRightIcon } from "@phosphor-icons/react/dist/csr/ArrowsLeftRight";
import { UserCircleIcon } from "@phosphor-icons/react/dist/csr/UserCircle";
import { FoldersIcon } from "@phosphor-icons/react/dist/csr/Folders";
import { ListIcon } from "@phosphor-icons/react/dist/csr/List";
import { SquaresFourIcon } from "@phosphor-icons/react/dist/csr/SquaresFour";
import { TrayIcon } from "@phosphor-icons/react/dist/csr/Tray";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { StrictMode, useContext, useEffect } from "react";
import { createRoot } from "react-dom/client";

// Shared with apps/web's fork rather than copied: same fonts, same dither code.
import { gradientFillStyle } from "../../web/src/fork/dither/style.ts";
import "./ade.css";
import { followMachine } from "./connection/pairing.ts";
import { connectionAtomRuntime } from "./connection/runtime.ts";
import { onMachinesChanged } from "./connection/tabs.ts";
import { DecisionsPanel } from "./decisions/DecisionsPanel.tsx";
import { ConnectionSummary, MachinesSidebar } from "./Machines.tsx";
import { Overview, viewAtom, ViewNav } from "./overview/Overview.tsx";
import {
  mobileSidebarOpenAtom,
  NeedsYouBlock,
  SelectedThread,
  selectedThreadKeyAtom,
  ThreadTree,
  useDecisionsPanel,
} from "./sidebar/Sidebar.tsx";

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

function Shell() {
  const registry = useContext(RegistryContext);
  const [drawerOpen, setDrawerOpen] = useAtom(mobileSidebarOpenAtom);
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
    <div className="ade-shell" data-mobile-drawer={drawerOpen ? "open" : undefined}>
      <aside className="ade-sidebar">
        <div className="ade-brand-row">
          <div className="ade-brand">ADE</div>
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
        </div>
      </aside>
      <main className="ade-main">
        <span
          aria-hidden
          className="ade-dither"
          style={gradientFillStyle({ edge: "right", length: 220, from: 0.6, to: 0 })}
        />
        <MainContent />
      </main>
      <DecisionsPanel />
      <MobileBottomNav />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
);
