import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import { AuthProvidersManageScope, EnvironmentAuthorizationError } from "./auth.ts";
import { HostResourcesSnapshot } from "./resourceTelemetry.ts";
import {
  ForkAuthorizeCompleteInput,
  ForkAuthorizeEvent,
  ForkExtensionAgent,
  ForkExtensionsError,
  ForkExtensionsSnapshot,
  ForkHealthEvent,
  ForkInstallRequest,
  ForkInstallResult,
  ForkPastedSource,
  ForkSetEnabledInput,
  ForkUninstallInput,
} from "./forkExtensions.ts";
import { ForkTailnetStatus, ForkTailnetStatusInput } from "./forkTailnet.ts";
import { ForkNodeExportersStatus } from "./forkMachines.ts";
import {
  ForkActivity,
  ForkActivityInput,
  ForkLimitHistory,
  ForkLimitHistoryInput,
} from "./forkInsights.ts";
import { ForkActivityFeed, ForkActivityFeedInput } from "./forkActivity.ts";

/** Fork: every RPC the fork adds, spread into the core's `WS_METHODS` and `WsRpcGroup`. */
export const FORK_WS_METHODS = {
  // Fork: Extensions settings page.
  forkExtensionsSnapshot: "forkExtensions.snapshot",
  forkExtensionsCheckHealth: "forkExtensions.checkHealth",
  forkExtensionsInspectSource: "forkExtensions.inspectSource",
  forkExtensionsInstall: "forkExtensions.install",
  forkExtensionsUninstall: "forkExtensions.uninstall",
  forkExtensionsSetEnabled: "forkExtensions.setEnabled",
  forkExtensionsAuthorize: "forkExtensions.authorize",
  forkExtensionsAuthorizeComplete: "forkExtensions.authorizeComplete",
  // Fork: Dashboard.
  forkTailnetStatus: "forkTailnet.status",
  forkMachinesHostResources: "forkMachines.hostResources",
  forkMachinesNodeExporters: "forkMachines.nodeExporters",
  // Fork: charts under a new thread and on the Dashboard.
  forkInsightsLimitHistory: "forkInsights.limitHistory",
  forkInsightsActivity: "forkInsights.activity",
  // Fork: the Dashboard's "What the AI did".
  forkActivityFeed: "forkActivity.feed",
} as const;

// Fork: Extensions settings page.
const ForkExtensionsRpcError = Schema.Union([ForkExtensionsError, EnvironmentAuthorizationError]);

const WsForkExtensionsSnapshotRpc = Rpc.make(FORK_WS_METHODS.forkExtensionsSnapshot, {
  payload: Schema.Struct({}),
  success: ForkExtensionsSnapshot,
  error: ForkExtensionsRpcError,
});

const WsForkExtensionsCheckHealthRpc = Rpc.make(FORK_WS_METHODS.forkExtensionsCheckHealth, {
  payload: Schema.Struct({}),
  success: ForkHealthEvent,
  error: ForkExtensionsRpcError,
  stream: true,
});

const WsForkExtensionsInspectSourceRpc = Rpc.make(FORK_WS_METHODS.forkExtensionsInspectSource, {
  payload: Schema.Struct({ text: Schema.String }),
  success: ForkPastedSource,
  error: ForkExtensionsRpcError,
});

const WsForkExtensionsInstallRpc = Rpc.make(FORK_WS_METHODS.forkExtensionsInstall, {
  payload: ForkInstallRequest,
  success: Schema.Array(ForkInstallResult),
  error: ForkExtensionsRpcError,
});

const WsForkExtensionsUninstallRpc = Rpc.make(FORK_WS_METHODS.forkExtensionsUninstall, {
  payload: ForkUninstallInput,
  success: Schema.Array(ForkInstallResult),
  error: ForkExtensionsRpcError,
});

