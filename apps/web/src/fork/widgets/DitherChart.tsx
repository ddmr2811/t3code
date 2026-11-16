// Fork-only: dithered charts drawn as SVG. Every mark is a shape filled with a dot pattern laid on
// one shared grid, coloured by theme tokens, so a theme change restyles them without a redraw.
// Nothing animates: a chart renders again only when its data or its width changes.
import { useId, useState } from "react";

import { observeResize } from "../../lib/observeResize";

import type { HeatGrid, LinePoint } from "./widgets.logic";

export type DotTone = "accent" | "ink" | "muted" | "info" | "success" | "warning";

// The theme's accent (amber in T3 Clawd Solar); `--primary` is its action colour.
const TONE_COLOR: Record<DotTone, string> = {
  accent: "var(--app-theme-accent, var(--primary))",
  ink: "var(--foreground)",
  muted: "var(--muted-foreground)",
  info: "var(--info)",
  success: "var(--success)",
  warning: "var(--warning)",
};

/** The order providers take in a stacked chart. */
export const SERIES_TONES: ReadonlyArray<DotTone> = ["accent", "ink", "info", "success", "warning"];

export const toneColor = (tone: DotTone) => TONE_COLOR[tone];

/** Distance between dots, in CSS pixels. Marks snap to it so no dot is cut in half. */
export const PITCH = 3;
const DOT_RADIUS = 1;

const snap = (value: number) => Math.round(value / PITCH) * PITCH;

