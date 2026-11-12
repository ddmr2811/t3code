// Fork-only: every connected machine's T3 Code load and working threads in a small separate window.
// The window is an empty same-origin popup this renderer portals into, so it needs
// no second app instance and no desktop IPC. The desktop shell makes it frameless
// and always on top (apps/desktop/src/window/ForkResourceWidget.ts).
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import type { EnvironmentId } from "@t3tools/contracts";
import { XIcon } from "lucide-react";
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

const listeners = new Set<() => void>();
let widgetWindow: Window | null = null;

function setWidgetWindow(next: Window | null) {
  if (widgetWindow === next) return;
  widgetWindow = next;
  for (const listener of listeners) listener();
}

function savePosition(popup: Window) {
  try {
    localStorage.setItem(POSITION_KEY, JSON.stringify({ left: popup.screenX, top: popup.screenY }));
  } catch {
    // Losing the position is harmless.
  }
}

function closeWidget() {
  const popup = widgetWindow;
  if (popup === null) return;
  setWidgetWindow(null);
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
  // Closed from its own side (Alt+F4, the OS): keep the position and forget the window.
  popup.addEventListener("pagehide", () => {
    savePosition(popup);
    if (widgetWindow === popup) setWidgetWindow(null);
  });
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
  if (popup === null || popup.closed) return null;
  return createPortal(<WidgetBody onClose={closeWidget} />, popup.document.body);
}
