import { exchangeRemoteDpopAccessToken } from "@t3tools/client-runtime/authorization";
import {
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
  connectionRouteId,
  connectionRoutes,
  DpopConnectionCredential,
  EnvironmentRegistry,
  mapRemoteEnvironmentError,
  orchestrationProtocolCompatibilityError,
} from "@t3tools/client-runtime/connection";
import {
  environmentEndpointUrl,
  fetchRemoteEnvironmentDescriptor,
} from "@t3tools/client-runtime/environment";
import { ClientCapabilities } from "@t3tools/client-runtime/platform";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import {
  AuthFilesystemReadScope,
  AuthForkGatewayScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthTerminalOperateScope,
  type AuthEnvironmentScope,
  type EnvironmentId,
} from "@t3tools/contracts";
import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { originAllowed } from "./csp.ts";
import { connectionAtomRuntime } from "./runtime.ts";
import { failureText } from "./status.ts";
import { storedRegistration } from "./storage.ts";
import { machinesChanged } from "./tabs.ts";

// Read threads; answer approvals and questions and send turns. Both of the latter are
// orchestration commands, and `orchestration:operate` is the only scope that dispatches them.
// Also the extension sidecars, which only a link that carries `fork:gateway` grants, and the
// images and videos a reply names by path, which the machine serves only to `filesystem:read`.
export const ADE_SCOPES: ReadonlyArray<AuthEnvironmentScope> = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthForkGatewayScope,
  AuthFilesystemReadScope,
];

export interface PairingInput {
  /** Also ask for a shell on the machine. Off by default: it is more than driving its agents. */
  readonly terminal?: boolean;
  readonly pairingUrl?: string;
  readonly host?: string;
  readonly pairingCode?: string;
}

/** Why pairing failed, in Spanish and safe to show: it never carries the link or a token. */
export class PairingError extends Schema.TaggedError<PairingError>()("PairingError", {
  message: Schema.String,
}) {}

const failed = (message: string) => new PairingError({ message });

/** A link with its code in `?token=` already showed it to whoever serves the page it opens. */
export const tokenInQuery = (link: string) =>
  URL.canParse(link) && new URL(link).searchParams.has("token");

export const TOKEN_IN_QUERY_TEXT =
  "Este enlace lleva el código en «?token=», a la vista del servidor que aloja la página. No se ha usado: crea un enlace nuevo y ábrelo con el código en «#token=».";

/**
 * The registry adds a pairing to the routes it already holds. Storage kept only the new one, so
 * the others leave the registry as well.
 */
const keepOnlyRoute = Effect.fn("ade.pairing.keepOnlyRoute")(function* (
  environmentId: EnvironmentId,
  connectionId: string,
) {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const entry = (yield* SubscriptionRef.get(registry.entries)).get(environmentId);
  for (const route of entry === undefined ? [] : connectionRoutes(entry)) {
    const routeId = connectionRouteId(route.target);
    if (routeId !== connectionId) yield* registry.removeRoute(environmentId, routeId);
  }
  yield* registry.setCompatibility(environmentId, null);
});

/**
 * `ConnectionOnboarding.registerPairing` with two differences the ADE needs: it asks for
 * `ADE_SCOPES` (plus the terminal, when chosen) instead of the link's whole grant, and it never
 * falls back to a bearer token.
 */