const WsForkExtensionsSetEnabledRpc = Rpc.make(FORK_WS_METHODS.forkExtensionsSetEnabled, {
  payload: ForkSetEnabledInput,
  success: ForkInstallResult,
  error: ForkExtensionsRpcError,
});

const WsForkExtensionsAuthorizeRpc = Rpc.make(FORK_WS_METHODS.forkExtensionsAuthorize, {
  payload: Schema.Struct({ itemId: Schema.String, agent: ForkExtensionAgent }),
  success: ForkAuthorizeEvent,
  error: ForkExtensionsRpcError,
  stream: true,
});

const WsForkExtensionsAuthorizeCompleteRpc = Rpc.make(
  FORK_WS_METHODS.forkExtensionsAuthorizeComplete,
  {
    payload: ForkAuthorizeCompleteInput,
    success: Schema.Struct({}),
    error: ForkExtensionsRpcError,
  },
);

// Fork: Dashboard.
const WsForkTailnetStatusRpc = Rpc.make(FORK_WS_METHODS.forkTailnetStatus, {
  payload: ForkTailnetStatusInput,
  success: ForkTailnetStatus,
  error: EnvironmentAuthorizationError,
});

/** A fresh sample of the whole machine about every second, while subscribed. */
const WsForkMachinesHostResourcesRpc = Rpc.make(FORK_WS_METHODS.forkMachinesHostResources, {
  payload: Schema.Struct({}),
  success: HostResourcesSnapshot,
  error: EnvironmentAuthorizationError,
  stream: true,
});

const WsForkMachinesNodeExportersRpc = Rpc.make(FORK_WS_METHODS.forkMachinesNodeExporters, {
  payload: Schema.Struct({}),
  success: ForkNodeExportersStatus,
  error: EnvironmentAuthorizationError,
});

const WsForkInsightsLimitHistoryRpc = Rpc.make(FORK_WS_METHODS.forkInsightsLimitHistory, {
  payload: ForkLimitHistoryInput,
  success: ForkLimitHistory,
  error: EnvironmentAuthorizationError,
});

const WsForkInsightsActivityRpc = Rpc.make(FORK_WS_METHODS.forkInsightsActivity, {
  payload: ForkActivityInput,
  success: ForkActivity,
  error: EnvironmentAuthorizationError,
});

const WsForkActivityFeedRpc = Rpc.make(FORK_WS_METHODS.forkActivityFeed, {
  payload: ForkActivityFeedInput,
  success: ForkActivityFeed,
  error: EnvironmentAuthorizationError,
});

export const FORK_RPCS = [
  WsForkExtensionsSnapshotRpc,
  WsForkExtensionsCheckHealthRpc,
  WsForkExtensionsInspectSourceRpc,
  WsForkExtensionsInstallRpc,
  WsForkExtensionsUninstallRpc,
  WsForkExtensionsSetEnabledRpc,
  WsForkExtensionsAuthorizeRpc,
  WsForkExtensionsAuthorizeCompleteRpc,
  WsForkTailnetStatusRpc,
  WsForkMachinesHostResourcesRpc,
  WsForkMachinesNodeExportersRpc,
  WsForkInsightsLimitHistoryRpc,
  WsForkInsightsActivityRpc,
  WsForkActivityFeedRpc,
] as const;

/** Fork: changing an agent's extensions changes what its provider can run. */
export const FORK_CLIENT_GUARDED_RPC_SCOPES = {
  [FORK_WS_METHODS.forkExtensionsInstall]: AuthProvidersManageScope,
  [FORK_WS_METHODS.forkExtensionsUninstall]: AuthProvidersManageScope,
  [FORK_WS_METHODS.forkExtensionsSetEnabled]: AuthProvidersManageScope,
  [FORK_WS_METHODS.forkExtensionsAuthorize]: AuthProvidersManageScope,
  [FORK_WS_METHODS.forkExtensionsAuthorizeComplete]: AuthProvidersManageScope,
} as const;
