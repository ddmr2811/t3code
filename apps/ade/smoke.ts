// Smoke test of the built ADE against a real T3 dev server, on Replay (dev) turns only. Needs:
// a newest thread with a finished Replay `command-output` turn; T3_URL (T3CODE_DEV_ALLOWED_ORIGINS=
// <ADE_URL>); ADE_URL (built with ADE_CONNECT_ORIGINS=<T3_URL>); T3_PAIRING_TOKEN and, from
// `t3 pair --scope orchestration:read`, T3_READONLY_PAIRING_TOKEN. ADE_SMOKE_SHOT(S) save captures.
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
const readOnlyPairingToken = env("T3_READONLY_PAIRING_TOKEN");
const shots = process.env.ADE_SMOKE_SHOTS;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const shot = async (name: string) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
const consoleText: Array<string> = [];
const requestUrls: Array<string> = [];
const granted: Array<{ token_type: string; scope: string; access_token: string }> = [];
page.on("console", (message) => consoleText.push(message.text()));
page.on("request", (request) => requestUrls.push(request.url()));
page.on("websocket", (socket) => requestUrls.push(socket.url()));
page.on("response", async (response) => {
  if (response.url().endsWith("/oauth/token") && response.ok()) granted.push(await response.json());
});
const linkFor = (token: string) => `${adeUrl}/?host=${encodeURIComponent(t3Url)}#token=${token}`;
const pairingLink = linkFor(pairingToken);
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
  // The thread's own snapshot and stream arrive over this session: its turn shows both sides.
  const conversation = page.getByRole("list", { name: "Conversación" });
  await conversation.locator(".ade-msg-user").first().waitFor();
  NodeAssert.notEqual(
    (await conversation.locator(".ade-msg-agent").first().innerText()).trim(),
    "",
    "the agent's reply is shown",
  );

  // A turn sent from the composer runs on the server and its reply streams back into the timeline.
  const composer = page.getByRole("region", { name: "Compositor" });
  const message = composer.getByRole("textbox", { name: "Mensaje" });
  const repliesBefore = await conversation.locator(".ade-msg-agent").count();
  // Each run's messages are its own, so an earlier run's rows never satisfy a wait.
  const run = Math.random().toString(36).slice(2, 8);
  await shot("compositor-vacio");
  // The model comes from the machine's own list: a short scenario first, then a long one that
  // leaves time to queue and stop.
  const model = composer.locator("summary", { hasText: "Modelo:" });
  await model.click();
  await shot("compositor-selector");
  await composer.getByRole("radio", { name: "Command output" }).click();
  await message.fill(`Repite el comando ${run}`);
  await message.press("Enter");
  await conversation.locator(".ade-msg-user", { hasText: `Repite el comando ${run}` }).waitFor();
  await page.waitForFunction(
    (count) => document.querySelectorAll(".ade-msg-agent").length > count,
    repliesBefore,
  );
  NodeAssert.equal(await message.inputValue(), "", "a sent message leaves the composer");
  await composer.getByRole("button", { name: "Enviar", exact: true }).waitFor();

  await model.click();
  await composer.getByRole("radio", { name: "Showcase" }).click();
  await message.fill(`Turno largo ${run}`);
  await message.press("Enter");
  const stop = composer.getByRole("button", { name: "Parar", exact: true });
  await stop.waitFor();
  // While the agent works, a message waits in the server's queue and can be taken back.
  await message.fill(`Esto espera su turno ${run}`);
  await message.press("Enter");
  const queue = composer.getByRole("list", { name: "Mensajes en cola" });
  await queue.getByText(`Esto espera su turno ${run}`).waitFor();
  await shot("compositor-en-cola");
  await queue.getByRole("button", { name: "Retirar" }).click();
  await queue.waitFor({ state: "detached" });
  await stop.click();
  await composer.getByRole("button", { name: "Enviar", exact: true }).waitFor();
  NodeAssert.equal(await stop.count(), 0, "a stopped turn offers no Stop");
  NodeAssert.equal(
    await conversation.locator(".ade-msg-user", { hasText: `Esto espera su turno ${run}` }).count(),
    0,
    "a message taken out of the queue never runs",
  );

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

  // A read-only session sees threads but cannot send: the ADE disables the composer, and a send
  // that gets past it anyway is refused by the server and shown.
  await page.goto(linkFor(readOnlyPairingToken));
  await pair();
  await page.getByText("Conectada", { exact: true }).first().waitFor();
  NodeAssert.equal(granted.at(-1)?.scope, "orchestration:read", "the server granted read only");
  await firstThread.click();
  await composer.getByText(/^Solo lectura/).waitFor();
  await conversation.locator(".ade-msg-user").first().waitFor();
  NodeAssert.ok(await message.isDisabled(), "a read-only machine's composer is disabled");
  await shot("compositor-solo-lectura");
  await composer
    .locator("fieldset")
    .first()
    .evaluate((field) => field.removeAttribute("disabled"));
  await message.fill("No debería llegar");
  await message.press("Enter");
  await composer.getByRole("alert").filter({ hasText: "No se pudo" }).waitFor();
  await shot("compositor-solo-lectura-rechazo");

  const secrets = [
    pairingToken,
    readOnlyPairingToken,
    ...granted.map((grant) => grant.access_token),
  ];
  for (const secret of secrets) {
    NodeAssert.ok(
      !consoleText.some((line) => line.includes(secret)),
      "no token reaches the console",
    );
    NodeAssert.ok(
      !requestUrls.some(
        (url) =>
          url !== pairingLink && url !== linkFor(readOnlyPairingToken) && url.includes(secret),
      ),
      "no token travels in a URL",
    );
  }
  console.log("ADE smoke: ok");
} catch (error) {
  console.error("Sidebar at failure:", await page.locator("aside").innerText());
  await shot("fallo");
  throw error;
} finally {
  await browser.close();
}
