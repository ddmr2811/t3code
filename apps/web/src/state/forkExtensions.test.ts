import { AuthProvidersManageScope } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import {
  forkExtensionsAuthorize,
  forkExtensionsAuthorizeComplete,
  forkExtensionsInspectSource,
  forkExtensionsInstall,
  forkExtensionsSetEnabled,
  forkExtensionsUninstall,
} from "./forkExtensions";

it("guards every write on the client, and lets anyone with read inspect a paste", () => {
  for (const command of [
    forkExtensionsInstall,
    forkExtensionsUninstall,
    forkExtensionsSetEnabled,
    forkExtensionsAuthorize,
    forkExtensionsAuthorizeComplete,
  ]) {
    expect(command.requiredScopes(), command.label).toEqual([AuthProvidersManageScope]);
  }
  expect(forkExtensionsInspectSource.requiredScopes()).toEqual([]);
});
