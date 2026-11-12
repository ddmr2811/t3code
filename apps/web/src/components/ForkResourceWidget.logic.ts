// Fork-only: sizing of the machines widget (ForkResourceWidget.tsx).

/** The widget's layout at scale 1, in CSS pixels: its width, its fixed parts, and one machine row. */
const NATURAL_WIDTH = 520;
const NATURAL_CHROME_HEIGHT = 60;
const NATURAL_ROW_HEIGHT = 38;
const MIN_SCALE = 0.6;
const MAX_SCALE = 3;

const FORK_WIDGET_MIN_SIZE = { width: 240, height: 110 };

/** The window opens at this size until the user resizes it. */
export function forkWidgetDefaultSize(machineCount: number): { width: number; height: number } {
  return {
    width: NATURAL_WIDTH,
    height: NATURAL_CHROME_HEIGHT + NATURAL_ROW_HEIGHT * Math.max(2, machineCount),
  };
}

/**
 * How much to magnify the widget so its content fills the window: the largest scale at which
 * every machine row still fits both ways.
 */
export function forkWidgetScale(input: {
  readonly width: number;
  readonly height: number;
  readonly machineCount: number;
}): number {
  const naturalHeight =
    NATURAL_CHROME_HEIGHT + NATURAL_ROW_HEIGHT * Math.max(1, input.machineCount);
  const fit = Math.min(input.width / NATURAL_WIDTH, input.height / naturalHeight);
  if (!Number.isFinite(fit) || fit <= 0) return 1;
  return Math.round(Math.min(MAX_SCALE, Math.max(MIN_SCALE, fit)) * 100) / 100;
}

export interface ForkWidgetBounds {
  readonly left: number;
  readonly top: number;
  /** Absent in bounds saved before the widget remembered its size. */
  readonly width?: number;
  readonly height?: number;
}

/** Reads bounds saved by an earlier session; anything malformed is ignored. */
export function parseForkWidgetBounds(raw: string | null): ForkWidgetBounds | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? "null");
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { left, top, width, height } = parsed as Record<string, unknown>;
  if (typeof left !== "number" || typeof top !== "number") return null;
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    width < FORK_WIDGET_MIN_SIZE.width ||
    height < FORK_WIDGET_MIN_SIZE.height
  ) {
    return { left, top };
  }
  return { left, top, width, height };
}
