// Copied from dithercn (MIT), commit 3b1e853, lib/dither/tokens.ts, trimmed to what the
// fork uses. See ../NOTICE.md.

// Used when a named colour's variable is missing. Mid lightness, so it reads on black and white.
const FALLBACKS = {
  blue: "oklch(0.64 0.16 245)",
  green: "oklch(0.68 0.16 152)",
  grey: "oklch(0.6 0 0)",
  ink: "oklch(0.6 0.2 270)",
  orange: "oklch(0.72 0.16 58)",
  pink: "oklch(0.66 0.19 352)",
  purple: "oklch(0.62 0.2 302)",
  red: "oklch(0.62 0.21 26)",
} as const;

const DITHER_COLORS = {
  blue: "--dither-color-blue",
  green: "--dither-color-green",
  grey: "--dither-color-grey",
  ink: "--dither-ink",
  orange: "--dither-color-orange",
  pink: "--dither-color-pink",
  purple: "--dither-color-purple",
  red: "--dither-color-red",
} as const satisfies Record<keyof typeof FALLBACKS, `--${string}`>;

type DitherColorName = keyof typeof DITHER_COLORS;

/**
 * A palette name such as `"ink"`, a CSS variable name such as `"--dither-ink"`,
 * or any CSS colour such as `"currentColor"`. `string & {}` keeps autocomplete for the names.
 */
export type DitherColor = DitherColorName | (string & {});

const isColorName = (value: string): value is DitherColorName =>
  Object.hasOwn(DITHER_COLORS, value);

/** `"green"` becomes `var(--dither-color-green, …)`, `"--x"` becomes `var(--x)`, anything else passes. */
export const cssColor = (value: DitherColor): string => {
  if (isColorName(value)) return `var(${DITHER_COLORS[value]}, ${FALLBACKS[value]})`;
  return value.startsWith("--") ? `var(${value})` : value;
};
