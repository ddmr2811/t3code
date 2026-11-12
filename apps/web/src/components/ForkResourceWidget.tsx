// Fork-only: the resource monitor's headline numbers in a small separate window.
// The window is an empty same-origin popup this renderer portals into, so it needs
// no second app instance and no desktop IPC. The desktop shell makes it frameless
// and always on top (apps/desktop/src/window/ForkResourceWidget.ts).
import * as Option from "effect/Option";
import { XIcon } from "lucide-react";
import { type ReactNode, useEffect, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { formatBytes } from "../lib/formatBytes";
import { useResourceTelemetry } from "../lib/resourceTelemetryState";
import { cn } from "../lib/utils";

/** Must match the frame name the desktop shell allows. */
const WIDGET_WINDOW_NAME = "t3-fork-resource-widget";
const WIDGET_SIZE = { width: 330, height: 210 };
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
  child.document.title = "T3 Code resources";
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

function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

function Stat(props: {
  readonly label: string;
  readonly value: string;
  readonly tone?: "warning" | "danger";
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-md bg-muted/30 px-2.5 py-1.5">
      <span className="truncate text-3xs font-semibold uppercase tracking-widest text-muted-foreground/70">
        {props.label}
      </span>
      <span
        className={cn(
          "truncate font-mono text-base font-semibold tabular-nums",
          props.tone === "danger"
            ? "text-destructive"
            : props.tone === "warning"
              ? "text-warning-foreground"
              : "text-foreground",
        )}
      >
        {props.value}
      </span>
    </div>
  );
}

function WidgetBody({ onClose }: { readonly onClose: () => void }) {
  const telemetry = useResourceTelemetry();
  const refresh = telemetry.refresh;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the telemetry snapshot while the widget window is open
  useEffect(() => {
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const snapshot = telemetry.data;
  const all = snapshot?.groups.allT3;
  const speedLimit = snapshot ? Option.getOrNull(snapshot.speedLimitPercent) : null;
  const writeRate = all?.ioWriteBytesPerSecond ?? 0;
  const pending = "…";

  let content: ReactNode;
  if (telemetry.error && !snapshot) {
    content = <p className="px-1 text-xs text-destructive">{telemetry.error}</p>;
  } else {
    content = (
      <div className="grid grid-cols-3 gap-1.5">
        <Stat label="CPU" value={all ? `${all.currentCpuPercent.toFixed(0)}%` : pending} />
        <Stat label="Memory" value={all ? formatBytes(all.currentRssBytes) : pending} />
        <Stat label="Processes" value={all ? String(all.processCount) : pending} />
        <Stat label="Read" value={all ? formatRate(all.ioReadBytesPerSecond) : pending} />
        <Stat
          label="Write"
          value={all ? formatRate(writeRate) : pending}
          {...(writeRate >= 10 * 1_024 * 1_024
            ? { tone: "danger" as const }
            : writeRate >= 1_024 * 1_024
              ? { tone: "warning" as const }
              : {})}
        />
        <Stat
          label="Speed limit"
          value={snapshot ? (speedLimit === null ? "n/a" : `${speedLimit.toFixed(0)}%`) : pending}
          {...(speedLimit !== null && speedLimit < 80 ? { tone: "warning" as const } : {})}
        />
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col gap-2 p-2">
      {/* The window has no frame: this strip is its drag handle. */}
      <div className="flex items-center gap-2 [-webkit-app-region:drag]">
        <span className="flex-1 truncate px-1 text-xs font-medium text-muted-foreground">
          T3 Code resources
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
      {content}
    </div>
  );
}

/** Mount once in the app shell. Renders nothing in the main window. */
export function ForkResourceWidgetHost() {
  const popup = useSyncExternalStore(subscribe, () => widgetWindow);
  if (popup === null || popup.closed) return null;
  return createPortal(<WidgetBody onClose={closeWidget} />, popup.document.body);
}
