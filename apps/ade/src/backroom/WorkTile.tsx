// Copiado de Backroom (github.com/AdrianAlonsoDev/backroom, 4ca0ae9), MIT, © 2026 Adrián Alonso. Ver ./NOTICE.
export type WorkKind =
  | "doc"
  | "web"
  | "research"
  | "calendar"
  | "chat"
  | "check"
  | "lock"
  | "spark"
  | "chart"
  | "key"
  | "folder"
  | "book";
export type Tone = "amber" | "coral" | "teal" | "sky" | "ink";

/** One hue per object. Identity colour decorates; it never encodes a state. */
export const workTone: Record<WorkKind, Tone> = {
  doc: "coral",
  web: "sky",
  research: "amber",
  calendar: "teal",
  chat: "sky",
  check: "teal",
  lock: "ink",
  spark: "amber",
  chart: "teal",
  key: "amber",
  folder: "amber",
  book: "teal",
};

/** Original object artwork: filled, rounded, lit from the top left. */
export function WorkGlyph({
  kind,
  tone = workTone[kind],
  className = "",
}: {
  kind: WorkKind;
  tone?: Tone;
  className?: string;
}) {
  return (
    <svg
      className={`v3-glyph ${className}`}
      data-tone={tone}
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <Glyph kind={kind} />
    </svg>
  );
}

/** A tinted squircle carrying one object. */
export function WorkTile({
  kind,
  tone = workTone[kind],
  size = "md",
  className = "",
}: {
  kind: WorkKind;
  tone?: Tone;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
}) {
  return (
    <span className={`v3-tile ${className}`} data-tone={tone} data-size={size} aria-hidden="true">
      <WorkGlyph kind={kind} tone={tone} />
    </span>
  );
}

