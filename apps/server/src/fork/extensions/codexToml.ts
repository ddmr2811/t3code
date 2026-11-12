import { ForkExtensionsError } from "@t3tools/contracts";
import { parse } from "smol-toml";

export const isValidToml = (text: string): boolean => {
  try {
    parse(text);
    return true;
  } catch {
    return false;
  }
};

interface Line {
  readonly body: string;
  /** "" only for a last line without a line break. */
  readonly eol: string;
}

const splitLines = (text: string): Array<Line> => {
  const lines: Array<Line> = [];
  const pattern = /([^\r\n]*)(\r\n|\n|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match[0] === "") break;
    lines.push({ body: match[1] ?? "", eol: match[2] ?? "" });
  }
  return lines;
};

/** Parses the dotted key of a `[table]` header; null when the line is not one. */
const parseTableHeader = (body: string): ReadonlyArray<string> | null => {
  let i = 0;
  const skipSpaces = () => {
    while (body[i] === " " || body[i] === "\t") i += 1;
  };
  skipSpaces();
  if (body[i] !== "[" || body[i + 1] === "[") return null;
  i += 1;
  const segments: Array<string> = [];
  for (;;) {
    skipSpaces();
    const quote = body[i];
    if (quote === '"' || quote === "'") {
      i += 1;
      let value = "";
      for (;;) {
        const char = body[i];
        if (char === undefined) return null;
        if (char === quote) break;
        if (quote === '"' && char === "\\" && body[i + 1] !== undefined) {
          value += body[i + 1];
          i += 2;
          continue;
        }
        value += char;
        i += 1;
      }
      i += 1;
      segments.push(value);
    } else {
      const start = i;
      while (i < body.length && /[A-Za-z0-9_-]/.test(body[i] ?? "")) i += 1;
      if (i === start) return null;
      segments.push(body.slice(start, i));
    }
    skipSpaces();
    if (body[i] === ".") {
      i += 1;
      continue;
    }
    if (body[i] === "]") return segments;
    return null;
  }
};

interface ValueState {
  /** Open multi-line string delimiter carried to the next line. */
  readonly multiline: '"""' | "'''" | null;
  /** Open `[`/`{` count carried to the next line. */
  readonly depth: number;
}

/** Tracks multi-line strings and arrays so their inner lines are never read as headers/keys. */
const advanceValueState = (body: string, state: ValueState): ValueState => {
  let multiline = state.multiline;
  let depth = state.depth;
  let i = 0;
  while (i < body.length) {
    if (multiline !== null) {
      if (multiline === '"""' && body[i] === "\\") {
        i += 2;
        continue;
      }
      if (body.startsWith(multiline, i)) {
        multiline = null;
        i += 3;
        continue;
      }
      i += 1;
      continue;
    }
    const char = body[i];
    if (char === "#") break;
    if (body.startsWith('"""', i) || body.startsWith("'''", i)) {
      multiline = body.slice(i, i + 3) as '"""' | "'''";
      i += 3;
      continue;
    }
    if (char === '"' || char === "'") {
      i += 1;
      while (i < body.length && body[i] !== char) {
        i += char === '"' && body[i] === "\\" ? 2 : 1;
      }
      i += 1;
      continue;
    }
    if (char === "[" || char === "{") depth += 1;
    if (char === "]" || char === "}") depth = Math.max(0, depth - 1);
    i += 1;
  }
  return { multiline, depth };
};

const ENABLED_LINE = /^(\s*enabled\s*=\s*)(?:true|false)(?=\s|#|$)/;

/**
 * Sets `enabled = <value>` inside the `[mcp_servers.<name>]` table of a Codex
 * config.toml, replacing the existing value or inserting the line right after the
 * header. Everything else (comments, order, whitespace, line endings) is untouched.
 */
export const setCodexMcpEnabled = (toml: string, serverName: string, enabled: boolean): string => {
  const lines = splitLines(toml);
  const crlf = toml.includes("\r\n");
  const value = enabled ? "true" : "false";

  let state: ValueState = { multiline: null, depth: 0 };
  let headerIndex = -1;
  let inTarget = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const continuing = state.multiline !== null || state.depth > 0;
    if (!continuing) {
      const isHeaderLine = /^\s*\[/.test(line.body);
      if (isHeaderLine) {
        const segments = parseTableHeader(line.body);
        if (inTarget) break;
        if (
          segments !== null &&
          segments.length === 2 &&
          segments[0] === "mcp_servers" &&
          segments[1] === serverName
        ) {
          headerIndex = index;
          inTarget = true;
        }
        continue;
      }
      if (inTarget && ENABLED_LINE.test(line.body)) {
        const body = line.body.replace(ENABLED_LINE, (_, prefix: string) => `${prefix}${value}`);
        return [...lines.slice(0, index), { body, eol: line.eol }, ...lines.slice(index + 1)]
          .map((entry) => entry.body + entry.eol)
          .join("");
      }
    }
    state = advanceValueState(line.body, state);
  }

  if (headerIndex === -1) {
    throw new ForkExtensionsError({
      problem: {
        reason: "notFound",
        summary: `No MCP server named "${serverName}" in the Codex config.`,
        nextStep: "Refresh the page; the server may have been removed from the terminal.",
        rawOutput: null,
      },
    });
  }

  const eol = crlf ? "\r\n" : "\n";
  const header = lines[headerIndex]!;
  const before = lines.slice(0, headerIndex);
  const after = lines.slice(headerIndex + 1);
  const headerWithEol: Line = { body: header.body, eol: header.eol === "" ? eol : header.eol };
  const inserted: Line = { body: `enabled = ${value}`, eol: header.eol === "" ? "" : eol };
  return [...before, headerWithEol, inserted, ...after]
    .map((entry) => entry.body + entry.eol)
    .join("");
};
