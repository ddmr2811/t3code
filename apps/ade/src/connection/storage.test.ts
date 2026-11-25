import {
  BearerConnectionProfile,
  BearerConnectionRegistration,
  BearerConnectionTarget,
  DpopConnectionCredential,
} from "@t3tools/client-runtime/connection";
import {
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  registerConnectionInCatalog,
  removeConnectionFromCatalog,
} from "@t3tools/client-runtime/platform";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  putCredentialInCatalog,
  registerOverPairing,
  removePairing,
  setRoutesOfPairing,
  storedPairing,
} from "./storage.ts";

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

describe("a tab on an older pairing", () => {
  const environmentId = EnvironmentId.make("machine");
  const registration = (connectionId: string) => {
    const route = { connectionId, environmentId, label: "Machine" };
    return new BearerConnectionRegistration({
      target: new BearerConnectionTarget(route),
      profile: new BearerConnectionProfile({
        ...route,
        httpBaseUrl: "http://localhost:3773/",
        wsBaseUrl: "ws://localhost:3773/",
      }),
      credential: credential(connectionId),
    });
  };
  const pairedAs = (connectionId: string) =>
    registerConnectionInCatalog(EMPTY_CONNECTION_CATALOG_DOCUMENT, registration(connectionId));
  const first = pairedAs("first");
  const tabPairing = storedPairing(first, environmentId);

  it("writes the routes of a pairing that is still the stored one", () => {
    expect(setRoutesOfPairing(first, environmentId, first.targets, tabPairing)).toEqual(first);
  });

  it("does not store again a route of an earlier pairing the registry is still dropping", () => {
    const second = pairedAs("second");
    const leftOver = new BearerConnectionTarget({
      connectionId: "first",
      environmentId,
      label: "M",
    });
    expect(
      setRoutesOfPairing(
        second,
        environmentId,
        [...second.targets, leftOver],
        storedPairing(second, environmentId),
      ),
    ).toEqual(second);
  });

  it.each([
    ["removed", removeConnectionFromCatalog(first, environmentId)],
    ["paired again", pairedAs("second")],
  ])("does not bring its routes back once the machine was %s", (_name, storedNow) => {
    expect(() => setRoutesOfPairing(storedNow, environmentId, first.targets, tabPairing)).toThrow();
    // Nor does widening the pairing it started from store a new one over the current state.
    expect(() => registerOverPairing(storedNow, registration("widened"), tabPairing)).toThrow();
  });

  it("widens the pairing that is still the stored one", () => {
    const widened = registerOverPairing(first, registration("widened"), tabPairing);
    expect(storedPairing(widened, environmentId)).toBe("widened");
  });

  it("removes nothing of the pairing that replaced its own", () => {
    const second = pairedAs("second");
    expect(removePairing(second, environmentId, tabPairing)).toBe(second);
    expect(removePairing(first, environmentId, tabPairing).targets).toEqual([]);
  });
});
