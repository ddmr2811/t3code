// Fork-only: the machines widget. The renderer opens a small frameless always-on-top
// window and draws into it (apps/web/src/components/ForkResourceWidget.tsx). While that
// window is open, closing the main window hides the app to the tray instead of quitting,
// so the widget and the local server keep running.
import * as Electron from "electron";

/** Must match the window name the renderer opens. */
const WIDGET_FRAME_NAME = "t3-fork-resource-widget";
/** Launch argument the login item passes, so a start with Windows stays in the tray. */
const BACKGROUND_LAUNCH_ARGUMENT = "--fork-background";

const SHOW_MAIN_CHANNEL = "fork:show-main";
const QUIT_CHANNEL = "fork:quit";
const SET_AUTOSTART_CHANNEL = "fork:set-autostart";

type WindowOpenResult = ReturnType<Parameters<Electron.WebContents["setWindowOpenHandler"]>[0]>;

/**
 * The window-open result for the widget popup, or null for any other request.
 * A request that names a foreign opener is refused here; `installForkWidget`
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

let quitting = false;
let quitListenerInstalled = false;
let tray: Electron.Tray | null = null;

/** Null where the Electron app is not running, as in unit tests that mock the module. */
function electronApp(): { app: Electron.App; ipcMain: Electron.IpcMain } | null {
  try {
    return { app: Electron.app, ipcMain: Electron.ipcMain };
  } catch {
    return null;
  }
}

/**
 * Wires the widget to one main window: guards the popup, keeps the app in the tray while
 * the widget is open, and answers the renderer's fork bridge (apps/desktop/src/preload.ts).
 */
export function installForkWidget(
  main: Electron.BrowserWindow,
  options: { readonly iconPath: string | undefined; readonly appName: string },
): void {
  const mainContents = main.webContents;
  let widget: Electron.BrowserWindow | null = null;
  const electron = electronApp();
  const app = electron?.app;

  if (app !== undefined && !quitListenerInstalled) {
    quitListenerInstalled = true;
    app.on("before-quit", () => {
      quitting = true;
    });
  }

  const showMain = () => {
    if (main.isDestroyed()) return;
    // Hidden pages are throttled; restore that once the window is back.
    mainContents.setBackgroundThrottling(true);
    if (main.isMinimized()) main.restore();
    main.show();
    main.focus();
    tray?.destroy();
    tray = null;
  };

  const hideToTray = () => {
    // The hidden renderer still draws the widget, so its timers must keep their pace.
    mainContents.setBackgroundThrottling(false);
    main.hide();
    if (tray !== null || options.iconPath === undefined) return;
    tray = new Electron.Tray(options.iconPath);
    tray.setToolTip(options.appName);
    tray.setContextMenu(
      Electron.Menu.buildFromTemplate([
        { label: `Open ${options.appName}`, click: showMain },
        { type: "separator" },
        { label: "Quit", click: () => app?.quit() },
      ]),
    );
    tray.on("click", showMain);
  };

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
    widget = child;
    child.on("closed", () => {
      if (widget !== child) return;
      widget = null;
      // Threads may be running, so closing the widget never quits. Without a tray icon the
      // hidden app would be unreachable, so the main window comes back instead.
      if (!quitting && !main.isDestroyed() && !main.isVisible() && tray === null) showMain();
    });
  });

  if (electron === null || app === undefined) return;

  main.on("close", (event) => {
    if (quitting || widget === null || widget.isDestroyed()) return;
    event.preventDefault();
    hideToTray();
  });
  main.on("closed", () => {
    tray?.destroy();
    tray = null;
  });

  // A start with Windows shows only the widget; the renderer opens it once it has loaded.
  if (process.argv.includes(BACKGROUND_LAUNCH_ARGUMENT)) {
    main.once("show", () => {
      if (!quitting) hideToTray();
    });
  }

  const fromMainFrame = (event: Electron.IpcMainInvokeEvent) =>
    !main.isDestroyed() && event.senderFrame === mainContents.mainFrame;
  const handle = (channel: string, listener: (argument: unknown) => void) => {
    electron.ipcMain.removeHandler(channel);
    electron.ipcMain.handle(channel, (event, argument: unknown) => {
      if (fromMainFrame(event)) listener(argument);
    });
  };
  handle(SHOW_MAIN_CHANNEL, showMain);
  handle(QUIT_CHANNEL, () => app.quit());
  handle(SET_AUTOSTART_CHANNEL, (enabled) => {
    app.setLoginItemSettings({
      openAtLogin: enabled === true,
      args: [BACKGROUND_LAUNCH_ARGUMENT],
    });
  });
}
