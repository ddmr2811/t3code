import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

// connect-src arrives with pairing. img-src allows the dither's data: SVG masks.
// Dev skips the CSP: React refresh injects an inline script there.
const CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' data:";

export default defineConfig({
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
    },
  ],
  // Browsers ignore frame-ancestors in a <meta>, so it only works as a header.
  preview: { headers: { "Content-Security-Policy": `${CSP}; frame-ancestors 'none'` } },
});
