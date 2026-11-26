// Copiado de Backroom (github.com/AdrianAlonsoDev/backroom, 4ca0ae9), MIT, © 2026 Adrián Alonso. Ver ./NOTICE.
export type MascotKind = "spark" | "maker" | "orbit";
export type Teammate = "clara" | "vega" | "nico";

/** Example roles keep one stable identity everywhere on the page; names never imply live agents. */
export const teammateMascot: Record<Teammate, MascotKind> = {
  clara: "orbit",
  vega: "spark",
  nico: "maker",
};
export const mascotTone: Record<MascotKind, "teal" | "amber" | "coral"> = {
  orbit: "teal",
  spark: "amber",
  maker: "coral",
};

/** Original mascots: distinct silhouettes share one eye design and stay legible at 16px. */
const mascotArt: Record<
  MascotKind,
  { body: string; fill: string; light: [string, string]; shade: [string, string] }
> = {
  spark: {
    body: "M24 3c4 0 5 6 8 7s8-2 10 2-2 8-1 11 6 6 4 10-8 3-10 5-3 8-7 8-5-5-8-6-8 2-11-1-1-8-2-11-7-5-6-9 7-4 10-6 4-7 8-7l5-3Z",
    fill: "#FFB02E",
    light: ["M9 19c2-4 7-4 10-7 2-2 3-5 5-5", "#FFD47A"],
    shade: ["M14 34c7 7 15 7 22 0", "#E08A00"],
  },
  maker: {
    body: "M12 4h24c6 0 10 5 10 11v19c0 7-5 12-12 12H14C7 46 2 41 2 34V15C2 9 6 4 12 4Z",
    fill: "#FF6B57",
    light: ["M8 17v-2c0-3 2-5 5-5h12", "#FFA08F"],
    shade: ["M9 35c1 4 4 6 8 6h15c4 0 7-2 8-6", "#E2463A"],
  },
  orbit: {
    body: "M25 3C12 3 2 12 2 25c0 12 9 20 22 20 12 0 22-7 22-19 0-6-3-9-7-11C36 8 32 3 25 3Z",
    fill: "#26C9A8",
    light: ["M9 22c1-7 7-12 14-12", "#8FE8D2"],
    shade: ["M11 35c6 6 18 7 25 0", "#0EA58C"],
  },
};

export function Mascot({ kind, className = "" }: { kind: MascotKind; className?: string }) {
  const art = mascotArt[kind];
  return (
    <svg
      className={`v3-mascot v3-mascot-${kind} ${className}`}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path d={art.body} fill={art.fill} />
      <path d={art.light[0]} stroke={art.light[1]} strokeWidth="3" strokeLinecap="round" />
      <path d={art.shade[0]} stroke={art.shade[1]} strokeWidth="2" strokeLinecap="round" />
      <g className="v3-mascot-eyes" fill="#182C35">
        <rect x="16" y="20" width="4.5" height="8" rx="2.25" />
        <rect x="27.5" y="20" width="4.5" height="8" rx="2.25" />
      </g>
    </svg>
  );
}
