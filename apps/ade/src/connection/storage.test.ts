import { DpopConnectionCredential } from "@t3tools/client-runtime/connection";
import { EMPTY_CONNECTION_CATALOG_DOCUMENT } from "@t3tools/client-runtime/platform";
import { describe, expect, it } from "vite-plus/test";

import { putCredentialInCatalog } from "./storage.ts";

const credential = (accessToken: string) =>
  new DpopConnectionCredential({ accessToken, expiresAtEpochMs: 1 });
const holding = (accessToken: string) =>
  putCredentialInCatalog(EMPTY_CONNECTION_CATALOG_DOCUMENT, "machine", credential(accessToken));
const stored = (document: typeof EMPTY_CONNECTION_CATALOG_DOCUMENT) =>
  document.credentials.map((entry) => entry.credential);

describe("putCredentialInCatalog", () => {
  it("stores the renewal of the credential that is still the stored one", () => {
    const renewed = putCredentialInCatalog(
      holding("first"),
      "machine",
      credential("first-renewed"),
      // Read in an earlier transaction: another instance with the same token.
      credential("first"),
    );
    expect(stored(renewed)).toEqual([credential("first-renewed")]);
  });

  it("drops the renewal of a session the machine was paired again over", () => {
    const renewed = putCredentialInCatalog(
      holding("second"),
      "machine",
      credential("first-renewed"),
      credential("first"),
    );
    expect(stored(renewed)).toEqual([credential("second")]);
  });

  it("drops the renewal of a machine that was removed meanwhile", () => {
    const renewed = putCredentialInCatalog(
      EMPTY_CONNECTION_CATALOG_DOCUMENT,
      "machine",
      credential("first-renewed"),
      credential("first"),
    );
    expect(stored(renewed)).toEqual([]);
  });
});
