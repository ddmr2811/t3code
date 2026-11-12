// Fork-only: lets the renderer open its resource widget as a small frameless window
// that stays on top. The renderer draws into it (apps/web/src/components/ForkResourceWidget.tsx).
import type * as Electron from "electron";

/** Must match the window name the renderer opens. */
const WIDGET_FRAME_NAME = "t3-fork-resource-widget";

type WindowOpenResult = ReturnType<Parameters<Electron.WebContents["setWindowOpenHandler"]>[0]>;

/** The window-open result for the widget popup, or null for any other request. */
export function forkResourceWidgetWindowOpen(
  details: Pick<Electron.HandlerDetails, "frameName" | "url">,
): WindowOpenResult | null {
  if (details.frameName !== WIDGET_FRAME_NAME || details.url !== "about:blank") return null;
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
      minHeight: 150,
      title: "T3 Code resources",
      backgroundColor: "#0b0f1a",
    },
  };
}
