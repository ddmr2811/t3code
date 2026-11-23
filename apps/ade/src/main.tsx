import { HardDrivesIcon } from "@phosphor-icons/react/dist/csr/HardDrives";
import { PlugsIcon } from "@phosphor-icons/react/dist/csr/Plugs";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// Shared with apps/web's fork rather than copied: same fonts, same dither code.
import { gradientFillStyle } from "../../web/src/fork/dither/style.ts";
import "./ade.css";

function Shell() {
  return (
    <div className="ade-shell">
      <aside className="ade-sidebar">
        <div className="ade-brand">ADE</div>
        <div className="ade-label">Máquinas</div>
        <div className="ade-sidebar-empty">
          <HardDrivesIcon size={16} />
          Ninguna conectada
        </div>
        <div className="ade-sidebar-footer">
          <span className="ade-dot" />
          Sin conectar
        </div>
      </aside>
      <main className="ade-main">
        <span
          aria-hidden
          className="ade-dither"
          style={gradientFillStyle({ edge: "right", length: 220, from: 0.6, to: 0 })}
        />
        <section className="ade-empty">
          <PlugsIcon size={28} />
          <h1>Sin conectar</h1>
          <p>Todavía no hay ningún servidor de T3 Code conectado a este ADE.</p>
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
