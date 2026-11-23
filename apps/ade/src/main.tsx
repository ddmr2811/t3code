import { PlugsIcon } from "@phosphor-icons/react/dist/csr/Plugs";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// Shared with apps/web's fork rather than copied: same fonts, same dither code.
import { gradientFillStyle } from "../../web/src/fork/dither/style.ts";
import "./ade.css";
import { ConnectionSummary, MachineCards, MachinesSidebar } from "./Machines.tsx";

function Shell() {
  return (
    <div className="ade-shell">
      <aside className="ade-sidebar">
        <div className="ade-brand">ADE</div>
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
        {/* The empty state shows through only while MachineCards renders nothing. */}
        <MachineCards />
        <section className="ade-empty">
          <PlugsIcon size={28} />
          <h1>Sin conectar</h1>
          <p>Empareja una máquina con T3 Code desde la barra lateral para empezar.</p>
        </section>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
);
