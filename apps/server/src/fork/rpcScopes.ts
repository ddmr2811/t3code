import {
  AuthDiagnosticsReadScope,
  AuthForkGatewayScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  FORK_WS_METHODS,
  WS_METHODS,
} from "@t3tools/contracts";

/** The scope each fork RPC needs; `RpcAuthorization.ts` spreads this into its table. */
export const FORK_RPC_REQUIRED_SCOPES = {
  // Extensions settings page.
  [WS_METHODS.forkExtensionsSnapshot]: AuthOrchestrationReadScope,
  [WS_METHODS.forkExtensionsCheckHealth]: AuthOrchestrationReadScope,
  [WS_METHODS.forkExtensionsInspectSource]: AuthOrchestrationReadScope,
  [WS_METHODS.forkExtensionsInstall]: AuthProvidersManageScope,
  [WS_METHODS.forkExtensionsUninstall]: AuthProvidersManageScope,
  [WS_METHODS.forkExtensionsSetEnabled]: AuthProvidersManageScope,
  [WS_METHODS.forkExtensionsAuthorize]: AuthProvidersManageScope,
  [WS_METHODS.forkExtensionsAuthorizeComplete]: AuthProvidersManageScope,
  // Dashboard. Reads the tailnet's machines, as diagnostics read this one.
  [WS_METHODS.forkTailnetStatus]: AuthDiagnosticsReadScope,
  // The same reading as serverGetHostResources, so the same scope.
  [WS_METHODS.forkMachinesHostResources]: AuthOrchestrationReadScope,
  [WS_METHODS.forkMachinesNodeExporters]: AuthDiagnosticsReadScope,
  // Limits and activity across the machine, as the usage summary reads them.
  [WS_METHODS.forkInsightsLimitHistory]: AuthDiagnosticsReadScope,
  [WS_METHODS.forkInsightsActivity]: AuthDiagnosticsReadScope,
  [WS_METHODS.forkActivityFeed]: AuthDiagnosticsReadScope,
  // Listing the sidecars is for whoever may reach them, and only them.
  [WS_METHODS.forkGatewayList]: AuthForkGatewayScope,
  [WS_METHODS.forkGatewayPanelTicket]: AuthForkGatewayScope,
  // Project coordination board: reading follows threads, writing needs orchestration operate.
  [WS_METHODS.forkCoordinationList]: AuthOrchestrationReadScope,
  [WS_METHODS.forkCoordinationUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.forkCoordinationRemove]: AuthOrchestrationOperateScope,
  // Quota model failover: reading follows threads, config needs providers manage, manual switch needs operate.
  [WS_METHODS.forkFailoverGetState]: AuthOrchestrationReadScope,
  [WS_METHODS.forkFailoverSetConfig]: AuthProvidersManageScope,
  [WS_METHODS.forkFailoverSwitchThread]: AuthOrchestrationOperateScope,
} as const;

type ForkRpcMethod = (typeof FORK_WS_METHODS)[keyof typeof FORK_WS_METHODS];

/** Every fork RPC counts under one metric group; `RpcInstrumentation.ts` spreads this. */
export const FORK_RPC_METRIC_GROUPS = Object.fromEntries(
  Object.values(FORK_WS_METHODS).map((method) => [method, "fork"]),
) as Record<ForkRpcMethod, "fork">;
