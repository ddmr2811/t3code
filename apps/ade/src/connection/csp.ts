// The servers the ADE may reach are fixed when it is built (ADE_CONNECT_ORIGINS), so script
// running in the page cannot widen them. `*.` covers every machine of one tailnet.
const ENTRY = /^(https?):\/\/((?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::(\d+|\*))?$/i;
// Plain HTTP carries the session in the clear: only this same computer may use it, or a machine
// reached through Tailscale, which encrypts the path itself. No `[::1]`: Chromium drops an IPv6
// literal from a CSP source list, and `localhost` reaches it anyway.
const LOOPBACK = new Set(["127.0.0.1", "localhost"]);
// 100.64.0.0/10, the range Tailscale gives its machines.
const TAILSCALE_IP =
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){2}$/;
// `*.ts.net` would reach every tailnet in the world, and `*.net` far more: a wildcard names one.
const TOO_WIDE = /^\*\.(ts\.net|[a-z0-9-]+)$/i;

/** Whether plain HTTP may go to this host: a literal one, or a wildcard's suffix. */
function plainHttpAllowed(host: string): boolean {
  const name = host.toLowerCase();
  return LOOPBACK.has(name) || TAILSCALE_IP.test(name) || name.endsWith(".ts.net");
}

export function parseConnectOrigins(raw: string | undefined): ReadonlyArray<string> {
  const entries = (raw ?? "").split(/[\s,]+/).filter((entry) => entry !== "");
  for (const entry of entries) {
    const [, scheme, host] = ENTRY.exec(entry) ?? [];
    if (scheme === undefined || host === undefined) {
      throw new Error(`ADE_CONNECT_ORIGINS: origen no válido «${entry}»`);
    }
    if (TOO_WIDE.test(host)) {
      throw new Error(
        `ADE_CONNECT_ORIGINS: «${entry}» abre demasiado; usa el nombre de cada máquina o el de tu tailnet (*.<tailnet>.ts.net)`,
      );
    }
    if (scheme.toLowerCase() === "http" && !plainHttpAllowed(host)) {
      throw new Error(
        `ADE_CONNECT_ORIGINS: «${entry}» debe ser https:// (http solo en loopback, en IPs de Tailscale 100.64.0.0/10 y en nombres *.ts.net)`,
      );
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

/** Panels from the extension gateway, on the same servers and nowhere else. */
export function frameSrc(origins: ReadonlyArray<string>): string {
  return origins.length === 0 ? "'none'" : origins.join(" ");
}

/** Mirrors how the browser matches a CSP host source, so the UI can refuse before the fetch. */
export function originAllowed(url: string, origins: ReadonlyArray<string>): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (target.protocol === "http:" && !plainHttpAllowed(target.hostname)) return false;
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
