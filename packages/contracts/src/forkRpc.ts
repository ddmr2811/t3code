import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import {
  AuthOrchestrationOperateScope,
  AuthProvidersManageScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { HostResourcesSnapshot } from "./resourceTelemetry.ts";
import {
  ForkCoordinationEntry,
  ForkCoordinationError,
  ForkCoordinationListInput,
  ForkCoordinationListResult,
  ForkCoordinationRemoveInput,
  ForkCoordinationRemoveResult,
  ForkCoordinationUpsertInput,
} from "./forkCoordination.ts";
import {
  ForkFailoverConfig,
  ForkFailoverError,
  ForkFailoverGetStateInput,
  ForkFailoverSetConfigInput,
  ForkFailoverState,
  ForkFailoverSwitchThreadInput,
  ForkFailoverSwitchThreadResult,
} from "./forkFailover.ts";
import {
  ForkBot,
  ForkBotListInput,
  ForkBotListResult,
  ForkBotRemoveInput,
  ForkBotRemoveResult,
  ForkBotSendMessageInput,
  ForkBotSendMessageResult,
  ForkBotSetArchivedInput,
  ForkBotsError,
  ForkBotUpsertInput,
} from "./forkBots.ts";
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
import {
  ForkMemoryError,
  ForkMemoryListInput,
  ForkMemoryListResult,
  ForkMemoryNote,
  ForkMemoryRemoveInput,
  ForkMemoryRemoveResult,
  ForkMemoryUpsertInput,
} from "./forkMemory.ts";
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
  // Fork: the sidecars declared in the extension gateway's manifest.
  forkGatewayList: "forkGateway.list",
  forkGatewayPanelTicket: "forkGateway.panelTicket",
  // Fork: project coordination board shared across machines.
  forkCoordinationList: "forkCoordination.list",
  forkCoordinationUpsert: "forkCoordination.upsert",
  forkCoordinationRemove: "forkCoordination.remove",
  // Fork: automatic/manual quota model failover per machine.
  forkFailoverGetState: "forkFailover.getState",
  forkFailoverSetConfig: "forkFailover.setConfig",
  forkFailoverSwitchThread: "forkFailover.switchThread",
  // Fork: persistent named bots and their front-layer chat.
  forkBotsList: "forkBots.list",
  forkBotsUpsert: "forkBots.upsert",
  forkBotsSetArchived: "forkBots.setArchived",
  forkBotsRemove: "forkBots.remove",
  forkBotsSendMessage: "forkBots.sendMessage",
  // Fork: per-project memory the coordinator reads and the user curates.
  forkMemoryList: "forkMemory.list",
  forkMemoryUpsert: "forkMemory.upsert",
  forkMemoryRemove: "forkMemory.remove",
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

/** A sidecar as clients see it: never its port, which only the gateway needs. */
export const ForkGatewayExtension = Schema.Struct({
  id: Schema.String,
  title: Schema.optionalKey(Schema.String),
  /** Where its panel lives below `/api/fork/ext/<id>`; absent when it has none. */
  panelPath: Schema.optionalKey(Schema.String),
});
export type ForkGatewayExtension = typeof ForkGatewayExtension.Type;

export const ForkGatewayList = Schema.Struct({
  extensions: Schema.Array(ForkGatewayExtension),
  /** Why the manifest was refused; it then lists nothing. */
  problem: Schema.optionalKey(Schema.String),
});
export type ForkGatewayList = typeof ForkGatewayList.Type;

const WsForkGatewayListRpc = Rpc.make(FORK_WS_METHODS.forkGatewayList, {
  payload: Schema.Struct({}),
  success: ForkGatewayList,
  error: EnvironmentAuthorizationError,
});

/**
 * The audience of a ticket for one extension's panel. Every other route that takes tickets wants
 * its own audience, so this one opens nothing else, and the gateway takes it only for `<id>`.
 */
export const ForkGatewayTicketAudience = Schema.TemplateLiteral(["fork-gateway:", Schema.String]);
export type ForkGatewayTicketAudience = typeof ForkGatewayTicketAudience.Type;

const WsForkGatewayPanelTicketRpc = Rpc.make(FORK_WS_METHODS.forkGatewayPanelTicket, {
  payload: Schema.Struct({ id: Schema.String }),
  success: Schema.Struct({ ticket: Schema.String }),
  error: EnvironmentAuthorizationError,
});

// Fork: project coordination board.
const ForkCoordinationRpcError = Schema.Union([
  ForkCoordinationError,
  EnvironmentAuthorizationError,
]);

const WsForkCoordinationListRpc = Rpc.make(FORK_WS_METHODS.forkCoordinationList, {
  payload: ForkCoordinationListInput,
  success: ForkCoordinationListResult,
  error: ForkCoordinationRpcError,
});

const WsForkCoordinationUpsertRpc = Rpc.make(FORK_WS_METHODS.forkCoordinationUpsert, {
  payload: ForkCoordinationUpsertInput,
  success: ForkCoordinationEntry,
  error: ForkCoordinationRpcError,
});

const WsForkCoordinationRemoveRpc = Rpc.make(FORK_WS_METHODS.forkCoordinationRemove, {
  payload: ForkCoordinationRemoveInput,
  success: ForkCoordinationRemoveResult,
  error: ForkCoordinationRpcError,
});

// Fork: quota model failover.
const ForkFailoverRpcError = Schema.Union([ForkFailoverError, EnvironmentAuthorizationError]);

const WsForkFailoverGetStateRpc = Rpc.make(FORK_WS_METHODS.forkFailoverGetState, {
  payload: ForkFailoverGetStateInput,
  success: ForkFailoverState,
  error: ForkFailoverRpcError,
});

const WsForkFailoverSetConfigRpc = Rpc.make(FORK_WS_METHODS.forkFailoverSetConfig, {
  payload: ForkFailoverSetConfigInput,
  success: ForkFailoverConfig,
  error: ForkFailoverRpcError,
});

const WsForkFailoverSwitchThreadRpc = Rpc.make(FORK_WS_METHODS.forkFailoverSwitchThread, {
  payload: ForkFailoverSwitchThreadInput,
  success: ForkFailoverSwitchThreadResult,
  error: ForkFailoverRpcError,
});

// Fork: persistent bot directory.
const ForkBotsRpcError = Schema.Union([ForkBotsError, EnvironmentAuthorizationError]);

const WsForkBotsListRpc = Rpc.make(FORK_WS_METHODS.forkBotsList, {
  payload: ForkBotListInput,
  success: ForkBotListResult,
  error: ForkBotsRpcError,
});

const WsForkBotsUpsertRpc = Rpc.make(FORK_WS_METHODS.forkBotsUpsert, {
  payload: ForkBotUpsertInput,
  success: ForkBot,
  error: ForkBotsRpcError,
});

const WsForkBotsSetArchivedRpc = Rpc.make(FORK_WS_METHODS.forkBotsSetArchived, {
  payload: ForkBotSetArchivedInput,
  success: ForkBot,
  error: ForkBotsRpcError,
});

const WsForkBotsRemoveRpc = Rpc.make(FORK_WS_METHODS.forkBotsRemove, {
  payload: ForkBotRemoveInput,
  success: ForkBotRemoveResult,
  error: ForkBotsRpcError,
});

const WsForkBotsSendMessageRpc = Rpc.make(FORK_WS_METHODS.forkBotsSendMessage, {
  payload: ForkBotSendMessageInput,
  success: ForkBotSendMessageResult,
  error: ForkBotsRpcError,
});

// Fork: per-project memory.
const ForkMemoryRpcError = Schema.Union([ForkMemoryError, EnvironmentAuthorizationError]);

const WsForkMemoryListRpc = Rpc.make(FORK_WS_METHODS.forkMemoryList, {
  payload: ForkMemoryListInput,
  success: ForkMemoryListResult,
  error: ForkMemoryRpcError,
});

const WsForkMemoryUpsertRpc = Rpc.make(FORK_WS_METHODS.forkMemoryUpsert, {
  payload: ForkMemoryUpsertInput,
  success: ForkMemoryNote,
  error: ForkMemoryRpcError,
});

const WsForkMemoryRemoveRpc = Rpc.make(FORK_WS_METHODS.forkMemoryRemove, {
  payload: ForkMemoryRemoveInput,
  success: ForkMemoryRemoveResult,
  error: ForkMemoryRpcError,
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
  WsForkGatewayListRpc,
  WsForkGatewayPanelTicketRpc,
  WsForkCoordinationListRpc,
  WsForkCoordinationUpsertRpc,
  WsForkCoordinationRemoveRpc,
  WsForkFailoverGetStateRpc,
  WsForkFailoverSetConfigRpc,
  WsForkFailoverSwitchThreadRpc,
  WsForkBotsListRpc,
  WsForkBotsUpsertRpc,
  WsForkBotsSetArchivedRpc,
  WsForkBotsRemoveRpc,
  WsForkBotsSendMessageRpc,
  WsForkMemoryListRpc,
  WsForkMemoryUpsertRpc,
  WsForkMemoryRemoveRpc,
] as const;

/** Fork: changing an agent's extensions changes what its provider can run. */
export const FORK_CLIENT_GUARDED_RPC_SCOPES = {
  [FORK_WS_METHODS.forkExtensionsInstall]: AuthProvidersManageScope,
  [FORK_WS_METHODS.forkExtensionsUninstall]: AuthProvidersManageScope,
  [FORK_WS_METHODS.forkExtensionsSetEnabled]: AuthProvidersManageScope,
  [FORK_WS_METHODS.forkExtensionsAuthorize]: AuthProvidersManageScope,
  [FORK_WS_METHODS.forkExtensionsAuthorizeComplete]: AuthProvidersManageScope,
  [FORK_WS_METHODS.forkCoordinationUpsert]: AuthOrchestrationOperateScope,
  [FORK_WS_METHODS.forkCoordinationRemove]: AuthOrchestrationOperateScope,
  [FORK_WS_METHODS.forkFailoverSetConfig]: AuthProvidersManageScope,
  [FORK_WS_METHODS.forkFailoverSwitchThread]: AuthOrchestrationOperateScope,
  [FORK_WS_METHODS.forkBotsUpsert]: AuthOrchestrationOperateScope,
  [FORK_WS_METHODS.forkBotsSetArchived]: AuthOrchestrationOperateScope,
  [FORK_WS_METHODS.forkBotsRemove]: AuthOrchestrationOperateScope,
  [FORK_WS_METHODS.forkBotsSendMessage]: AuthOrchestrationOperateScope,
  [FORK_WS_METHODS.forkMemoryUpsert]: AuthOrchestrationOperateScope,
  [FORK_WS_METHODS.forkMemoryRemove]: AuthOrchestrationOperateScope,
} as const;
