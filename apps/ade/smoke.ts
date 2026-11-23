// Smoke test of the built ADE against a real T3 server; `vp run --filter @t3tools/ade smoke`.
// Needs a server with at least one thread, T3_URL (dev server started with T3CODE_DEV_ALLOWED_ORIGINS=<ADE_URL>), ADE_URL (a
// `preview` of a build made with ADE_CONNECT_ORIGINS=<T3_URL>) and T3_PAIRING_TOKEN (`t3 pair`).
// ADE_SMOKE_SHOT=<file.png> also saves the connected sidebar.
import * as NodeAssert from "node:assert/strict";

import { chromium } from "playwright";

const env = (name: string) => {
  const value = process.env[name];
  NodeAssert.ok(value, `${name} is required`);
  return value;
};
const adeUrl = env("ADE_URL");
const t3Url = env("T3_URL");
const pairingToken = env("T3_PAIRING_TOKEN");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const consoleText: Array<string> = [];
const requestUrls: Array<string> = [];
const granted: Array<{ token_type: string; scope: string; access_token: string }> = [];
page.on("console", (message) => consoleText.push(message.text()));
page.on("request", (request) => requestUrls.push(request.url()));
page.on("websocket", (socket) => requestUrls.push(socket.url()));
page.on("response", async (response) => {
  if (response.url().endsWith("/oauth/token") && response.ok()) granted.push(await response.json());
});
const pairingLink = `${adeUrl}/?host=${encodeURIComponent(t3Url)}#token=${pairingToken}`;
const pair = () => page.getByRole("button", { name: "Emparejar", exact: true }).click();

try {
  const opened = await page.goto(pairingLink);
  NodeAssert.match(
    opened?.headers()["content-security-policy"] ?? "",
    /frame-ancestors 'none'/,
    "the ADE is served with frame-ancestors 'none'",
  );
  NodeAssert.equal(page.url(), `${adeUrl}/`, "the pairing link leaves the address bar");

  // A server on another protocol version is refused before the one-time token is spent.
  await page.route("**/.well-known/t3/environment", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), orchestrationProtocolVersion: 99 },
    });
  });
  await pair();
  await page.getByRole("alert").filter({ hasText: "Protocolo incompatible" }).waitFor();
  NodeAssert.equal(granted.length, 0, "an incompatible server gets no token request");
  await page.unroute("**/.well-known/t3/environment");

  await pair();
  await page.getByText("Conectada", { exact: true }).first().waitFor();
  await page.getByText(/\d+ proyectos? · \d+ hilos?/).waitFor();
  if (process.env.ADE_SMOKE_SHOT) await page.screenshot({ path: process.env.ADE_SMOKE_SHOT });

  // The server needs a thread: the sidebar lists it from the live shell, and choosing it keeps it.
  const firstThread = page
    .getByRole("navigation", { name: "Hilos" })
    .locator(".ade-thread-title")
    .first();
  const title = await firstThread.innerText();
  await firstThread.click();
  NodeAssert.match(page.url(), /[?&]hilo=/, "the selected thread is in the address");
  await page.getByRole("heading", { level: 1, name: title, exact: true }).waitFor();

  NodeAssert.equal(granted[0]?.token_type, "DPoP", "the session is bound to this browser's key");
  NodeAssert.equal(
    granted[0]?.scope.split(" ").toSorted().join(" "),
    "orchestration:operate orchestration:read",
    "the ADE holds only the scopes it asked for",
  );

  const stored = await page.evaluate(
    () =>
      new Promise<{ extractable: boolean; catalog: string; localStorage: number }>((resolve) => {
        const open = indexedDB.open("ade");
        open.addEventListener("success", () => {
          const store = open.result.transaction("kv").objectStore("kv");
          const key = store.get("dpop-key");
          const catalog = store.get("catalog");
          catalog.addEventListener("success", () =>
            resolve({
              extractable: key.result.privateKey.extractable,
              catalog: catalog.result,
              localStorage: localStorage.length + sessionStorage.length,
            }),
          );
        });
      }),
  );
  NodeAssert.equal(stored.extractable, false, "the DPoP private key cannot be exported");
  NodeAssert.match(stored.catalog, /DpopConnectionCredential/);
  NodeAssert.doesNotMatch(stored.catalog, /BearerConnectionCredential/);
  NodeAssert.equal(stored.localStorage, 0, "nothing is kept in localStorage or sessionStorage");

  // The page cannot read a cross-origin answer without CORS headers, and /mcp sends none. The
  // no-cors request exists only so the test can see the status the server gave the browser.
  const mcpResponse = page.waitForResponse((response) => response.url().endsWith("/mcp"));
  const probe = await page.evaluate(async (base) => {
    const post = (url: string, mode: RequestMode) =>
      fetch(url, { method: "POST", body: "{}", mode }).then(
        (response) => response.type,
        () => "blocked",
      );
    return {
      mcp: await post(`${base}/mcp`, "cors"),
      mcpOpaque: await post(`${base}/mcp`, "no-cors"),
      elsewhere: await post("https://example.com/", "no-cors"),
    };
  }, t3Url);
  NodeAssert.equal((await mcpResponse).status(), 403, "/mcp refuses a browser origin");
  NodeAssert.equal(probe.mcp, "blocked", "the page cannot read the /mcp response");
  NodeAssert.equal(probe.elsewhere, "blocked", "connect-src blocks an origin that is not a server");

  await page.reload();
  await page.getByText("Conectada", { exact: true }).first().waitFor();

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: /^Quitar / }).click();
  await page.getByText("Ninguna emparejada").waitFor();
  const forgotten = await page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const open = indexedDB.open("ade");
        open.addEventListener("success", () => {
          const catalog = open.result.transaction("kv").objectStore("kv").get("catalog");
          catalog.addEventListener("success", () => resolve(catalog.result));
        });
      }),
  );
  NodeAssert.doesNotMatch(forgotten, /accessToken/, "removing a machine forgets its credential");

  const secrets = [pairingToken, ...granted.map((grant) => grant.access_token)];
  for (const secret of secrets) {
    NodeAssert.ok(
      !consoleText.some((line) => line.includes(secret)),
      "no token reaches the console",
    );
    NodeAssert.ok(
      !requestUrls.some((url) => url !== pairingLink && url.includes(secret)),
      "no token travels in a URL",
    );
  }
  console.log("ADE smoke: ok");
} catch (error) {
  console.error("Sidebar at failure:", await page.locator("aside").innerText());
  throw error;
} finally {
  await browser.close();
}
