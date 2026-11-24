import type { BotStatus } from "./bots.logic.ts";

// One fixed face per state on a 7×7 dot grid: `#` is lit, `.` is the dim matrix behind it.
const FACES: Record<BotStatus, string> = {
  working: `
    .......
    .##.##.
    .##.##.
    .......
    .......
    ..###..
    .......`,
  "needs-you": `
    .......
    .##.##.
    .##.##.
    .......
    ...#...
    ..#.#..
    ...#...`,
  error: `
    .#...#.
    ..#.#..
    .......
    ..#.#..
    .......
    ..###..
    .#...#.`,
  done: `
    .......
    .#...#.
    #.#.#.#
    .......
    .#...#.
    ..###..
    .......`,
  asleep: `
    .......
    .......
    .......
    .##.##.
    .......
    ...#...
    .......`,
};

const CELLS = Array.from({ length: 49 }, (_, index) => index);

/** Static, decorative: the state's text always sits beside it. */
export function BotAvatar(props: { status: BotStatus; size?: "md" | "sm" }) {
  const cells = FACES[props.status].replace(/\s/g, "");
  return (
    <svg
      className="ade-bot-avatar"
      data-status={props.status}
      data-size={props.size ?? "md"}
      viewBox="0 0 40 40"
      aria-hidden
    >
      {CELLS.map((index) => (
        <circle
          key={index}
          cx={5 + (index % 7) * 5}
          cy={5 + Math.floor(index / 7) * 5}
          r={2.15}
          data-on={cells[index] === "#" ? "" : undefined}
        />
      ))}
    </svg>
  );
}
