// Fork-only: `/api/fork/ext/<id>/*` proxies to the sidecar the manifest declares for `<id>`, on
// 127.0.0.1 only. T3's credentials end here: none is forwarded, and no sidecar can set a cookie
// on T3's origin or run its HTML with that origin.
import { AuthForkGatewayScope } from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpIncomingMessage,
  HttpMethod,
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";

import { authenticateMediaRequest } from "../../auth/http.ts";
import { requestUrl } from "../../requestUrl.ts";
import * as ForkGateway from "./ForkGateway.ts";

const FORK_GATEWAY_PREFIX = "/api/fork/ext";
const ROUTE = /^\/api\/fork\/ext\/([^/]+)(\/.*)?$/;
const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;
const RESPONSE_HEADERS_TIMEOUT = Duration.seconds(30);

// What a browser sends that a sidecar may use. Anything else, credentials above all, stays here.
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "accept-language",
  "cache-control",
  "content-type",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-range",
  "range",
  "user-agent",
];
// No set-cookie, no CORS, no policy of the sidecar's own: the gateway sets those below.
const FORWARDED_RESPONSE_HEADERS = [
  "accept-ranges",
  "cache-control",
  "content-disposition",
  "content-language",
  "content-range",
  "content-type",
  "etag",
  "expires",
  "last-modified",
  "vary",
];
// An opaque origin: a sidecar's page keeps its scripts and forms but cannot use T3's cookies or
// storage. `no-referrer` keeps a media ticket in the address out of the requests it makes.
const GATEWAY_HEADERS = {
  "content-security-policy": "sandbox allow-scripts allow-forms",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

const text = (body: string, status: number) => HttpServerResponse.text(body, { status });

const pick = (
  headers: Readonly<Record<string, string | undefined>>,
  names: ReadonlyArray<string>,
) =>
  Object.fromEntries(
    names.flatMap((name) => {
      const value = headers[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );

const proxy = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = requestUrl(request);
  if (Option.isNone(url)) return text("Bad Request", 400);
  // Before the manifest, so whoever lacks the grant cannot learn which ids exist.
  yield* authenticateMediaRequest(AuthForkGatewayScope);
  const [, id, rest = "/"] = ROUTE.exec(url.value.pathname) ?? [];
  const method = request.method;
  if (id === undefined) return text("Not Found", 404);
  if (request.headers.upgrade !== undefined) return text("WebSockets are not proxied", 501);
  if (!HttpMethod.isHttpMethod(method)) return text("Method Not Allowed", 405);
  const gateway = yield* ForkGateway.ForkGateway;
  const entry = (yield* gateway.manifest).extensions.find((extension) => extension.id === id);
  if (entry === undefined) return text("Not Found", 404);

  let body: Uint8Array | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const declared = Number(request.headers["content-length"] ?? "0");
    if (!Number.isFinite(declared) || declared > MAX_REQUEST_BODY_BYTES) {
      return text("Payload Too Large", 413);
    }
    // Chunked bodies declare no length, so the reader itself is capped.
    const read = yield* request.arrayBuffer.pipe(
      Effect.provideService(
        HttpIncomingMessage.MaxBodySize,
        ByteSize.bytes(MAX_REQUEST_BODY_BYTES),
      ),
      Effect.option,
    );
    if (Option.isNone(read)) return text("Payload Too Large", 413);
    body = new Uint8Array(read.value);
  }

  // The media ticket authenticated this request; the sidecar never sees it.
  const search = new URLSearchParams(url.value.search);
  search.delete("wsTicket");
  const query = search.size > 0 ? `?${search.toString()}` : "";
  const contentType = request.headers["content-type"];
  const upstream = HttpClientRequest.make(method)(
    `http://127.0.0.1:${entry.port}${rest}${query}`,
  ).pipe(
    HttpClientRequest.setHeaders(pick(request.headers, FORWARDED_REQUEST_HEADERS)),
    body === undefined ? (self) => self : HttpClientRequest.bodyUint8Array(body, contentType),
  );
  const client = HttpClient.withScope(yield* HttpClient.HttpClient);
  const response = yield* client.execute(upstream).pipe(
    // fetch follows redirects by default; a sidecar's redirect goes back to the browser instead.
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    Effect.timeout(RESPONSE_HEADERS_TIMEOUT),
    Effect.option,
  );
  if (Option.isNone(response)) return text("The extension did not answer", 502);

  const headers = pick(response.value.headers, FORWARDED_RESPONSE_HEADERS);
  // A path on the sidecar stays a path below its prefix; any other target is dropped.
  const location = response.value.headers.location;
  if (location?.startsWith("/") && !location.startsWith("//")) {
    headers.location = `${FORK_GATEWAY_PREFIX}/${id}${location}`;
  }
  return HttpServerResponse.stream(response.value.stream, {
    status: response.value.status,
    headers,
    ...(headers["content-type"] ? { contentType: headers["content-type"] } : {}),
  });
});

const handler = proxy.pipe(
  Effect.catchTags({
    EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
    EnvironmentInternalError: HttpServerRespondable.toResponse,
    EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
  }),
  // Every answer, refusals and errors included, carries the sandbox.
  Effect.map((response) => HttpServerResponse.setHeaders(response, GATEWAY_HEADERS)),
  // Its own client, whatever the server's is, so the redirect setting above holds.
  Effect.provide(FetchHttpClient.layer),
);

export const routeLayer = HttpRouter.add("*", `${FORK_GATEWAY_PREFIX}/*`, handler);
