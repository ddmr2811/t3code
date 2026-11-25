// @ts-check
// The ADE as its own Windows app: one window that loads the ADE built into this package over
// `ade://app`. The page talks to remote T3 servers itself; this process only serves files and
// keeps the window from becoming anything else. No preload, no IPC.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { app, BrowserWindow, Menu, net, protocol, session, shell } from "electron";

import { APP_ORIGIN, assetPath, externalUrl, isAppUrl } from "./policy.mjs";

const WEB_ROOT = NodePath.join(import.meta.dirname, "web");
// Must match the installer's appId, or Windows groups the window and its notifications apart
// from the shortcuts.
const APP_USER_MODEL_ID = "com.ddmr2811.ade";
// Notifications for pending decisions; clipboard writes for copy buttons. Everything else
// (camera, microphone, location, HID…) is refused without asking.
const ALLOWED_PERMISSIONS = new Set(["notifications", "clipboard-sanitized-write"]);

// A standard, secure scheme gives the page a real origin, so IndexedDB and WebCrypto (the
// pairing keys) work and stay apart from any browser profile.
protocol.registerSchemesAsPrivileged([
  { scheme: "ade", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId(APP_USER_MODEL_ID);
  Menu.setApplicationMenu(null);
  app.on("second-instance", () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window === undefined) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.on("window-all-closed", () => app.quit());
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      openOutside(url);
      return { action: "deny" };
    });
    contents.on("will-navigate", (event) => {
      if (isAppUrl(event.url)) return;
      event.preventDefault();
      openOutside(event.url);
    });
  });
  void app.whenReady().then(() => {
    protocol.handle("ade", (request) => {
      const file = assetPath(WEB_ROOT, request.url);
      if (file === null) return new Response("Not found", { status: 404 });
      return net.fetch(NodeURL.pathToFileURL(file).href);
    });
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) =>
      callback(ALLOWED_PERMISSIONS.has(permission)),
    );
    session.defaultSession.setPermissionCheckHandler((_contents, permission) =>
      ALLOWED_PERMISSIONS.has(permission),
    );
    session.defaultSession.on("will-download", (event) => event.preventDefault());
    createWindow();
  });
}

/** @param {string} url */
function openOutside(url) {
  const external = externalUrl(url);
  if (external !== null) void shell.openExternal(external);
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 390,
    minHeight: 600,
    show: false,
    backgroundColor: "#050608",
    title: "ADE",
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      spellcheck: false,
    },
  });
  window.once("ready-to-show", () => window.show());
  void window.loadURL(`${APP_ORIGIN}/`);
}
