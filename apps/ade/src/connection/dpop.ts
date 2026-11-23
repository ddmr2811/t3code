import { DpopProof } from "@t3tools/client-runtime/relay";
import { DpopPublicJwk } from "@t3tools/shared/dpopCommon";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { readStored, writeStored } from "./storage.ts";

const KEY_ID = "dpop-key";
const ECDSA_P256 = { name: "ECDSA", namedCurve: "P-256" };
const isStoredKey = Schema.is(
  Schema.Struct({ privateKey: Schema.instanceOf(CryptoKey), publicJwk: DpopPublicJwk }),
);
const decodePublicJwk = Schema.decodeUnknownSync(DpopPublicJwk);

const keyError = (cause: unknown) =>
  new DpopProof.DpopProofError({
    message: "No se pudo preparar la clave de este navegador.",
    cause,
  });

async function loadOrCreateKey() {
  const stored = await readStored(KEY_ID);
  if (isStoredKey(stored)) return stored;
  // Not extractable: the private key can sign but never leaves the browser's key store.
  const pair = await crypto.subtle.generateKey(ECDSA_P256, false, ["sign"]);
  const key = {
    privateKey: pair.privateKey,
    publicJwk: decodePublicJwk(await crypto.subtle.exportKey("jwk", pair.publicKey)),
  };
  await writeStored(KEY_ID, key);
  return key;
}

/** This browser's proof key. Every paired machine's token is bound to it. */
export const loadOrCreateProofKey = Effect.tryPromise({
  try: loadOrCreateKey,
  catch: keyError,
}).pipe(
  Effect.map((key): DpopProof.DpopProofKey => ({
    publicJwk: key.publicJwk,
    sign: (signingInput) =>
      Effect.tryPromise({
        try: async () =>
          new Uint8Array(
            await crypto.subtle.sign(
              { name: "ECDSA", hash: "SHA-256" },
              key.privateKey,
              new Uint8Array(signingInput),
            ),
          ),
        catch: keyError,
      }),
  })),
);
