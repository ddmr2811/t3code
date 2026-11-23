// Fork-only: `/api/fork/ext/<id>/*` proxies to the sidecar the manifest declares for `<id>`, on
// 127.0.0.1 only. T3's credentials end here: none is forwarded, and no sidecar can set a cookie
// on T3's origin or run its HTML with that origin.
import { AuthForkGatewayScope } from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
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

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../../auth/http.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
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
  // Answers depend on who asked, so no shared cache may keep one.
  "cache-control": "no-store",
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

/**
 * The credentials other authenticated routes take, or, for a frame that cannot send them, a
 * ticket issued for this extension alone (`forkGateway.panelTicket`). Media tickets are refused.
 */
const authenticate =
  /* Request instrumentation already owns the span; keep this helper in that context. */
  Effect.fnUntraced(function* (
    request: HttpServerRequest.HttpServerRequest,
    url: URL,
    id: string | undefined,
  ) {
    const ticket = url.searchParams.get("wsTicket");
    const session =
      ticket === null
        ? yield* (yield* EnvironmentAuth.EnvironmentAuth).authenticateHttpRequest(request).pipe(
            Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
              failEnvironmentAuthInvalid(
                EnvironmentAuth.serverAuthCredentialReason(error),
                EnvironmentAuth.serverAuthDpopFailureReason(error),
              ),
            ),
            Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
              failEnvironmentInternal("internal_error", error),
            ),
          )
        : yield* (yield* SessionStore.SessionStore).verifyWebSocketToken(ticket).pipe(
            Effect.catchIf(SessionStore.isSessionCredentialInvalidError, () =>
              failEnvironmentAuthInvalid("invalid_credential"),
            ),
            Effect.catch((error) => failEnvironmentInternal("internal_error", error)),
            Effect.filterOrElse(
              (verified) => id !== undefined && verified.audience === `fork-gateway:${id}`,
              () => failEnvironmentAuthInvalid("invalid_credential"),
            ),
          );
    if (!session.scopes.includes(AuthForkGatewayScope)) {
      return yield* failEnvironmentScopeRequired(AuthForkGatewayScope);
    }
    return session;
  });

/** A sidecar's redirect to one of its own paths, kept below its prefix once resolved. */
const rewriteLocation = (id: string, location: string | undefined) => {
  if (location === undefined || !location.startsWith("/")) return undefined;
  const prefix = `${FORK_GATEWAY_PREFIX}/${id}`;
  const target = new URL(`${prefix}${location}`, "http://gateway.invalid");
  if (target.origin !== "http://gateway.invalid" || !target.pathname.startsWith(`${prefix}/`)) {
    return undefined;
  }
  return `${target.pathname}${target.search}${target.hash}`;
};

const proxy = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = requestUrl(request);
  if (Option.isNone(url)) return text("Bad Request", 400);
  const [, id, rest = "/"] = ROUTE.exec(url.value.pathname) ?? [];
  // Before the manifest, so whoever lacks the grant cannot learn which ids exist.
  const session = yield* authenticate(request, url.value, id);
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

  // The ticket authenticated this request; the sidecar never sees it.
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
  // Revoking the session ends the wait and any stream already flowing.
  const invalidated = (yield* SessionStore.SessionStore)
    .awaitInvalidation(session.sessionId)
    .pipe(
      Effect.catch((error) => failEnvironmentInternal("internal_error", error).pipe(Effect.ignore)),
    );
  const client = HttpClient.withScope(yield* HttpClient.HttpClient);
  const response = yield* Effect.raceFirst(
    client.execute(upstream).pipe(
      // fetch follows redirects by default; a sidecar's redirect goes back to the browser instead.
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.timeout(RESPONSE_HEADERS_TIMEOUT),
      Effect.option,
    ),
    invalidated.pipe(Effect.andThen(failEnvironmentAuthInvalid("invalid_credential"))),
  );
  if (Option.isNone(response)) return text("The extension did not answer", 502);

  const headers = pick(response.value.headers, FORWARDED_RESPONSE_HEADERS);
  // Limitation: a redirect keeps no ticket, so a panel is one self-contained HTML document.
  const location = rewriteLocation(id, response.value.headers.location);
  if (location !== undefined) headers.location = location;
  return HttpServerResponse.stream(response.value.stream.pipe(Stream.interruptWhen(invalidated)), {
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
