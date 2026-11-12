// Fork-only: lets the renderer open its machines widget as a small frameless window
// that stays on top. The renderer draws into it (apps/web/src/components/ForkResourceWidget.tsx).
import type * as Electron from "electron";

/** Must match the window name the renderer opens. */
const WIDGET_FRAME_NAME = "t3-fork-resource-widget";

type WindowOpenResult = ReturnType<Parameters<Electron.WebContents["setWindowOpenHandler"]>[0]>;

/**
 * The window-open result for the widget popup, or null for any other request.
 * A request that names a foreign opener is refused here; `hardenForkResourceWidget`
 * then verifies the opener frame itself, which this handler is not told.
 */
export function forkResourceWidgetWindowOpen(
  details: Pick<Electron.HandlerDetails, "frameName" | "url" | "referrer">,
  applicationUrl: string,
): WindowOpenResult | null {
  if (details.frameName !== WIDGET_FRAME_NAME || details.url !== "about:blank") return null;
  const opener = details.referrer.url;
  if (opener !== "" && !opener.startsWith(applicationUrl)) return null;
  return {
    action: "allow",
    overrideBrowserWindowOptions: {
      frame: false,
      alwaysOnTop: true,
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      minWidth: 240,
      minHeight: 110,
      title: "T3 Code machines",
      backgroundColor: "#0b0f1a",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
      },
    },
  };
}

/**
 * Destroys a widget window the main window's top frame did not open. The widget only
 * shows what that frame draws into it, so it may not navigate or open windows of its own.
 */
export function hardenForkResourceWidget(mainContents: Electron.WebContents): void {
  mainContents.on("did-create-window", (child, details) => {
    if (details.frameName !== WIDGET_FRAME_NAME) return;
    // The referrer is empty for the app's own scheme, so the opener frame is the real check:
    // only the main window's top frame may own the widget.
    if (child.webContents.opener !== mainContents.mainFrame) {
      child.destroy();
      return;
    }
    child.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    child.webContents.on("will-navigate", (event) => event.preventDefault());
    child.webContents.on("will-attach-webview", (event) => event.preventDefault());
  });
}
