// @effect-diagnostics-next-line nodeBuiltinImport:off -- A build plugin, outside any Effect program.
import * as NodeFS from "node:fs";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

import { connectSrc, parseConnectOrigins } from "./src/connection/csp.ts";

// The T3 servers this build may talk to, e.g. "https://*.my-tailnet.ts.net". Unset allows none.
const connectOrigins = parseConnectOrigins(process.env.ADE_CONNECT_ORIGINS);

// img-src allows the dither's data: SVG masks. Inline styles carry the diff's theme and syntax
// colors (@pierre/diffs); with img-src, font-src and connect-src closed they cannot send data out.
// Dev skips the CSP: React refresh injects an inline script there.
const CSP = `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src ${connectSrc(connectOrigins)}`;

export default defineConfig({
  define: { __ADE_CONNECT_ORIGINS__: JSON.stringify(connectOrigins) },
  plugins: [
    react(),
    {
      name: "ade:csp-meta",
      apply: "build",
      transformIndexHtml: () => [
        {
          tag: "meta",
          attrs: { "http-equiv": "Content-Security-Policy", content: CSP },
          injectTo: "head-prepend",
        },
      ],
      // The fonts' license travels with the fonts (SIL OFL 1.1 asks for it).
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "assets/OFL.txt",
          source: NodeFS.readFileSync(
            new URL("../web/src/fork/fonts/OFL.txt", import.meta.url),
            "utf8",
          ),
        });
      },
    },
  ],
  // Browsers ignore frame-ancestors in a <meta>, so it only works as a header. The rest stays in
  // the built page alone: a header computed again here could disagree with what was built.
  preview: { headers: { "Content-Security-Policy": "frame-ancestors 'none'" } },
  test: { environment: "node", include: ["src/**/*.test.{ts,tsx}"] },
});
