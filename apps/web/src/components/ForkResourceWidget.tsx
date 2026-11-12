// Fork-only: every connected machine's T3 Code load and working threads in a small window,
// off until the user turns it on. This renderer portals into an empty same-origin popup; the
// desktop shell frames it and keeps the app in the tray (apps/desktop/src/window/ForkResourceWidget.ts).
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import type { EnvironmentId } from "@t3tools/contracts";
import { AppWindowIcon, XIcon } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { formatBytes } from "../lib/formatBytes";
import { useResourceTelemetry } from "../lib/resourceTelemetryState";
import { cn } from "../lib/utils";
import { useVisibleThreadShells } from "../state/entities";
import { useEnvironmentIdentities } from "../state/environments";

/** Must match the frame name the desktop shell allows. */
const WIDGET_WINDOW_NAME = "t3-fork-resource-widget";
const WIDGET_SIZE = { width: 380, height: 170 };
const POSITION_KEY = "t3code:fork:resource-widget-position";
const REFRESH_MS = 2_000;
const POSITION_SAVE_MS = 1_000;
const POSITION_SETTLE_MS = 700;
const ENABLED_KEY = "t3code:fork:resource-widget-enabled";
const AUTOSTART_KEY = "t3code:fork:autostart";

interface ForkBridge {
  readonly showMain: () => void;
  readonly quit: () => void;
  readonly setAutostart: (enabled: boolean) => void;
}

declare global {
  interface Window {
    /** Present in the desktop app only (apps/desktop/src/preload.ts). */
    readonly forkBridge?: ForkBridge;
  }
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string, value: boolean) {
  try {
    if (value) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
  } catch {
    // Without storage the option simply does not persist.
  }
  for (const listener of listeners) listener();
}

/** Whether the desktop shell can keep the widget alive and start with the system. */
export function forkWidgetHasDesktopShell(): boolean {
  return window.forkBridge !== undefined;
}

export function useForkWidgetEnabled(): boolean {
  return useSyncExternalStore(subscribe, () => readFlag(ENABLED_KEY));
}

export function setForkWidgetEnabled(enabled: boolean) {
  if (enabled) {
    writeFlag(ENABLED_KEY, true);
    if (widgetWindow === null) toggleForkResourceWidget();
    return;
  }
  closeWidget();
  if (readFlag(AUTOSTART_KEY)) setForkAutostart(false);
  writeFlag(ENABLED_KEY, false);
}

export function useForkAutostart(): boolean {
  return useSyncExternalStore(subscribe, () => readFlag(AUTOSTART_KEY));
}

export function setForkAutostart(enabled: boolean) {
  window.forkBridge?.setAutostart(enabled);
  writeFlag(AUTOSTART_KEY, enabled);
}

const listeners = new Set<() => void>();
let widgetWindow: Window | null = null;

function setWidgetWindow(next: Window | null) {
  if (widgetWindow === next) return;
  widgetWindow = next;
  for (const listener of listeners) listener();
}

let positionTimer: ReturnType<typeof setInterval> | undefined;
let lastSavedPosition = "";

function savePosition(popup: Window) {
  // A closing window reports 0,0, so only an open one is read.
  if (popup.closed) return;
  const value = JSON.stringify({ left: popup.screenX, top: popup.screenY });
  if (value === lastSavedPosition) return;
  lastSavedPosition = value;
  try {
    localStorage.setItem(POSITION_KEY, value);
  } catch {
    // Losing the position is harmless.
  }
}

/** Saved while open: the app can quit, or the OS close the window, without telling this renderer first. */
function trackPosition(popup: Window) {
  clearInterval(positionTimer);
  positionTimer = setInterval(() => savePosition(popup), POSITION_SAVE_MS);
}

function closeWidget() {
  const popup = widgetWindow;
  if (popup === null) return;
  setWidgetWindow(null);
  clearInterval(positionTimer);
  if (!popup.closed) {
    savePosition(popup);
    popup.close();
  }
}

/** Opens from the click itself, so the popup is never treated as unrequested. */
export function toggleForkResourceWidget() {
  if (widgetWindow !== null) {
    closeWidget();
    return;
  }
  const popup = openWidgetWindow();
  if (popup === null) return;
  // Closed from its own side (Alt+F4, the OS): forget the window.
  popup.addEventListener("pagehide", () => {
    if (widgetWindow !== popup) return;
    clearInterval(positionTimer);
    setWidgetWindow(null);
  });
  trackPosition(popup);
  window.addEventListener("pagehide", closeWidget, { once: true });
  setWidgetWindow(popup);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function readSavedPosition(): { left: number; top: number } | null {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(POSITION_KEY) ?? "null");
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "left" in parsed &&
      "top" in parsed &&
      typeof parsed.left === "number" &&
      typeof parsed.top === "number"
    ) {
      return { left: parsed.left, top: parsed.top };
    }
  } catch {
    // A corrupt entry only loses the remembered position.
  }
  return null;
}

