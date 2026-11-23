// Copied from dithercn (MIT), commit 3b1e853, lib/dither/matrices.ts, trimmed to what the
// fork uses. See ../NOTICE.md.
import { BLUE_NOISE_64_BASE64 } from "./blue-noise";

/**
 * Threshold maps for ordered dithering. A cell is inked when the tone at
 * that cell is above its threshold, so a tone of 0.25 inks a quarter of the cells.
 */
export type DitherMatrix = "bayer2" | "bayer4" | "bayer8" | "blue-noise";

interface ThresholdMap {
  /** Width and height in cells. The map tiles in both directions. */
  readonly size: number;
  /** Row-major thresholds in (0, 1). */
  readonly thresholds: Float32Array;
}

// Thresholds sit halfway between steps, `(rank + 0.5) / steps`, so no tone lands on one.
const fromRanks = (size: number, ranks: Uint8Array, steps: number): ThresholdMap => ({
  size,
  thresholds: Float32Array.from(ranks, (rank) => (rank + 0.5) / steps),
});

// Bayer ranks: interleave the bits of (x xor y) and y, least significant
// first, so each 2x2 block of the previous size splits into four.
const bayerRanks = (size: number): Uint8Array => {
  const ranks = new Uint8Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let rank = 0;
      for (let bit = 1; bit < size; bit *= 2) {
        const xBit = Math.floor(x / bit) % 2;
        const yBit = Math.floor(y / bit) % 2;
        rank = rank * 4 + 2 * ((xBit + yBit) % 2) + yBit;
      }
      ranks[y * size + x] = rank;
    }
  }
  return ranks;
};

const decodeBase64 = (value: string): Uint8Array => {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.codePointAt(0) ?? 0);
};

const BAYER_2 = fromRanks(2, bayerRanks(2), 4);
const BAYER_4 = fromRanks(4, bayerRanks(4), 16);
const BAYER_8 = fromRanks(8, bayerRanks(8), 64);
// 64x64 void-and-cluster blue noise, 256 levels of 16 cells each.
const BLUE_NOISE_64 = fromRanks(64, decodeBase64(BLUE_NOISE_64_BASE64), 256);

export const getThresholdMap = (matrix: DitherMatrix): ThresholdMap => {
  switch (matrix) {
    case "bayer2":
      return BAYER_2;
    case "bayer4":
      return BAYER_4;
    case "bayer8":
      return BAYER_8;
    case "blue-noise":
      return BLUE_NOISE_64;
  }
};
