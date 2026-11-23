import { RegistryContext, useAtomValue } from "@effect/atom-react";
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
import { Overview, ViewNav } from "./overview/Overview.tsx";
import {
  NeedsYouBlock,
  SelectedThread,
  selectedThreadKeyAtom,
  ThreadTree,
} from "./sidebar/Sidebar.tsx";

function MainContent() {
  return useAtomValue(selectedThreadKeyAtom) === null ? <Overview /> : <SelectedThread />;
}

function Shell() {
  const registry = useContext(RegistryContext);
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
    <div className="ade-shell">
      <aside className="ade-sidebar">
        <div className="ade-brand">ADE</div>
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
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
);