function openWidgetWindow(): Window | null {
  const position = readSavedPosition();
  const features = [
    "popup=yes",
    `width=${WIDGET_SIZE.width}`,
    `height=${WIDGET_SIZE.height}`,
    ...(position ? [`left=${position.left}`, `top=${position.top}`] : []),
  ].join(",");
  const child = window.open("about:blank", WIDGET_WINDOW_NAME, features);
  if (child === null) return null;
  if (position) {
    // The shell places the window's invisible resize border at the asked position, a few
    // pixels off the reported one; correct it once so reopening does not creep.
    setTimeout(() => {
      if (child.closed) return;
      const dx = position.left - child.screenX;
      const dy = position.top - child.screenY;
      // Moving lands short by the same amount as opening did, so ask for that much more.
      if (dx !== 0 || dy !== 0) child.moveTo(position.left + dx, position.top + dy);
    }, POSITION_SETTLE_MS);
  }
  const root = document.documentElement;
  child.document.title = "T3 Code machines";
  child.document.documentElement.className = root.className;
  child.document.documentElement.style.cssText = root.style.cssText;
  for (const attribute of root.attributes) {
    if (attribute.name.startsWith("data-")) {
      child.document.documentElement.setAttribute(attribute.name, attribute.value);
    }
  }
  for (const node of document.head.querySelectorAll('style, link[rel="stylesheet"]')) {
    const copy = child.document.importNode(node, true);
    // A popup at about:blank has no base URL, so relative stylesheet links would not load.
    if (node instanceof HTMLLinkElement && copy instanceof HTMLLinkElement) copy.href = node.href;
    child.document.head.append(copy);
  }
  child.document.body.className = "m-0 overflow-hidden bg-background text-foreground";
  return child;
}

function MachineRow(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly workingThreads: number;
}) {
  const telemetry = useResourceTelemetry(props.environmentId);
  const refresh = telemetry.refresh;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls this machine's telemetry snapshot while the widget window is open
  useEffect(() => {
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const snapshot = telemetry.data;
  const all = snapshot?.groups.allT3;
  // A machine that reports nothing is unreachable or this connection may not read its diagnostics.
  const unavailable = !snapshot && (telemetry.error !== null || !telemetry.isPending);
  const cell = "truncate text-end font-mono font-semibold tabular-nums";
  return (
    <div
      role="row"
      className="col-span-5 grid grid-cols-subgrid items-center rounded-md bg-muted/30 px-2.5 py-1.5 text-sm"
    >
      <span className="truncate font-medium">{props.label}</span>
      {unavailable ? (
        <span className="col-span-3 truncate text-end text-muted-foreground text-xs">
          {telemetry.error ?? "No data"}
        </span>
      ) : (
        <>
          <span className={cell}>{all ? `${all.currentCpuPercent.toFixed(0)}%` : "…"}</span>
          <span className={cell}>{all ? formatBytes(all.currentRssBytes) : "…"}</span>
          <span className={cell}>{all ? String(all.processCount) : "…"}</span>
        </>
      )}
      <span
        className={cn(cell, props.workingThreads > 0 ? "text-foreground" : "text-muted-foreground")}
      >
        {props.workingThreads}
      </span>
    </div>
  );
}

function WidgetBody({ onClose }: { readonly onClose: () => void }) {
  const environments = useEnvironmentIdentities();
  const threads = useVisibleThreadShells();
  const workingByEnvironment = new Map<string, number>();
  for (const thread of threads) {
    if (thread.archivedAt !== null || thread.settledOverride === "settled") continue;
    if (!isThreadWorking(thread)) continue;
    workingByEnvironment.set(
      thread.environmentId,
      (workingByEnvironment.get(thread.environmentId) ?? 0) + 1,
    );
  }
  const heading =
    "truncate text-3xs font-semibold uppercase tracking-widest text-muted-foreground/70";

  return (
    <div className="flex h-screen flex-col gap-2 p-2">
      {/* The window has no frame: this strip is its drag handle. */}
      <div className="flex items-center gap-2 [-webkit-app-region:drag]">
        <span className="flex-1 truncate px-1 text-xs font-medium text-muted-foreground">
          T3 Code machines
        </span>
        {window.forkBridge ? (
          <button
            type="button"
            aria-label="Open T3 Code"
            onClick={window.forkBridge.showMain}
            className="flex size-5 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground [-webkit-app-region:no-drag]"
          >
            <AppWindowIcon className="size-3.5" />
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Close widget"
          onClick={onClose}
          className="flex size-5 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground [-webkit-app-region:no-drag]"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
      <div
        role="table"
        aria-label="Connected machines"
        className="grid min-h-0 grid-cols-[minmax(4rem,1fr)_auto_auto_auto_auto] gap-x-3 gap-y-1.5 overflow-y-auto"
      >
        <div role="row" className="col-span-5 grid grid-cols-subgrid px-2.5">
          <span className={heading}>Machine</span>
          <span className={cn(heading, "text-end")}>CPU</span>
          <span className={cn(heading, "text-end")}>Memory</span>
          <span className={cn(heading, "text-end")}>Procs</span>
          <span className={cn(heading, "text-end")}>Working</span>
        </div>
        {environments.map((environment) => (
          <MachineRow
            key={environment.environmentId}
            environmentId={environment.environmentId}
            label={environment.label}
            workingThreads={workingByEnvironment.get(environment.environmentId) ?? 0}
          />
        ))}
      </div>
    </div>
  );
}

/** Mount once in the app shell. Renders nothing in the main window. */
export function ForkResourceWidgetHost() {
  const popup = useSyncExternalStore(subscribe, () => widgetWindow);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- on app start, reopens the widget the user enabled and re-applies start with the system
  useEffect(() => {
    // Browsers block a popup nobody clicked for; the desktop shell does not.
    if (window.forkBridge === undefined || !readFlag(ENABLED_KEY)) return;
    if (readFlag(AUTOSTART_KEY)) window.forkBridge.setAutostart(true);
    if (widgetWindow === null) toggleForkResourceWidget();
  }, []);
  if (popup === null || popup.closed) return null;
  return createPortal(<WidgetBody onClose={closeWidget} />, popup.document.body);
}
