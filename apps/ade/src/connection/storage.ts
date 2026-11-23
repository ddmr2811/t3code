import { TokenStore } from "@t3tools/client-runtime/authorization";
import {
  BearerConnectionRegistration,
  type ConnectionCredential,
  connectionRouteId,
  ConnectionTransientError,
  CredentialStore,
  ProfileStore,
} from "@t3tools/client-runtime/connection";
import {
  catalogRoutes,
  ConnectionCatalogDocument,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  Persistence,
  putRemoteDpopTokenInCatalog,
  registerConnectionInCatalog,
  removeCatalogValue,
  removeConnectionFromCatalog,
  replaceCatalogValue,
  setConnectionEnabledInCatalog,
  setRoutesInCatalog,
} from "@t3tools/client-runtime/platform";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// Everything the ADE keeps lives here: IndexedDB can hold a CryptoKey without exposing its
// bytes, which localStorage cannot.
const DATABASE_NAME = "ade";
const STORE_NAME = "kv";
const CATALOG_KEY = "catalog";

/** One IndexedDB transaction over a key: `next` sees what is stored and may replace it. */
function transact(key: string, next?: (stored: unknown) => unknown) {
  return new Promise<unknown>((resolve, reject) => {
    const open = indexedDB.open(DATABASE_NAME, 1);
    open.addEventListener("upgradeneeded", () => open.result.createObjectStore(STORE_NAME));
    open.addEventListener("error", () => reject(open.error));
    open.addEventListener("success", () => {
      const database = open.result;
      const transaction = database.transaction(STORE_NAME, next ? "readwrite" : "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const read = store.get(key);
      let failure: unknown;
      if (next !== undefined) {
        read.addEventListener("success", () => {
          try {
            store.put(next(read.result), key);
          } catch (error) {
            failure = error;
            transaction.abort();
          }
        });
      }
      transaction.addEventListener("complete", () => {
        database.close();
        resolve(read.result);
      });
      const fail = () => {
        database.close();
        reject(failure ?? transaction.error ?? read.error);
      };
      transaction.addEventListener("error", fail);
      transaction.addEventListener("abort", fail);
    });
  });
}

export const readStored = (key: string): Promise<unknown> => transact(key);

export const writeStored = (key: string, value: unknown): Promise<unknown> =>
  transact(key, () => value);

type Catalog = ConnectionCatalogDocument;
const CatalogJson = Schema.fromJsonString(ConnectionCatalogDocument);
const encodeCatalog = Schema.encodeSync(CatalogJson);
const decodeCatalog = Schema.decodeUnknownOption(CatalogJson);
const parseCatalog = (raw: unknown) =>
  Option.getOrElse(decodeCatalog(raw), () => EMPTY_CONNECTION_CATALOG_DOCUMENT);

const stalePairing = () => new Error("The machine was paired again or removed in another tab.");

// The cause stays out of the message: a catalog that fails to decode holds tokens.
const storageError = () =>
  new ConnectionTransientError({
    reason: "remote-unavailable",
    detail: "No se pudo usar el almacén local de máquinas del ADE.",
  });

// Nothing is kept in memory: every tab of this ADE shares the stored catalog, and a change is
// read, made and written inside one transaction, so no tab writes over what another just stored.
const catalog = {
  read: Effect.tryPromise({ try: () => transact(CATALOG_KEY), catch: storageError }).pipe(
    Effect.map(parseCatalog),
  ),
  update: (transform: (catalog: Catalog) => Catalog) =>
    Effect.tryPromise({
      try: () => transact(CATALOG_KEY, (raw) => encodeCatalog(transform(parseCatalog(raw)))),
      catch: storageError,
    }).pipe(Effect.asVoid),
};

/**
 * Stores a credential. A renewal names the credential it `replaces`: when that one is no longer
 * the stored one, the machine was paired again or removed meanwhile and the renewal is dropped.
 */
export function putCredentialInCatalog(
  document: Catalog,
  connectionId: string,
  credential: ConnectionCredential,
  replaces?: ConnectionCredential,
): Catalog {
  const stored = document.credentials.find((entry) => entry.connectionId === connectionId);
  if (replaces !== undefined && !Equal.equals(stored?.credential, replaces)) return document;
  return {
    ...document,
    credentials: replaceCatalogValue(document.credentials, (value) => value.connectionId, {
      connectionId,
      credential,
    }),
  };
}

const pairedCredentials = (document: Catalog, environmentId: EnvironmentId) => {
  const routeIds = new Set(catalogRoutes(document, environmentId).map(connectionRouteId));
  return document.credentials.filter((entry) => routeIds.has(entry.connectionId));
};

/**
 * Which pairing a machine's stored routes come from. Every pairing has a connection id of its
 * own, so this changes when the machine is paired again and is empty once it is removed.
 */
export const storedPairing = (document: Catalog, environmentId: EnvironmentId) =>
  pairedCredentials(document, environmentId)
    .map((entry) => entry.connectionId)
    .join(" ");

// The pairing this tab's connections were built from, per machine. Another tab may have paired
// the machine again or removed it since: what this tab then writes for it belongs to a pairing
// that is gone, and must not bring it back or touch the one stored now.
const tabPairing = new Map<EnvironmentId, string>();

/** Routes from a tab whose `pairing` is no longer the stored one are refused. */
export function setRoutesOfPairing(
  document: Catalog,
  environmentId: EnvironmentId,
  routes: Parameters<typeof setRoutesInCatalog>[2],
  pairing: string | undefined,
): Catalog {
  if (storedPairing(document, environmentId) !== pairing) throw stalePairing();
  return setRoutesInCatalog(document, environmentId, routes);
}

/** A tab on an older `pairing` only lets go of its own connections: the stored one stays. */
export const removePairing = (
  document: Catalog,
  environmentId: EnvironmentId,
  pairing: string | undefined,
): Catalog =>
  storedPairing(document, environmentId) === pairing
    ? removeConnectionFromCatalog(document, environmentId)
    : document;

// Registrations read back from the catalog: taking one in must not write it again.
const adopted = new WeakSet<object>();

/** What is stored for a machine, for a tab to take in after another tab paired it. */
export const storedRegistration = (environmentId: EnvironmentId) =>
  catalog.read.pipe(
    Effect.map((document) => {
      const stored = pairedCredentials(document, environmentId)[0];
      const target = catalogRoutes(document, environmentId).find(
        (route) => connectionRouteId(route) === stored?.connectionId,
      );
      const profile = document.profiles.find(
        (entry) => entry.connectionId === stored?.connectionId,
      );
      if (
        stored === undefined ||
        target?._tag !== "BearerConnectionTarget" ||
        profile?._tag !== "BearerConnectionProfile"
      ) {
        return Option.none();
      }
      const registration = new BearerConnectionRegistration({
        target,
        profile,
        credential: stored.credential,
      });
      adopted.add(registration);
      return Option.some(registration);
    }),
  );

const persistenceError =
  (operation: Persistence.ConnectionPersistenceError["operation"]) =>
  (error: ConnectionTransientError) =>
    new Persistence.ConnectionPersistenceError({ operation, message: error.message });

// The ADE reads live data only. Nothing from a server is cached on this device yet.
const layerNoCache = Layer.succeed(
  Persistence.EnvironmentCacheStore,
  Persistence.EnvironmentCacheStore.of({
    loadShell: Effect.fn("Persistence.EnvironmentCacheStore.loadShell")(() => Effect.succeedNone),
    saveShell: Effect.fn("Persistence.EnvironmentCacheStore.saveShell")(() => Effect.void),
    loadThread: Effect.fn("Persistence.EnvironmentCacheStore.loadThread")(() => Effect.succeedNone),
    saveThread: Effect.fn("Persistence.EnvironmentCacheStore.saveThread")(() => Effect.void),
    removeThread: Effect.fn("Persistence.EnvironmentCacheStore.removeThread")(() => Effect.void),
    loadServerConfig: Effect.fn("Persistence.EnvironmentCacheStore.loadServerConfig")(
      () => Effect.succeedNone,
    ),
    saveServerConfig: Effect.fn("Persistence.EnvironmentCacheStore.saveServerConfig")(
      () => Effect.void,
    ),
    loadVcsRefs: Effect.fn("Persistence.EnvironmentCacheStore.loadVcsRefs")(
      () => Effect.succeedNone,
    ),
    saveVcsRefs: Effect.fn("Persistence.EnvironmentCacheStore.saveVcsRefs")(() => Effect.void),
    removeVcsRefs: Effect.fn("Persistence.EnvironmentCacheStore.removeVcsRefs")(() => Effect.void),
    clearVcsRefs: Effect.fn("Persistence.EnvironmentCacheStore.clearVcsRefs")(() => Effect.void),
    clear: Effect.fn("Persistence.EnvironmentCacheStore.clear")(() => Effect.void),
  }),
);

const layerCatalogStores = Layer.succeedContext(
  Context.make(
    Persistence.ConnectionTargetStore,
    Persistence.ConnectionTargetStore.of({
      list: catalog.read.pipe(
        Effect.map((document) => {
          for (const { environmentId } of document.targets) {
            tabPairing.set(environmentId, storedPairing(document, environmentId));
          }
          return document.targets;
        }),
        Effect.mapError(persistenceError("list-targets")),
      ),
      listDisabled: catalog.read.pipe(
        Effect.map((document) => document.disabledEnvironmentIds),
        Effect.mapError(persistenceError("list-disabled-targets")),
      ),
    }),
  ).pipe(
    Context.add(
      Persistence.ConnectionRegistrationStore,
      Persistence.ConnectionRegistrationStore.of({
        // A pairing replaces every route the machine had, with their profiles and credentials:
        // the routes the registry still holds from an earlier pairing are not stored again.
        register: Effect.fn("Persistence.ConnectionRegistrationStore.register")((registration) => {
          const { environmentId } = registration.target;
          const pairing = connectionRouteId(registration.target);
          return catalog
            .update((document) => {
              if (!adopted.has(registration)) {
                return registerConnectionInCatalog(document, registration);
              }
              if (storedPairing(document, environmentId) !== pairing) throw stalePairing();
              return document;
            })
            .pipe(
              Effect.tap(() => Effect.sync(() => tabPairing.set(environmentId, pairing))),
              Effect.mapError(persistenceError("register-connection")),
            );
        }),
        setRoutes: Effect.fn("Persistence.ConnectionRegistrationStore.setRoutes")(
          (environmentId, routes) =>
            catalog
              .update((document) =>
                setRoutesOfPairing(document, environmentId, routes, tabPairing.get(environmentId)),
              )
              .pipe(Effect.mapError(persistenceError("set-connection-routes"))),
        ),
        remove: Effect.fn("Persistence.ConnectionRegistrationStore.remove")((environmentId) =>
          catalog
            .update((document) =>
              removePairing(document, environmentId, tabPairing.get(environmentId)),
            )
            .pipe(
              Effect.tap(() => Effect.sync(() => tabPairing.delete(environmentId))),
              Effect.mapError(persistenceError("remove-connection")),
            ),
        ),
        setEnabled: Effect.fn("Persistence.ConnectionRegistrationStore.setEnabled")(
          (environmentId, enabled) =>
            catalog
              .update((document) => setConnectionEnabledInCatalog(document, environmentId, enabled))
              .pipe(Effect.mapError(persistenceError("set-connection-enabled"))),
        ),
      }),
    ),
    Context.add(
      ProfileStore.ConnectionProfileStore,
      ProfileStore.make({
        get: (connectionId) =>
          catalog.read.pipe(
            Effect.map((document) =>
              Option.fromUndefinedOr(
                document.profiles.find((profile) => profile.connectionId === connectionId),
              ),
            ),
          ),
        put: (profile) =>
          catalog.update((document) =>
            storedPairing(document, profile.environmentId) === tabPairing.get(profile.environmentId)
              ? {
                  ...document,
                  profiles: replaceCatalogValue(
                    document.profiles,
                    (value) => value.connectionId,
                    profile,
                  ),
                }
              : document,
          ),
        remove: (connectionId) =>
          catalog.update((document) => ({
            ...document,
            profiles: removeCatalogValue(
              document.profiles,
              (value) => value.connectionId,
              connectionId,
            ),
          })),
      }),
    ),
    Context.add(
      CredentialStore.ConnectionCredentialStore,
      CredentialStore.make({
        get: (connectionId) =>
          catalog.read.pipe(
            Effect.map((document) =>
              Option.fromUndefinedOr(
                document.credentials.find((entry) => entry.connectionId === connectionId)
                  ?.credential,
              ),
            ),
          ),
        put: (connectionId, credential, replaces) =>
          catalog.update((document) =>
            putCredentialInCatalog(document, connectionId, credential, replaces),
          ),
        remove: (connectionId) =>
          catalog.update((document) => ({
            ...document,
            credentials: removeCatalogValue(
              document.credentials,
              (value) => value.connectionId,
              connectionId,
            ),
          })),
      }),
    ),
    Context.add(
      TokenStore.RemoteDpopAccessTokenStore,
      TokenStore.make({
        get: (environmentId) =>
          catalog.read.pipe(
            Effect.map((document) =>
              Option.fromUndefinedOr(
                document.remoteDpopTokens.find((token) => token.environmentId === environmentId),
              ),
            ),
          ),
        put: (token) => catalog.update((document) => putRemoteDpopTokenInCatalog(document, token)),
        remove: (environmentId) =>
          catalog.update((document) => ({
            ...document,
            remoteDpopTokens: removeCatalogValue(
              document.remoteDpopTokens,
              (value) => value.environmentId,
              environmentId,
            ),
          })),
      }),
    ),
  ),
);

export const layer = Layer.merge(layerCatalogStores, layerNoCache);
