// @ts-check
import * as NodePath from "node:path";

export const APP_ORIGIN = "ade://app";

/**
 * Node's URL gives a custom scheme the origin "null", so the scheme and host are compared.
 * @param {string} url
 */
export function isAppUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "ade:" && parsed.host === "app";
  } catch {
    return false;
  }
}

/**
 * The file under `root` that an `ade://app/...` request names, or null when the request is for
 * another origin or would leave `root` (`..`, encoded or not).
 * @param {string} root
 * @param {string} requestUrl
 */
export function assetPath(root, requestUrl) {
  if (!isAppUrl(requestUrl)) return null;
  const url = new URL(requestUrl);
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  const file = NodePath.resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
  return file.startsWith(NodePath.resolve(root) + NodePath.sep) ? file : null;
}

/**
 * A link that leaves the app opens in the system browser only when it is plain web: no file:,
 * javascript:, or custom schemes that would launch another program.
 * @param {string} url
 */
export function externalUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}
