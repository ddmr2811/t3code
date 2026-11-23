// Copied from dithercn (MIT), commit 3b1e853, lib/dither/style.ts: `fillStyle("gradient")`,
// kept as `gradientFillStyle` with only the code it needs. See ../NOTICE.md.
import type { CSSProperties } from "react";

import { type DitherMatrix, getThresholdMap } from "./matrices";
import { ditherMask } from "./pattern";
import { cssColor, type DitherColor } from "./tokens";

/** The side of a shape where a gradient fill is densest. */
type FillEdge = "top" | "bottom" | "left" | "right";

// One SVG path covering the inked cells of a grid, in cell units.
const cellsPath = (width: number, height: number, inked: (x: number, y: number) => boolean) => {
  let path = "";
  for (let y = 0; y < height; y += 1) {
    let start = -1;
    for (let x = 0; x <= width; x += 1) {
      const on = x < width && inked(x, y);
      if (on && start === -1) {
        start = x;
      } else if (!on && start !== -1) {
        path += `M${start} ${y}h${x - start}v1h${start - x}z`;
        start = -1;
      }
    }
  }
  return path;
};

interface RampTile {
  width: number;
  height: number;
  path: string;
}

const rampCache = new Map<string, RampTile>();

/**
 * Coverage falls linearly from `from` at `edge` to `to` over `length` cells, then holds.
 * The tile is one matrix wide across the ramp, rounded up to whole matrices along it.
 */
const ditherRamp = (
  edge: FillEdge,
  length: number,
  from: number,
  to: number,
  matrix: DitherMatrix,
): RampTile => {
  const key = `${edge}:${length}:${from}:${to}:${matrix}`;
  const cached = rampCache.get(key);
  if (cached !== undefined) return cached;
  const { size, thresholds } = getThresholdMap(matrix);
  const fade = Math.max(1, Math.round(length));
  const along = Math.ceil(fade / size) * size;
  const vertical = edge === "top" || edge === "bottom";
  const width = vertical ? size : along;
  const height = vertical ? along : size;
  const levelAt = (index: number) => {
    const step = edge === "top" || edge === "left" ? index : along - 1 - index;
    return step >= fade ? to : from + (to - from) * ((step + 0.5) / fade);
  };
  const tile: RampTile = {
    height,
    path: cellsPath(
      width,
      height,
      (x, y) => levelAt(vertical ? y : x) > (thresholds[(y % size) * size + (x % size)] ?? 1),
    ),
    width,
  };
  rampCache.set(key, tile);
  return tile;
};

const svgUrl = (width: number, height: number, path: string) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges"><path d="${path}"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
};

const EDGE_POSITION = {
  bottom: "left bottom",
  left: "left top",
  right: "right top",
  top: "left top",
} as const satisfies Record<FillEdge, string>;

export interface GradientFillOptions {
  /** Colour, a palette name or any CSS colour. Default `ink`. */
  color?: DitherColor;
  /** The dense side. Default `bottom`. */
  edge?: FillEdge;
  /** Length of the fade in cells. Default 24. */
  length?: number;
  /** Coverage at the edge. Default 1. */
  from?: number;
  /** Coverage past the fade. Default 0.0625 (one cell in 16). */
  to?: number;
  /** Threshold matrix. Default `bayer4`. */
  matrix?: DitherMatrix;
}

const times = (count: number) => `calc(var(--dither-cell, 3px) * ${count})`;

/**
 * Inline styles that paint an element with a dithered gradient: a background colour and a
 * tiled CSS mask. The element needs a size, and its children are masked too.
 */
export const gradientFillStyle = ({
  color = "ink",
  edge = "bottom",
  length = 24,
  from = 1,
  to = 0.0625,
  matrix = "bayer4",
}: GradientFillOptions = {}): CSSProperties => {
  // A ramp along the edge, unioned with the plain floor level. Bayer sets
  // nest, so the union is exact where both are anchored to the same edge.
  const ramp = ditherRamp(edge, length, from, to, matrix);
  const { size } = getThresholdMap(matrix);
  const image = `${svgUrl(ramp.width, ramp.height, ramp.path)}, ${ditherMask(to, matrix)}`;
  const tileSize = `${times(ramp.width)} ${times(ramp.height)}, ${times(size)}`;
  const repeat = `${edge === "top" || edge === "bottom" ? "repeat-x" : "repeat-y"}, repeat`;
  const position = `${EDGE_POSITION[edge]}, ${EDGE_POSITION[edge]}`;
  return {
    WebkitMaskImage: image,
    WebkitMaskPosition: position,
    WebkitMaskRepeat: repeat,
    WebkitMaskSize: tileSize,
    backgroundColor: cssColor(color),
    maskImage: image,
    maskPosition: position,
    maskRepeat: repeat,
    maskSize: tileSize,
  };
};
