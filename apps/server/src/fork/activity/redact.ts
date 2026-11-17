// Fork-only: every summary the activity feed sends goes through here, so a token pasted into a
// log line, a commit subject or a command line reaches no client.
import { FORK_ACTIVITY_SUMMARY_MAX } from "@t3tools/contracts";

const MASK = "•••";
/** Only this much of a line is scanned; a long one is cut first so the patterns stay cheap. */
const SCAN_MAX = 1_000;

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})/g, MASK],
  [/\bsk-[A-Za-z0-9_-]{6,}/g, MASK],
  [/\bxox[a-z]-[A-Za-z0-9-]{6,}/g, MASK],
  [/\bAKIA[0-9A-Z]{12,}/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g, MASK],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MASK}`],
  // `api_key=…`, `token: "…"`, `PASSWORD=…`: the name stays, the value goes.
  [
    /\b([A-Za-z0-9_.-]*(?:key|token|password|passwd|pwd|secret))(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    `$1$2${MASK}`,
  ],
  [/\b[0-9a-fA-F]{33,}\b/g, MASK],
];

/** Base64 and similar runs longer than 32 characters, unless they hold no digit (plain words). */
const LONG_RUN = /[A-Za-z0-9+/_=-]{33,}/g;

export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out.replace(LONG_RUN, (run) => (/\d/.test(run) && /[A-Za-z]/.test(run) ? MASK : run));
}

/**
 * The first non-empty line, whitespace collapsed, secrets masked and cut to the feed's limit with
 * an ellipsis. A line cut before masking loses its last partial word, so half a token never shows.
 */
export function summaryLine(text: string, max = FORK_ACTIVITY_SUMMARY_MAX): string {
  const line =
    text
      .split(/\r?\n/)
      .map((part) => part.trim())
      .find((part) => part.length > 0) ?? "";
  let scanned = line.length > SCAN_MAX ? line.slice(0, SCAN_MAX) : line;
  if (scanned.length < line.length) scanned = scanned.replace(/\S*$/, "");
  const clean = redactSecrets(scanned.replace(/\s+/g, " ").trim());
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).trimEnd()}…`;
}