function Glyph({ kind }: { kind: WorkKind }) {
  switch (kind) {
    case "doc":
      return (
        <>
          <path
            className="g-fill"
            d="M14 5h14.5L38 14.5V39a4 4 0 0 1-4 4H14a4 4 0 0 1-4-4V9a4 4 0 0 1 4-4Z"
          />
          <path className="g-shade" d="M28.5 5 38 14.5h-7.5a2 2 0 0 1-2-2V5Z" />
          <path
            className="g-line"
            d="M16 22h15M16 28h15M16 34h9"
            strokeWidth="2.6"
            strokeLinecap="round"
          />
          <path className="g-hi" d="M13 11v-1.5" strokeWidth="2.4" strokeLinecap="round" />
        </>
      );
    case "web":
      return (
        <>
          <rect className="g-fill" x="4" y="8" width="40" height="32" rx="8" />
          <path className="g-shade" d="M12 8h24a8 8 0 0 1 8 8v1H4v-1a8 8 0 0 1 8-8Z" />
          <g className="g-dot">
            <circle cx="11" cy="12.6" r="1.7" />
            <circle cx="16" cy="12.6" r="1.7" />
            <circle cx="21" cy="12.6" r="1.7" />
          </g>
          <rect className="g-solid" x="10" y="22" width="16" height="5" rx="2.5" />
          <rect className="g-soft" x="10" y="30" width="20" height="3.2" rx="1.6" />
          <rect className="g-soft" x="30" y="22" width="8" height="11.5" rx="2.6" />
        </>
      );
    case "research":
      return (
        <>
          <path
            className="g-shade-stroke"
            d="m31.5 31.5 9 9"
            strokeWidth="6.5"
            strokeLinecap="round"
          />
          <circle className="g-fill" cx="21" cy="21" r="15" />
          <circle className="g-glass" cx="21" cy="21" r="9.5" />
          <path
            className="g-hi"
            d="M14.5 18.5a7 7 0 0 1 5-5"
            strokeWidth="2.6"
            strokeLinecap="round"
          />
        </>
      );
    case "calendar":
      return (
        <>
          <rect className="g-fill" x="5" y="9" width="38" height="33" rx="8.5" />
          <path
            className="g-shade"
            d="M13.5 9h21A8.5 8.5 0 0 1 43 17.5V19H5v-1.5A8.5 8.5 0 0 1 13.5 9Z"
          />
          <rect className="g-ink" x="14" y="5" width="4.2" height="9" rx="2.1" />
          <rect className="g-ink" x="29.8" y="5" width="4.2" height="9" rx="2.1" />
          <g className="g-soft">
            <rect x="11" y="24" width="6" height="5" rx="1.8" />
            <rect x="21" y="24" width="6" height="5" rx="1.8" />
            <rect x="11" y="32" width="6" height="5" rx="1.8" />
            <rect x="21" y="32" width="6" height="5" rx="1.8" />
            <rect x="31" y="32" width="6" height="5" rx="1.8" />
          </g>
          <rect className="g-solid" x="31" y="24" width="6" height="5" rx="1.8" />
        </>
      );
    case "chat":
      return (
        <>
          <path
            className="g-fill"
            d="M11 7h26a7 7 0 0 1 7 7v14a7 7 0 0 1-7 7H23l-9.5 7v-7H11a7 7 0 0 1-7-7V14a7 7 0 0 1 7-7Z"
          />
          <g className="g-dot">
            <circle cx="15.5" cy="21" r="2.8" />
            <circle cx="24" cy="21" r="2.8" />
            <circle cx="32.5" cy="21" r="2.8" />
          </g>
          <path
            className="g-hi"
            d="M10 16v-1.5a4 4 0 0 1 3-3.8"
            strokeWidth="2.4"
            strokeLinecap="round"
          />
        </>
      );
    case "check":
      return (
        <>
          <rect className="g-fill" x="5" y="5" width="38" height="38" rx="12.5" />
          <path
            className="g-line"
            d="m15 24.5 6.2 6.2L33.5 17.5"
            strokeWidth="4.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            className="g-hi"
            d="M11 17v-2a5 5 0 0 1 4-4.8"
            strokeWidth="2.4"
            strokeLinecap="round"
          />
        </>
      );
    case "lock":
      return (
        <>
          <path
            className="g-shade-stroke"
            d="M15.5 21v-5.5a8.5 8.5 0 0 1 17 0V21"
            strokeWidth="5"
            strokeLinecap="round"
          />
          <rect className="g-fill" x="8" y="19" width="32" height="24" rx="8" />
          <circle className="g-dot" cx="24" cy="29" r="3.4" />
          <rect className="g-dot" x="22.5" y="30" width="3" height="7" rx="1.5" />
        </>
      );
    case "spark":
      return (
        <>
          <path
            className="g-fill"
            d="M22 4c1.6 8.4 5.6 12.4 14 14-8.4 1.6-12.4 5.6-14 14-1.6-8.4-5.6-12.4-14-14 8.4-1.6 12.4-5.6 14-14Z"
          />
          <path
            className="g-shade"
            d="M36 28c.9 4.6 3.1 6.8 7.7 7.7-4.6.9-6.8 3.1-7.7 7.7-.9-4.6-3.1-6.8-7.7-7.7 4.6-.9 6.8-3.1 7.7-7.7Z"
          />
        </>
      );
    case "chart":
      return (
        <>
          <rect className="g-fill" x="5" y="5" width="38" height="38" rx="11" />
          <rect className="g-soft" x="12" y="25" width="6" height="11" rx="2.4" />
          <rect className="g-soft" x="21" y="18" width="6" height="18" rx="2.4" />
          <rect className="g-solid" x="30" y="12" width="6" height="24" rx="2.4" />
        </>
      );
    case "key":
      return (
        <>
          <circle className="g-fill" cx="17" cy="21" r="12" />
          <path className="g-fill" d="M25 25h16a3 3 0 0 1 0 6h-2v5a2.5 2.5 0 0 1-5 0v-5h-9Z" />
          <circle className="g-dot" cx="15" cy="19" r="3.6" />
          <path
            className="g-hi"
            d="M9.5 17a8 8 0 0 1 4-5"
            strokeWidth="2.4"
            strokeLinecap="round"
          />
        </>
      );
    case "folder":
      return (
        <>
          <path className="g-shade" d="M5 13a5 5 0 0 1 5-5h9l4 5h15a5 5 0 0 1 5 5v2H5v-7Z" />
          <rect className="g-fill" x="5" y="16" width="38" height="26" rx="6" />
          <path className="g-hi" d="M10 22v-1.5" strokeWidth="2.4" strokeLinecap="round" />
          <rect className="g-soft" x="11" y="31" width="14" height="3.4" rx="1.7" />
        </>
      );
    case "book":
      return (
        <>
          <path
            className="g-fill"
            d="M8 8h13a5 5 0 0 1 3 1 5 5 0 0 1 3-1h13a2 2 0 0 1 2 2v26a2 2 0 0 1-2 2H28a4 4 0 0 0-4 3 4 4 0 0 0-4-3H8a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2Z"
          />
          <path className="g-shade" d="M22.8 9.2h2.4V41h-2.4z" />
          <path
            className="g-line"
            d="M11 16h8M11 22h8M29 16h8M29 22h6"
            strokeWidth="2.4"
            strokeLinecap="round"
          />
        </>
      );
  }
}
