import {
  Connection,
  ConnectionBlockedError,
  Connectivity,
  Wakeups,
} from "@t3tools/client-runtime/connection";
import { ClientCapabilities, PlatformConnectionSource } from "@t3tools/client-runtime/platform";
import { DpopProof, ManagedRelay } from "@t3tools/client-runtime/relay";
import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import { createEnvironmentCatalogAtoms } from "@t3tools/client-runtime/state/connections";
import {
  createEnvironmentShellAtoms,
  ShellSnapshotLoader,
} from "@t3tools/client-runtime/state/shell";
import { RelayWebClientId } from "@t3tools/contracts/relay";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { Atom } from "effect/reactivity";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";

import { loadOrCreateProofKey } from "./dpop.ts";
import * as Storage from "./storage.ts";

const unsupported = (detail: string) =>
  new ConnectionBlockedError({ reason: "unsupported", detail });

const windowEvents = <A>(events: Readonly<Record<string, A>>) =>
  Stream.callback<A>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const listeners = Object.entries(events).map(([name, value]) => {
          const listener = () => Queue.offerUnsafe(queue, value);
          window.addEventListener(name, listener);
          return [name, listener] as const;
        });
        return listeners;
      }),
      (listeners) =>
        Effect.sync(() => {
          for (const [name, listener] of listeners) window.removeEventListener(name, listener);
        }),
    ).pipe(Effect.asVoid),
  );

const layerPlatform = Layer.mergeAll(
  Storage.layer,
  Connectivity.layer({
    status: Effect.sync(() => (navigator.onLine ? "online" : "offline")),
    changes: windowEvents({ online: "online", offline: "offline" } as const),
  }),
  Wakeups.layer({ changes: windowEvents({ focus: "application-active" } as const) }),
  // The ADE only pairs directly with servers: no T3 Connect account, no SSH, no local server.
  Layer.succeed(ClientCapabilities.CloudSession, {
    identity: Effect.succeedNone,
    clerkToken: Effect.fail(unsupported("El ADE no usa T3 Connect.")),
  }),
  Layer.succeed(ClientCapabilities.RelayDeviceIdentity, { deviceId: Effect.succeedNone }),
  Layer.succeed(ClientCapabilities.PrimaryEnvironmentAuth, { bearerToken: Effect.succeedNone }),
  Layer.succeed(ClientCapabilities.ClientPresentation, {
    metadata: { label: "ADE", deviceType: "desktop", surface: "web" },
  }),
  Layer.succeed(ClientCapabilities.SshEnvironmentGateway, {
    provision: Effect.fn("ClientCapabilities.SshEnvironmentGateway.provision")(() =>
      Effect.fail(unsupported("El ADE no conecta por SSH.")),
    ),
    prepare: Effect.fn("ClientCapabilities.SshEnvironmentGateway.prepare")(() =>
      Effect.fail(unsupported("El ADE no conecta por SSH.")),
    ),
    disconnect: Effect.fn("ClientCapabilities.SshEnvironmentGateway.disconnect")(() => Effect.void),
  }),
  Layer.succeed(PlatformConnectionSource.PlatformConnectionSource, { registrations: Stream.empty }),
);

const layerCrypto = Layer.merge(Digest.layerWebCrypto, SecureRandom.layerWebCrypto);
const layerHttpClient = layerRemoteHttpClient((input, init) => globalThis.fetch(input, init));
const layerSigner = DpopProof.layerSigner({
  keyStore: "indexed-db",
  loadOrCreateKey: loadOrCreateProofKey,
});

const layerRuntime = Layer.mergeAll(
  layerHttpClient,
  layerCrypto,
  Socket.layerWebSocketConstructorGlobal,
  // The relay client is part of the shared connection layer; with no account it is never called.
  ManagedRelay.layer({ relayUrl: "http://relay.invalid", clientId: RelayWebClientId }).pipe(
    Layer.provideMerge(layerSigner),
    Layer.provide(Layer.merge(layerHttpClient, layerCrypto)),
  ),
);

export const connectionAtomRuntime = Atom.runtime(
  ShellSnapshotLoader.layer.pipe(
    Layer.provideMerge(Connection.layer),
    Layer.provideMerge(Layer.merge(layerRuntime, layerPlatform)),
  ),
);

export const environmentCatalog = createEnvironmentCatalogAtoms(connectionAtomRuntime);
export const environmentShell = createEnvironmentShellAtoms(connectionAtomRuntime);
