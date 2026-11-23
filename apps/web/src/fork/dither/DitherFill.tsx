// Fork: a still dithered gradient (dithercn's fill, no canvas or animation) behind content.
import "./dither.css";

import { cn } from "~/lib/utils";
import { type GradientFillOptions, gradientFillStyle } from "./style";

/** Decorative and absolutely placed; give it a position and size with `className`. */
export function DitherFill({
  className,
  ...options
}: GradientFillOptions & { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("pointer-events-none absolute", className)}
      style={gradientFillStyle(options)}
    />
  );
}
