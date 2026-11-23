// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthForkGatewayScope,
  AuthOrchestrationReadScope,
  AuthStandardClientScopes,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import { HttpRouter } from "effect/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ManagedPolicy from "../../policy/ManagedPolicy.ts";
import * as ForkGateway from "./ForkGateway.ts";
import * as ForkGatewayHttp from "./http.ts";

interface SidecarRequest {
  readonly url: string;
  readonly headers: NodeHttp.IncomingHttpHeaders;
}

/** A real sidecar on 127.0.0.1 that records what reaches it. */
const sidecar = Effect.acquireRelease(
  Effect.promise(async () => {
    const requests: SidecarRequest[] = [];
    const server = NodeHttp.createServer((request, response) => {
      requests.push({ url: request.url ?? "", headers: request.headers });
      if (request.url === "/old") {
        response.writeHead(302, { location: "/new" }).end();
        return;
      }
      response
        .writeHead(200, {
          "content-type": "text/html",
          "set-cookie": "t3_session=stolen; Path=/",
          "content-security-policy": "default-src *",
        })
        .end("<p>panel</p>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    return { server, port: address.port, requests };
  }),
  ({ server }) => Effect.promise(() => new Promise((resolve) => server.close(resolve))),
);

const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "t3-fork-gateway-test-" });
const layerDeps = Layer.mergeAll(
  EnvironmentAuth.layer.pipe(
    Layer.provide(ManagedPolicy.layerTest()),
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.layerIdentity),
  ),
  ForkGateway.layer,
).pipe(
  Layer.provideMerge(layerConfig),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

/** The gateway route with the real auth, a manifest naming `panel` at the sidecar's port. */
const gateway = Effect.gen(function* () {
  const { port, requests } = yield* sidecar;
  const context = yield* Layer.build(layerDeps);
  const config = Context.get(context, ServerConfig.ServerConfig);
  const fs = Context.get(context, FileSystem.FileSystem);
  const path = Context.get(context, Path.Path);
  yield* fs.makeDirectory(path.join(config.stateDir, "fork"), { recursive: true });
  yield* fs.writeFileString(
    path.join(config.stateDir, "fork", "gateway.json"),
    JSON.stringify({ extensions: [{ id: "panel", port }] }),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(ForkGatewayHttp.routeLayer, {
    disableLogger: true,
  });
  yield* Effect.addFinalizer(() => Effect.promise(dispose));
  const auth = Context.get(context, EnvironmentAuth.EnvironmentAuth);
  const fetch = (path: string, init?: RequestInit) =>
    Effect.promise(() => handler(new Request(`http://127.0.0.1${path}`, init), context));
  return { auth, fetch, requests };
});

const expectSandboxed = (response: Response) => {
  expect(response.headers.get("content-security-policy")).toBe("sandbox allow-scripts allow-forms");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
};

it.live("refuses callers without the gateway grant before reaching the sidecar", () =>
  Effect.gen(function* () {
    const { auth, fetch, requests } = yield* gateway;
    const standard = yield* auth.issueSession({ scopes: AuthStandardClientScopes });
    const anonymous = yield* fetch("/api/fork/ext/panel/");
    const withoutGrant = yield* fetch("/api/fork/ext/panel/", {
      headers: { authorization: `Bearer ${standard.token}` },
    });
    expect(anonymous.status).toBe(401);
    expect(withoutGrant.status).toBe(403);
    expectSandboxed(anonymous);
    expectSandboxed(withoutGrant);
    expect(requests).toEqual([]);
  }).pipe(Effect.scoped),
);

it.live("answers 404 for an id the manifest does not declare", () =>
  Effect.gen(function* () {
    const { auth, fetch, requests } = yield* gateway;
    const session = yield* auth.issueSession({ scopes: [AuthForkGatewayScope] });
    const response = yield* fetch("/api/fork/ext/other/", {
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(response.status).toBe(404);
    expectSandboxed(response);
    expect(requests).toEqual([]);
  }).pipe(Effect.scoped),
);

it.live("forwards no T3 credential and returns no sidecar cookie", () =>
  Effect.gen(function* () {
    const { auth, fetch, requests } = yield* gateway;
    const session = yield* auth.issueSession({
      scopes: [AuthOrchestrationReadScope, AuthForkGatewayScope],
    });
    const ticket = yield* auth.issueWebSocketTicket(session, { use: "media" });
    const response = yield* fetch(
      `/api/fork/ext/panel/view?tab=1&wsTicket=${Redacted.value(ticket.ticket)}`,
      {
        headers: {
          authorization: `Bearer ${session.token}`,
          cookie: `t3_session=${session.token}`,
          dpop: "proof",
          "x-forwarded-for": "10.0.0.1",
          accept: "text/html",
        },
      },
    );
    expect(response.status).toBe(200);
    expect(yield* Effect.promise(() => response.text())).toBe("<p>panel</p>");
    expect(response.headers.get("set-cookie")).toBeNull();
    expectSandboxed(response);
    expect(requests.map(({ url }) => url)).toEqual(["/view?tab=1"]);
    const [{ headers }] = requests as [SidecarRequest];
    expect(headers.accept).toBe("text/html");
    for (const name of ["authorization", "cookie", "dpop", "x-forwarded-for"]) {
      expect(headers[name]).toBeUndefined();
    }
  }).pipe(Effect.scoped),
);

it.live("hands a sidecar's redirect back to the browser instead of following it", () =>
  Effect.gen(function* () {
    const { auth, fetch, requests } = yield* gateway;
    const session = yield* auth.issueSession({ scopes: [AuthForkGatewayScope] });
    const response = yield* fetch("/api/fork/ext/panel/old", {
      headers: { authorization: `Bearer ${session.token}` },
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/api/fork/ext/panel/new");
    expect(requests.map(({ url }) => url)).toEqual(["/old"]);
  }).pipe(Effect.scoped),
);