/** React's ids hold characters a `url(#…)` reference does not take. */
function useSvgId(): string {
  return `dither-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
}

/** The element's content width, kept current while it is mounted; 0 until measured. */
export function useMeasuredWidth(): readonly [(element: HTMLElement | null) => () => void, number] {
  const [width, setWidth] = useState(0);
  const ref = (element: HTMLElement | null) => {
    if (element === null) return () => undefined;
    return observeResize(element, (entries) => {
      const entry = entries.at(-1);
      if (entry) setWidth(Math.floor(entry.contentRect.width));
    });
  };
  return [ref, width] as const;
}

function DotPatterns(props: { readonly id: string; readonly tones: ReadonlyArray<DotTone> }) {
  return (
    <defs>
      {props.tones.map((tone) => (
        <pattern
          key={tone}
          id={`${props.id}-${tone}`}
          width={PITCH}
          height={PITCH}
          patternUnits="userSpaceOnUse"
        >
          <circle cx={PITCH / 2} cy={PITCH / 2} r={DOT_RADIUS} style={{ fill: TONE_COLOR[tone] }} />
        </pattern>
      ))}
    </defs>
  );
}

const dots = (id: string, tone: DotTone) => `url(#${id}-${tone})`;

/** A thin dotted meter for a share from 0 to 1; sized by its parent, no measuring needed. */
export function DotMeter(props: { readonly share: number | null; readonly color: string }) {
  const id = useSvgId();
  const share = Math.max(0, Math.min(1, props.share ?? 0));
  return (
    <svg aria-hidden className="block h-1.5 w-full" preserveAspectRatio="none">
      <defs>
        <pattern id={`${id}-m`} width={PITCH} height={PITCH} patternUnits="userSpaceOnUse">
          <circle cx={PITCH / 2} cy={PITCH / 2} r={DOT_RADIUS} style={{ fill: props.color }} />
        </pattern>
        <pattern id={`${id}-t`} width={PITCH} height={PITCH} patternUnits="userSpaceOnUse">
          <circle
            cx={PITCH / 2}
            cy={PITCH / 2}
            r={DOT_RADIUS}
            style={{ fill: TONE_COLOR.muted, fillOpacity: 0.28 }}
          />
        </pattern>
      </defs>
      <rect width="100%" height={PITCH * 2} fill={`url(#${id}-t)`} />
      <rect width={`${share * 100}%`} height={PITCH * 2} fill={`url(#${id}-m)`} />
    </svg>
  );
}

/** One column of dots per value; `rows` is how many dot rows each fills (see `dotRows`). */
export function DotBars(props: {
  readonly rows: ReadonlyArray<number>;
  readonly totalRows: number;
  readonly width: number;
  readonly highlight: number;
  readonly titles: ReadonlyArray<string>;
}) {
  const id = useSvgId();
  const count = props.rows.length;
  const height = props.totalRows * PITCH;
  if (count === 0 || props.width <= 0) return <div style={{ height }} />;
  const slot = props.width / count;
  const barWidth = Math.max(2, Math.floor((slot * 0.46) / PITCH)) * PITCH;
  return (
    <svg aria-hidden width={props.width} height={height} className="block overflow-visible">
      <DotPatterns id={id} tones={["accent", "ink", "muted"]} />
      {props.rows.map((filled, index) => {
        const x = snap(index * slot + (slot - barWidth) / 2);
        return (
          // oxlint-disable-next-line react/no-array-index-key -- one bar per day, in order
          <g key={index}>
            <title>{props.titles[index]}</title>
            <rect
              x={x}
              y={0}
              width={barWidth}
              height={height}
              fill={dots(id, "muted")}
              opacity={0.22}
            />
            {filled > 0 ? (
              <rect
                x={x}
                y={(props.totalRows - filled) * PITCH}
                width={barWidth}
                height={filled * PITCH}
                fill={dots(id, index === props.highlight ? "accent" : "ink")}
                opacity={index === props.highlight ? 1 : 0.62}
              />
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

/** Stacked layers, bottom first: `tops[layer][point]` is that layer's upper edge. */
export function DotStack(props: {
  readonly tops: ReadonlyArray<ReadonlyArray<number>>;
  readonly tones: ReadonlyArray<DotTone>;
  readonly width: number;
  readonly height: number;
}) {
  const id = useSvgId();
  const max = Math.max(0, ...(props.tops.at(-1) ?? []));
  const points = props.tops[0]?.length ?? 0;
  if (max === 0 || points === 0 || props.width <= 0) {
    return <div style={{ height: props.height }} />;
  }
  const xAt = (index: number) =>
    points === 1 ? (index === 0 ? 0 : props.width) : (index / (points - 1)) * props.width;
  const yAt = (value: number) => props.height - (value / max) * props.height;
  // A single day is drawn as a flat band across the chart.
  const series = (values: ReadonlyArray<number>) =>
    points === 1 ? [values[0]!, values[0]!] : values;
  const xs = points === 1 ? [0, props.width] : series(props.tops[0]!).map((_, index) => xAt(index));
  const edge = (values: ReadonlyArray<number>) =>
    series(values).map((value, index) => `${xs[index]!.toFixed(1)},${yAt(value).toFixed(1)}`);
  return (
    <svg aria-hidden width={props.width} height={props.height} className="block overflow-visible">
      <DotPatterns id={id} tones={props.tones} />
      {props.tops.map((top, layer) => {
        const below = layer > 0 ? props.tops[layer - 1]! : top.map(() => 0);
        const tone = props.tones[layer] ?? "muted";
        const upper = edge(top);
        const lower = edge(below).toReversed();
        return (
          // oxlint-disable-next-line react/no-array-index-key -- layers are stacked by position
          <g key={layer}>
            <polygon points={[...upper, ...lower].join(" ")} fill={dots(id, tone)} />
            <polyline
              points={upper.join(" ")}
              fill="none"
              style={{ stroke: TONE_COLOR[tone] }}
              strokeWidth={1.25}
              strokeLinejoin="round"
            />
          </g>
        );
      })}
    </svg>
  );
}

/** A line of room left over time, the last value held to the right edge. */
export function DotLine(props: {
  readonly points: ReadonlyArray<LinePoint>;
  readonly width: number;
  readonly height: number;
  readonly tone: DotTone;
}) {
  const id = useSvgId();
  if (props.width <= 0) return <div style={{ height: props.height }} />;
  const inset = 2;
  const usable = props.height - inset * 2;
  const xy = (point: LinePoint) =>
    `${(point.x * props.width).toFixed(1)},${(inset + (1 - point.y) * usable).toFixed(1)}`;
  const last = props.points.at(-1);
  const line = last === undefined ? [] : [...props.points, { x: 1, y: last.y }];
  const first = line[0];
  return (
    <svg aria-hidden width={props.width} height={props.height} className="block overflow-visible">
      <DotPatterns id={id} tones={[props.tone, "muted"]} />
      <line
        x1={0}
        x2={props.width}
        y1={inset}
        y2={inset}
        style={{ stroke: TONE_COLOR.muted }}
        strokeOpacity={0.35}
        strokeDasharray="1 3"
      />
      <line
        x1={0}
        x2={props.width}
        y1={props.height - inset}
        y2={props.height - inset}
        style={{ stroke: TONE_COLOR.muted }}
        strokeOpacity={0.35}
      />
      {first !== undefined ? (
        <>
          <polygon
            points={[
              `${(first.x * props.width).toFixed(1)},${props.height - inset}`,
              ...line.map(xy),
              `${props.width},${props.height - inset}`,
            ].join(" ")}
            fill={dots(id, props.tone)}
            opacity={0.34}
          />
          <polyline
            points={line.map(xy).join(" ")}
            fill="none"
            style={{ stroke: TONE_COLOR[props.tone] }}
            strokeWidth={1.5}
            strokeLinejoin="round"
          />
        </>
      ) : null}
    </svg>
  );
}

const HEAT_OPACITY = [0.16, 0.32, 0.52, 0.76, 1] as const;
const HEAT_GAP = 3;
const HEAT_LABEL_WIDTH = 26;
const HEAT_TOP = 14;

/** The cell size that fits `weeks` columns in `width`, between 7 and 12 pixels. */
function heatCellSize(width: number, weeks: number): number {
  if (weeks <= 0) return 0;
  return Math.max(
    7,
    Math.min(12, Math.floor((width - HEAT_LABEL_WIDTH - HEAT_GAP * (weeks - 1)) / weeks)),
  );
}

/** How many weeks fit `width` at the largest comfortable cell size. */
export function heatWeeksFor(width: number): number {
  return Math.max(
    1,
    Math.min(53, Math.floor((width - HEAT_LABEL_WIDTH + HEAT_GAP) / (10 + HEAT_GAP))),
  );
}

const WEEKDAY_LABELS: ReadonlyArray<readonly [number, string]> = [
  [0, "Mon"],
  [2, "Wed"],
  [4, "Fri"],
];

export function DotHeatmap(props: { readonly grid: HeatGrid; readonly width: number }) {
  const weeks = props.grid.weeks.length;
  const cell = heatCellSize(props.width, weeks);
  if (weeks === 0 || cell === 0) return null;
  const step = cell + HEAT_GAP;
  const height = HEAT_TOP + 7 * step - HEAT_GAP;
  return (
    <svg
      aria-hidden
      width={HEAT_LABEL_WIDTH + weeks * step - HEAT_GAP}
      height={height}
      className="block font-mono"
    >
      {props.grid.months.map((month) => (
        <text
          key={`${month.week}-${month.label}`}
          x={HEAT_LABEL_WIDTH + month.week * step}
          y={9}
          fontSize={9}
          className="fill-muted-foreground"
        >
          {month.label}
        </text>
      ))}
      {WEEKDAY_LABELS.map(([row, label]) => (
        <text
          key={label}
          x={0}
          y={HEAT_TOP + row * step + cell - 1}
          fontSize={9}
          className="fill-muted-foreground"
        >
          {label}
        </text>
      ))}
      {props.grid.weeks.map((column, week) =>
        column.map((entry, weekday) =>
          entry === null ? null : (
            <rect
              key={entry.day}
              x={HEAT_LABEL_WIDTH + week * step}
              y={HEAT_TOP + weekday * step}
              width={cell}
              height={cell}
              rx={2}
              style={{ fill: entry.level === 0 ? TONE_COLOR.muted : TONE_COLOR.accent }}
              fillOpacity={HEAT_OPACITY[entry.level]}
            >
              <title>{`${entry.day}: ${entry.count} ${entry.count === 1 ? "turn" : "turns"}`}</title>
            </rect>
          ),
        ),
      )}
    </svg>
  );
}

/** A soft, still field of dots that fades out from the middle; drawn once. */
export function DitherBackdrop() {
  const id = useSvgId();
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0 size-full [mask-image:radial-gradient(closest-side,black,transparent)]"
    >
      <defs>
        <pattern id={id} width={4} height={4} patternUnits="userSpaceOnUse">
          <circle cx={2} cy={2} r={0.75} style={{ fill: TONE_COLOR.ink, fillOpacity: 0.13 }} />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </svg>
  );
}
