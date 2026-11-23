// The servers the ADE may reach are fixed when it is built (ADE_CONNECT_ORIGINS), so script
// running in the page cannot widen them. `*.` covers every machine of one tailnet.
const ENTRY = /^(https?):\/\/(\[::1\]|(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::(\d+|\*))?$/i;
// Plain HTTP carries the session in the clear: only this same computer may use it.
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function parseConnectOrigins(raw: string | undefined): ReadonlyArray<string> {
  const entries = (raw ?? "").split(/[\s,]+/).filter((entry) => entry !== "");
  for (const entry of entries) {
    const [, scheme, host] = ENTRY.exec(entry) ?? [];
    if (scheme === undefined || host === undefined) {
      throw new Error(`ADE_CONNECT_ORIGINS: origen no válido «${entry}»`);
    }
    if (scheme.toLowerCase() === "http" && !LOOPBACK.has(host.toLowerCase())) {
      throw new Error(`ADE_CONNECT_ORIGINS: «${entry}» debe ser https:// (http solo en loopback)`);
    }
  }
  return entries;
}

/** Each origin plus its WebSocket twin: CSP treats `https:` and `wss:` as different schemes. */
export function connectSrc(origins: ReadonlyArray<string>): string {
  return ["'self'", ...origins.flatMap((origin) => [origin, origin.replace(/^http/i, "ws")])].join(
    " ",
  );
}

/** Mirrors how the browser matches a CSP host source, so the UI can refuse before the fetch. */
export function originAllowed(url: string, origins: ReadonlyArray<string>): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  return origins.some((origin) => {
    const [, scheme, host, port] = ENTRY.exec(origin) ?? [];
    if (scheme === undefined || host === undefined) return false;
    if (target.protocol !== `${scheme.toLowerCase()}:`) return false;
    const hostMatches = host.startsWith("*.")
      ? target.hostname.endsWith(host.slice(1).toLowerCase())
      : target.hostname === host.toLowerCase();
    return hostMatches && (port === "*" || target.port === (port ?? ""));
  });
}
