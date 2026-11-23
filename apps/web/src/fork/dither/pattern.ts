// Copied from dithercn (MIT), commit 3b1e853, lib/dither/pattern.tsx, trimmed to the CSS
// mask the fork uses. See ../NOTICE.md.
import { type DitherMatrix, getThresholdMap } from "./matrices";

const pathCache = new Map<string, string>();

// One SVG path covering the inked cells of one matrix tile, in cell units.
const ditherPath = (level: number, matrix: DitherMatrix) => {
  const key = `${matrix}:${level}`;
  const cached = pathCache.get(key);
  if (cached !== undefined) return cached;
  const { size, thresholds } = getThresholdMap(matrix);
  let path = "";
  for (let y = 0; y < size; y += 1) {
    let start = -1;
    for (let x = 0; x <= size; x += 1) {
      const inked = x < size && level > (thresholds[y * size + x] ?? 1);
      if (inked && start === -1) {
        start = x;
      } else if (!inked && start !== -1) {
        path += `M${start} ${y}h${x - start}v1h${start - x}z`;
        start = -1;
      }
    }
  }
  pathCache.set(key, path);
  return path;
};

/** A CSS `mask-image` value: one matrix tile with the cells below `level` filled. */
export const ditherMask = (level: number, matrix: DitherMatrix) => {
  const { size } = getThresholdMap(matrix);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><path d="${ditherPath(level, matrix)}"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
};
