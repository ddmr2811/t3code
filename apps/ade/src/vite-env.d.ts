/// <reference types="vite-plus/client" />

/** The origins `connect-src` allows, fixed at build time from ADE_CONNECT_ORIGINS. */
declare const __ADE_CONNECT_ORIGINS__: ReadonlyArray<string>;

// The shared ghostty surface asks apps/desktop's Electron shell for this; the ADE has none.
interface Window {
  desktopBridge?: { getPrimaryPasteEnabled?: () => boolean };
}
