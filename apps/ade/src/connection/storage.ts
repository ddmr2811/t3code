import { TokenStore } from "@t3tools/client-runtime/authorization";
import {
  ConnectionTransientError,
  CredentialStore,
  ProfileStore,
} from "@t3tools/client-runtime/connection";
import {
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
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

// Everything the ADE keeps lives here: IndexedDB can hold a CryptoKey without exposing its
// bytes, which localStorage cannot.
const DATABASE_NAME = "ade";
const STORE_NAME = "kv";
const CATALOG_KEY = "catalog";

function request<A>(run: (store: IDBObjectStore) => IDBRequest<A>, mode: IDBTransactionMode) {
  return new Promise<A>((resolve, reject) => {
    const open = indexedDB.open(DATABASE_NAME, 1);
    open.addEventListener("upgradeneeded", () => open.result.createObjectStore(STORE_NAME));
    open.addEventListener("error", () => reject(open.error));
    open.addEventListener("success", () => {
      const database = open.result;
      const transaction = database.transaction(STORE_NAME, mode);
      const pending = run(transaction.objectStore(STORE_NAME));
      transaction.addEventListener("complete", () => {
        database.close();
        resolve(pending.result);
      });
      const fail = () => {
        database.close();
        reject(transaction.error ?? pending.error);
      };
      transaction.addEventListener("error", fail);
      transaction.addEventListener("abort", fail);
    });
  });
}

export const readStored = (key: string): Promise<unknown> =>
  request((store) => store.get(key), "readonly");

export const writeStored = (key: string, value: unknown): Promise<unknown> =>
  request((store) => store.put(value, key), "readwrite");

type Catalog = ConnectionCatalogDocument;
const CatalogJson = Schema.fromJsonString(ConnectionCatalogDocument);
const decodeCatalog = Schema.decodeUnknownEffect(CatalogJson);
const encodeCatalog = Schema.encodeEffect(CatalogJson);

// The cause stays out of the message: a catalog that fails to decode holds tokens.
const storageError = () =>
  new ConnectionTransientError({
    reason: "remote-unavailable",
    detail: "No se pudo usar el almacén local de máquinas del ADE.",
  });

const makeCatalog = Effect.gen(function* () {
  const lock = yield* Semaphore.make(1);
  let cached: Catalog | undefined;
  const load = Effect.gen(function* () {
    if (cached !== undefined) return cached;
    const raw = yield* Effect.tryPromise({
      try: () => readStored(CATALOG_KEY),
      catch: storageError,
    });
    cached =
      typeof raw === "string"
        ? yield* decodeCatalog(raw).pipe(
            Effect.orElseSucceed(() => EMPTY_CONNECTION_CATALOG_DOCUMENT),
          )
        : EMPTY_CONNECTION_CATALOG_DOCUMENT;
    return cached;
  });
  return {
    read: lock.withPermits(1)(load),
    update: (transform: (catalog: Catalog) => Catalog) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const next = transform(yield* load);
          const encoded = yield* encodeCatalog(next).pipe(Effect.mapError(storageError));
          yield* Effect.tryPromise({
            try: () => writeStored(CATALOG_KEY, encoded),
            catch: storageError,
          });
          cached = next;
        }),
      ),
  };
});

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

const layerCatalogStores = Layer.effectContext(
  Effect.gen(function* () {
    const catalog = yield* makeCatalog;
    return Context.make(
      Persistence.ConnectionTargetStore,
      Persistence.ConnectionTargetStore.of({
        list: catalog.read.pipe(
          Effect.map((document) => document.targets),
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
          register: Effect.fn("Persistence.ConnectionRegistrationStore.register")(
            (registration, routes) =>
              catalog
                .update((document) => registerConnectionInCatalog(document, registration, routes))
                .pipe(Effect.mapError(persistenceError("register-connection"))),
          ),
          setRoutes: Effect.fn("Persistence.ConnectionRegistrationStore.setRoutes")(
            (environmentId, routes) =>
              catalog
                .update((document) => setRoutesInCatalog(document, environmentId, routes))
                .pipe(Effect.mapError(persistenceError("set-connection-routes"))),
          ),
          remove: Effect.fn("Persistence.ConnectionRegistrationStore.remove")((environmentId) =>
            catalog
              .update((document) => removeConnectionFromCatalog(document, environmentId))
              .pipe(Effect.mapError(persistenceError("remove-connection"))),
          ),
          setEnabled: Effect.fn("Persistence.ConnectionRegistrationStore.setEnabled")(
            (environmentId, enabled) =>
              catalog
                .update((document) =>
                  setConnectionEnabledInCatalog(document, environmentId, enabled),
                )
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
            catalog.update((document) => ({
              ...document,
              profiles: replaceCatalogValue(
                document.profiles,
                (value) => value.connectionId,
                profile,
              ),
            })),
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
          put: (connectionId, credential) =>
            catalog.update((document) => ({
              ...document,
              credentials: replaceCatalogValue(
                document.credentials,
                (value) => value.connectionId,
                {
                  connectionId,
                  credential,
                },
              ),
            })),
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
          put: (token) =>
            catalog.update((document) => putRemoteDpopTokenInCatalog(document, token)),
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
    );
  }),
);

export const layer = Layer.merge(layerCatalogStores, layerNoCache);
