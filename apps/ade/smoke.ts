// Smoke test of the built ADE against a real T3 dev server, Replay (dev) turns only. Newest thread:
// a finished Replay `command-output` turn, nothing pending, its project a Git repo (ADE_SMOKE_REPO).
// T3_URL allows ADE_URL (T3CODE_DEV_ALLOWED_ORIGINS); the ADE is built with ADE_CONNECT_ORIGINS=T3_URL.
// T3_PAIRING_TOKEN, T3_TERMINAL_PAIRING_TOKEN, T3_READONLY_PAIRING_TOKEN (--scope orchestration:read).
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

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
const terminalPairingToken = env("T3_TERMINAL_PAIRING_TOKEN");
const repo = env("ADE_SMOKE_REPO");
const shots = process.env.ADE_SMOKE_SHOTS;

const browser = await chromium.launch();
const consoleText: Array<string> = [];
const requestUrls: Array<string> = [];
const granted: Array<{ token_type: string; scope: string; access_token: string }> = [];
// What the server itself turned down, read off the socket: a refusal the ADE made up is not here.
const refusedScopes: Array<string> = [];
// Each page is its own browser profile: its own key, its own session.
const openPage = async () => {
  const opened = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    // The terminal is a canvas: the test reads what it shows by copying it.
    permissions: ["clipboard-read", "clipboard-write"],
  });
  opened.on("console", (message) => consoleText.push(message.text()));
  opened.on("request", (request) => requestUrls.push(request.url()));
  opened.on("websocket", (socket) => {
    requestUrls.push(socket.url());
    socket.on("framereceived", (frame) => {
      const scope = /"EnvironmentAuthorizationError".*?"requiredScope":"([a-z:-]+)"/.exec(
        String(frame.payload),
      )?.[1];
      if (scope !== undefined) refusedScopes.push(scope);
    });
  });
  opened.on("response", async (response) => {
    if (response.url().endsWith("/oauth/token") && response.ok())
      granted.push(await response.json());
  });
  return opened;
};
const page = await openPage();
const shot = async (name: string, of = page) => {
  if (shots) await of.screenshot({ path: `${shots}/${name}.png` });
};
const linkFor = (token: string) => `${adeUrl}/?host=${encodeURIComponent(t3Url)}#token=${token}`;
const pairingLink = linkFor(pairingToken);
const pair = (on = page) => on.getByRole("button", { name: "Emparejar", exact: true }).click();

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

  // The agent's requests are answered above the composer, and the turn goes on. Replay runs on
  // the generic ACP driver, as Hermes does: it sends no option list, so no wider grant is offered.
  const requests = page.getByRole("region", { name: "Peticiones pendientes" });
  const approval = requests.getByRole("article", { name: /^Aprobación/ });
  const sendWith = async (scenario: string, text: string) => {
    await model.click();
    await composer.getByRole("radio", { name: scenario }).click();
    await message.fill(text);
    await message.press("Enter");
  };
  // With full access the server answers for the user; asking is a mode of the thread.
  await composer.locator("summary", { hasText: "Modo:" }).click();
  await composer.getByRole("radio", { name: "Pedir aprobación" }).click();
  await sendWith("Write approval", `Pide permiso ${run}`);
  await approval.getByText(".codex-probe-write-action.txt").waitFor();
  NodeAssert.deepEqual(
    await approval.getByRole("button").allInnerTexts(),
    ["Aprobar esta vez", "Rechazar", "Cancelar"],
    "an agent that offers allow_always gets no session or always button",
  );
  await shot("aprobacion-en-el-hilo");
  // Replay only plays the edit back, so the test makes it: the turn's checkpoint takes it in.
  const written = `escrito por el turno ${run}`;
  NodeFS.writeFileSync(NodePath.join(repo, ".codex-probe-write-action.txt"), `${written}\n`);
  const repliesBeforeApproval = await conversation.locator(".ade-msg-agent").count();
  await approval.getByRole("button", { name: "Aprobar esta vez" }).click();
  await approval.waitFor({ state: "detached" });
  await page.waitForFunction(
    (count) => document.querySelectorAll(".ade-msg-agent").length > count,
    repliesBeforeApproval,
  );
  await composer.getByRole("button", { name: "Enviar", exact: true }).waitFor();

  // The turn ends in a checkpoint: its summary opens that turn's diff, with the line it wrote.
  const changes = page.getByRole("region", { name: "Cambios", exact: true });
  await conversation
    .getByRole("listitem")
    .filter({ hasText: `Pide permiso ${run}` })
    .getByRole("button", { name: /^1 fichero · \+1 −\d+$/ })
    .click();
  await changes
    .getByRole("article", { name: ".codex-probe-write-action.txt" })
    .getByText(written)
    .waitFor();
  await shot("diff-del-turno");
  await changes.getByRole("button", { name: "Volver a la conversación" }).click();
  await page.getByRole("button", { name: "Cambios del hilo", exact: true }).click();
  await changes.getByText(written).waitFor();
  await changes.getByRole("button", { name: "Volver a la conversación" }).click();
  await conversation.waitFor();

  await sendWith("Question", `Pregunta ${run}`);
  const question = requests.getByRole("form", { name: "Pregunta del agente" });
  const answer = question.getByRole("button", { name: "Enviar respuesta" });
  await question
    .getByText("Should this fixture prefer strict schemas or UI flexibility?")
    .waitFor();
  NodeAssert.ok(await answer.isDisabled(), "an unanswered question cannot be sent");
  await shot("pregunta-con-opciones");
  await question.getByRole("button", { name: /^Strict schemas/ }).click();
  await answer.click();
  await question.waitFor({ state: "detached" });
  await composer.getByRole("button", { name: "Enviar", exact: true }).waitFor();

  // The decisions panel opens from the block, answers in place, and closes with nothing left.
  await sendWith("Showcase", `Decide en el panel ${run}`);
  const sidebar = page.getByRole("complementary").first();
  const panel = page.getByRole("complementary", { name: "Decisiones" });
  await panel.getByRole("article", { name: /^Aprobación/ }).waitFor();
  await panel.getByRole("button", { name: "Cerrar" }).click();
  await panel.waitFor({ state: "detached" });
  await sidebar.getByRole("button", { name: /1\s*te necesita/ }).click();
  // The request's own text is only "Changed files": the path comes from the edit it is about.
  await panel.getByText(/\/src\/math\.ts$/).waitFor();
  await shot("panel-de-decisiones");
  await panel.getByRole("button", { name: "Aprobar esta vez" }).click();
  await panel.waitFor({ state: "detached" });
  await approval.waitFor({ state: "detached" });
  NodeAssert.equal(
    await sidebar.getByRole("button", { name: /te necesita/ }).count(),
    0,
    "with nothing pending the block is not a button",
  );
  await composer.getByRole("button", { name: "Enviar", exact: true }).waitFor();
  await shot("bloque-en-cero");

  // A read-only session, in another browser, sees the request but cannot answer it: the ADE
  // disables it, and an answer that gets past that is refused by the server and shown.
  await sendWith("Write approval", `Solo lectura ${run}`);
  await approval.waitFor();
  const reader = await openPage();
  await reader.goto(linkFor(readOnlyPairingToken));
  await pair(reader);
  await reader.getByText("Conectada", { exact: true }).first().waitFor();
  NodeAssert.equal(granted.at(-1)?.scope, "orchestration:read", "the server granted read only");
  await reader
    .getByRole("navigation", { name: "Hilos" })
    .locator(".ade-thread-title")
    .first()
    .click();
  const readerComposer = reader.getByRole("region", { name: "Compositor" });
  const readerMessage = readerComposer.getByRole("textbox", { name: "Mensaje" });
  const readerApproval = reader
    .getByRole("region", { name: "Peticiones pendientes" })
    .getByRole("article", { name: /^Aprobación/ });
  const readerApprove = readerApproval.getByRole("button", { name: "Aprobar esta vez" });
  await readerApprove.waitFor();
  await readerComposer.getByText(/^Solo lectura/).waitFor();
  NodeAssert.ok(await readerMessage.isDisabled(), "a read-only machine's composer is disabled");
  NodeAssert.ok(await readerApprove.isDisabled(), "a read-only session cannot approve");
  NodeAssert.equal(
    await reader.getByRole("complementary", { name: "Decisiones" }).count(),
    0,
    "a session that cannot answer is not asked to",
  );
  await shot("solo-lectura", reader);
  await readerApproval.locator("fieldset").evaluate((field) => field.removeAttribute("disabled"));
  await readerApprove.click();
  await readerApproval.getByRole("alert").filter({ hasText: "No se pudo responder" }).waitFor();
  await approval.waitFor();
  await readerComposer
    .locator("fieldset")
    .first()
    .evaluate((field) => field.removeAttribute("disabled"));
  await readerMessage.fill("No debería llegar");
  await readerMessage.press("Enter");
  await readerComposer.getByRole("alert").filter({ hasText: "No se pudo" }).waitFor();
  await shot("solo-lectura-rechazo", reader);
  // Answered from the first browser, the request leaves the second one too, with no error left.
  await approval.getByRole("button", { name: "Rechazar" }).click();
  await readerApproval.waitFor({ state: "detached" });
  NodeAssert.equal(
    await reader.getByRole("region", { name: "Peticiones pendientes" }).getByRole("alert").count(),
    0,
    "a request answered elsewhere leaves without an error",
  );
  await reader.close();
  await composer.getByRole("button", { name: "Enviar", exact: true }).waitFor();

  // The terminal is a grant of its own, and this session did not ask for it: the button is off
  // and says why. React drops a click on a disabled button, so forcing it calls its handler.
  const terminalButton = page.getByRole("button", { name: "Terminal", exact: true });
  const terminal = page.getByRole("region", { name: "Terminal", exact: true });
  NodeAssert.ok(await terminalButton.isDisabled(), "without the terminal grant the button is off");
  await terminalButton.hover({ force: true });
  await page.getByRole("tooltip").filter({ hasText: "permiso de terminal" }).waitFor();
  await shot("terminal-sin-permiso");
  await terminalButton.evaluate((button) => {
    const props = Object.entries(button).find(([name]) => name.startsWith("__reactProps$"))?.[1];
    props.onClick();
  });
  await terminal.getByRole("alert").filter({ hasText: "La máquina rechazó el terminal" }).waitFor();
  NodeAssert.ok(refusedScopes.includes("terminal:operate"), "the server refused the terminal");
  await shot("terminal-forzado-rechazado");
  await terminal.getByRole("button", { name: "Volver a la conversación" }).click();
  await conversation.waitFor();

  // Pairing again with «Permitir terminal» is what turns it on, for a link that carries it.
  await page.getByRole("button", { name: "Añadir máquina" }).click();
  await page.getByLabel("Enlace de emparejamiento o dirección").fill(linkFor(terminalPairingToken));
  await page.getByLabel(/^Permitir terminal/).check();
  await pair();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (button) => button.textContent === "Terminal" && !button.disabled,
    ),
  );
  NodeAssert.equal(
    granted.at(-1)?.scope.split(" ").toSorted().join(" "),
    "orchestration:operate orchestration:read terminal:operate",
    "asking for the terminal adds that one scope",
  );

  // A command typed into the terminal runs in the thread's folder and its output is drawn.
  await terminalButton.click();
  await terminal.getByRole("status").filter({ hasText: "En marcha" }).waitFor();
  // Each command prints its own mark, so what is read back is that command's output.
  let commands = 0;
  const shell = async (command: (mark: string) => string, expected: (mark: string) => RegExp) => {
    const mark = `m${(commands += 1)}x${run}`;
    await terminal.locator("canvas").click();
    await page.keyboard.insertText(command(mark));
    await page.keyboard.press("Enter");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await page.keyboard.press("Control+Shift+A");
      await page.keyboard.press("Control+Shift+C");
      const match = expected(mark).exec(await page.evaluate(() => navigator.clipboard.readText()));
      if (match !== null) return match[1];
      await page.waitForTimeout(100);
    }
    throw new Error(`the terminal never showed ${expected(mark)}`);
  };
  NodeAssert.equal(
    await shell(
      (mark) => `echo ${mark}-$((1234*5678)) "$PWD"`,
      (mark) => new RegExp(`${mark}-7006652 (\\S+)`),
    ),
    repo,
    "the shell starts in the thread's folder",
  );
  // Reading it back selected everything; a click leaves the capture as a user sees it.
  await terminal.locator("canvas").click();
  await shot("terminal-con-salida");
  // The shell's own grid follows the window.
  const shellSize = () =>
    shell(
      (mark) => `echo ${mark}-$(stty size | tr ' ' x)-fin`,
      (mark) => new RegExp(`${mark}-(\\d+x\\d+)-fin`),
    );
  const wide = await shellSize();
  await page.setViewportSize({ width: 1280, height: 720 });
  let narrow = wide;
  for (let attempt = 0; attempt < 20 && narrow === wide; attempt += 1) narrow = await shellSize();
  NodeAssert.notEqual(narrow, wide, "resizing the window resizes the shell");
  await page.setViewportSize({ width: 1920, height: 1080 });
  // A shell that ends says so and stays on screen; another one is a click away.
  await page.keyboard.insertText("exit");
  await page.keyboard.press("Enter");
  await terminal.getByRole("status").filter({ hasText: "El proceso terminó" }).waitFor();
  await terminal.getByRole("button", { name: "Abrir otro" }).click();
  await terminal.getByRole("status").filter({ hasText: "En marcha" }).waitFor();
  await terminal.getByRole("button", { name: "Cerrar terminal" }).click();
  await conversation.waitFor();

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

  const secrets = [
    pairingToken,
    readOnlyPairingToken,
    terminalPairingToken,
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
  console.error("Sidebar at failure:", await page.locator("aside").first().innerText());
  await shot("fallo");
  throw error;
} finally {
  await browser.close();
}