const pair = Effect.fn("ade.pairing.pair")(function* (input: PairingInput) {
  if (input.pairingUrl !== undefined && tokenInQuery(input.pairingUrl)) {
    return yield* failed(TOKEN_IN_QUERY_TEXT);
  }
  const target = yield* Effect.try({
    try: () => resolveRemotePairingTarget(input),
    catch: () => failed("El enlace o el código de emparejamiento no es válido."),
  });
  if (import.meta.env.PROD && !originAllowed(target.httpBaseUrl, __ADE_CONNECT_ORIGINS__)) {
    return yield* failed(
      `Este ADE no tiene permitido conectarse a ${new URL(target.httpBaseUrl).origin}. Añádelo a ADE_CONNECT_ORIGINS y vuelve a construirlo.`,
    );
  }
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({
    httpBaseUrl: target.httpBaseUrl,
  }).pipe(Effect.mapError((error) => mapRemoteEnvironmentError(error)));
  const incompatible = orchestrationProtocolCompatibilityError(descriptor);
  if (incompatible !== null) return yield* incompatible;
  if (descriptor.capabilities.accessTokenRenewal !== true) {
    return yield* failed(
      `${descriptor.label} no admite sesiones ligadas a una clave (DPoP). Actualiza T3 Code en esa máquina.`,
    );
  }

  // A machine has one route, whatever its address, and each pairing names it anew: a connection
  // made before the machine was paired again asks for a credential that is no longer stored.
  const random = yield* SecureRandom.SecureRandom;
  const connectionId = `bearer:${descriptor.environmentId}:${yield* random.uuidV4()}`;
  const route = {
    target: new BearerConnectionTarget({
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      connectionId,
    }),
    profile: new BearerConnectionProfile({
      connectionId,
      environmentId: descriptor.environmentId,
      label: descriptor.label,
      httpBaseUrl: target.httpBaseUrl,
      wsBaseUrl: target.wsBaseUrl,
    }),
  };
  const signer = yield* ManagedRelay.ManagedRelayDpopSigner;
  const presentation = yield* ClientCapabilities.ClientPresentation;
  // The proof is made before the one-time code is sent, so a browser that cannot sign keeps it.
  const dpopProof = yield* signer
    .createProof({
      method: "POST",
      url: environmentEndpointUrl(target.httpBaseUrl, "/oauth/token"),
    })
    .pipe(
      Effect.mapError(() => failed("Este navegador no pudo crear su clave de emparejamiento.")),
    );
  const access = yield* exchangeRemoteDpopAccessToken({
    httpBaseUrl: target.httpBaseUrl,
    credential: target.credential,
    // The server grants only what the link carries, so asking never widens a narrower link.
    scopes: input.terminal === true ? [...ADE_SCOPES, AuthTerminalOperateScope] : ADE_SCOPES,
    clientMetadata: presentation.metadata,
    dpopProof,
  }).pipe(Effect.mapError((error) => mapRemoteEnvironmentError(error)));
  if (access.token_type !== "DPoP") {
    return yield* failed(`${descriptor.label} no devolvió una sesión DPoP.`);
  }

  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  // One stored write swaps the address and the credential, and only then is the old socket
  // closed: if the write fails, the machine stays as it was.
  const registered = yield* registry.register(
    new BearerConnectionRegistration({
      ...route,
      credential: new DpopConnectionCredential({
        accessToken: access.access_token,
        expiresAtEpochMs: (yield* Clock.currentTimeMillis) + access.expires_in * 1_000,
      }),
    }),
  );
  if (!registered) return yield* failed("Esta máquina no se puede volver a emparejar.");
  yield* keepOnlyRoute(descriptor.environmentId, connectionId);
  machinesChanged(descriptor.environmentId);
  return descriptor.environmentId;
});

export const pairMachine = createRuntimeCommand(connectionAtomRuntime, {
  label: "ade:pair-machine",
  concurrency: { mode: "serial", key: () => "ade-pairing" },
  execute: (input: PairingInput) =>
    pair(input).pipe(
      Effect.mapError((error) =>
        error._tag === "PairingError"
          ? error
          : failed(
              error._tag === "ConnectionPersistenceError"
                ? "No se pudo guardar la máquina en este navegador."
                : failureText("reason" in error ? error : null),
            ),
      ),
    ),
});

/** Takes in, for one machine, what another tab stored: its new pairing, or its removal. */
export const followMachine = createRuntimeCommand(connectionAtomRuntime, {
  label: "ade:follow-machine",
  concurrency: { mode: "serial", key: () => "ade-pairing" },
  execute: Effect.fn("ade.pairing.followMachine")(function* (environmentId: EnvironmentId) {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const stored = yield* storedRegistration(environmentId);
    if (Option.isNone(stored)) {
      return yield* registry
        .remove(environmentId)
        .pipe(Effect.catchTags({ EnvironmentNotRegisteredError: () => Effect.void }));
    }
    yield* registry.register(stored.value);
    yield* keepOnlyRoute(environmentId, connectionRouteId(stored.value.target));
  }),
});
