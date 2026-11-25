// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off processEnvInEffect:off - spawns the real server and pairs over its real HTTP routes.
// Fork: `usage:read` opens the usage summary and nothing else. A real server, a real pairing link
// and a real token exchange; only the scope in the link is chosen by the test.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeWS from "@effect/platform-node/NodeWS";
import { assert, it } from "@effect/vitest";
import {
  AuthAccessTokenType,
  AuthAccessWriteScope,
  AuthEnvironmentBootstrapTokenType,
  AuthOrchestrationReadScope,
  AuthTokenExchangeGrantType,
  AuthUsageReadScope,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_V2_WS_METHODS,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Socket from "effect/socket/Socket";

const BIN = NodePath.join(import.meta.dirname, "..", "bin.ts");

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = NodeNet.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as NodeNet.AddressInfo;
      probe.close(() => resolve(port));
    });
  });

/** `t3 serve` in its own base dir and HOME, stopped by the PID it was spawned with. */
const runningServer = Effect.acquireRelease(
  Effect.promise(async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "usage-read-"));
    const env = { PATH: process.env.PATH ?? "", HOME: NodePath.join(root, "user") };
    const home = NodePath.join(root, "home");
    const port = await freePort();
    const child = NodeChildProcess.spawn(
      process.execPath,
      [BIN, "serve", "--base-dir", home, "--host", "127.0.0.1", "--port", String(port)],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    await new Promise<void>((resolve, reject) => {
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes(`Listening on http://127.0.0.1:${port}`)) resolve();
      });
      child.once("exit", (code) => reject(new Error(`server exited ${code}:\n${output}`)));
    });
    return { root, env, home, port, child };
  }),
  ({ root, child }) =>
    Effect.promise(async () => {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
      NodeFS.rmSync(root, { recursive: true, force: true });
    }),
);

const pairCli = (
  server: { readonly home: string; readonly env: NodeJS.ProcessEnv },
  scopes: string[],
) => {
  const output = NodeChildProcess.execFileSync(
    process.execPath,
    [BIN, "pair", "--base-dir", server.home, ...scopes.flatMap((scope) => ["--scope", scope])],
    { env: server.env, encoding: "utf8" },
  );
  const credential = /^Token: (\S+)$/m.exec(output)?.[1];
  if (credential === undefined) throw new Error(`no token in:\n${output}`);
  return credential;
};

/** The real token exchange; without `scope` the session gets the link's whole grant. */
const exchange = (origin: string, credential: string, scope?: string) =>
  fetch(`${origin}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: AuthTokenExchangeGrantType,
      subject_token: credential,
      subject_token_type: AuthEnvironmentBootstrapTokenType,
      requested_token_type: AuthAccessTokenType,
      ...(scope === undefined ? {} : { scope }),
    }),
  }).then((response) => response.json() as Promise<{ access_token: string; scope: string }>);

const createLink = (origin: string, accessToken: string, scopes: string[]) =>
  fetch(`${origin}/api/auth/pairing-token`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ scopes }),
  });

it.live("a standard session hands on usage:read, which reads usage and nothing else", () =>
  Effect.gen(function* () {
    const server = yield* runningServer;
    const origin = `http://127.0.0.1:${server.port}`;

    const { ticket, scope, withoutDiagnostics } = yield* Effect.promise(async () => {
      // A standard session holds diagnostics:read but not usage:read, and may still delegate it.
      const standard = await exchange(origin, pairCli(server, []));
      const link = await createLink(origin, standard.access_token, [AuthUsageReadScope]);
      const { credential } = (await link.json()) as { credential: string };
      const exchanged = await exchange(origin, credential, AuthUsageReadScope);
      const issued = await fetch(`${origin}/api/auth/websocket-ticket`, {
        method: "POST",
        headers: { authorization: `Bearer ${exchanged.access_token}` },
      }).then((response) => response.json() as Promise<{ ticket: string }>);
      // Without diagnostics:read there is nothing to hand on.
      const manager = await exchange(
        origin,
        pairCli(server, [AuthOrchestrationReadScope, AuthAccessWriteScope]),
      );
      const refused = await createLink(origin, manager.access_token, [AuthUsageReadScope]);
      return { ticket: issued.ticket, scope: exchanged.scope, withoutDiagnostics: refused.status };
    });
    assert.equal(scope, AuthUsageReadScope);
    assert.equal(withoutDiagnostics, 403);

    const socketUrl = new URL(`ws://127.0.0.1:${server.port}/ws`);
    socketUrl.searchParams.set("wsTicket", ticket);
    socketUrl.searchParams.set(
      ORCHESTRATION_PROTOCOL_QUERY_PARAM,
      ORCHESTRATION_PROTOCOL_VERSION_TEXT,
    );
    // Built in the test's scope, so the socket stays open for every call below.
    const protocol = yield* Layer.build(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide(Socket.layerWebSocket(socketUrl.toString(), { openTimeout: "10 seconds" })),
        Layer.provide(NodeWS.layerWebSocketConstructor),
        Layer.provide(RpcSerialization.layerJson),
      ),
    );
    const client = yield* RpcClient.make(WsRpcGroup).pipe(Effect.provide(protocol));

    const summary = yield* client[WS_METHODS.serverGetUsageSummary]({
      sinceDay: "2026-11-23",
      untilDay: "2026-11-25",
      timeZone: "UTC",
    } as never);
    assert.isArray(summary.buckets);

    const history = { windowMs: 60_000, bucketMs: 60_000 };
    const denied: ReadonlyArray<Effect.Effect<unknown, { readonly _tag: string }>> = [
      client[WS_METHODS.serverGetTraceDiagnostics]({}),
      client[WS_METHODS.serverGetProcessDiagnostics]({}),
      client[WS_METHODS.serverGetProcessResourceHistory](history),
      client[WS_METHODS.serverGetResourceTelemetryHistory](history),
      Stream.runHead(client[WS_METHODS.subscribeResourceTelemetry]({})),
      client[WS_METHODS.serverRefreshUsageRates]({}),
      client[WS_METHODS.forkTailnetStatus]({}),
      client[WS_METHODS.forkMachinesNodeExporters]({}),
      client[WS_METHODS.forkInsightsLimitHistory]({ hours: 1 }),
      client[WS_METHODS.forkInsightsActivity]({ days: 1 }),
      client[WS_METHODS.forkActivityFeed]({}),
      // Nor orchestration: not the config, not the thread list.
      client[WS_METHODS.serverGetConfig]({}),
      Stream.runHead(client[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({})),
    ];
    for (const call of denied) {
      const error = yield* Effect.flip(Effect.asVoid(call));
      assert.equal(error._tag, "EnvironmentAuthorizationError");
    }
  }).pipe(Effect.scoped),
);
