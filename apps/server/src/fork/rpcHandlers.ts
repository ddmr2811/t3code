import { FORK_RPCS, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as ForkActivity from "./activity/ForkActivity.ts";
import * as ForkExtensions from "./extensions/ForkExtensions.ts";
import * as ForkInsights from "./insights/ForkInsights.ts";
import * as ForkMachines from "./machines/ForkMachines.ts";
import * as ForkTailnet from "./tailnet/ForkTailnet.ts";

const ForkRpcGroup = RpcGroup.make(...FORK_RPCS);

/** The fork's WebSocket handlers; `ws.ts` spreads them into its own. */
export const forkRpcHandlers = Effect.gen(function* () {
  const forkExtensions = yield* ForkExtensions.ForkExtensions;
  const forkTailnet = yield* ForkTailnet.ForkTailnet;
  const forkMachines = yield* ForkMachines.ForkMachines;
  const forkInsights = yield* ForkInsights.ForkInsights;
  const forkActivity = yield* ForkActivity.ForkActivity;
  return ForkRpcGroup.of({
    // Extensions settings page.
    [WS_METHODS.forkExtensionsSnapshot]: () => forkExtensions.snapshot,
    [WS_METHODS.forkExtensionsCheckHealth]: () => forkExtensions.checkHealth,
    [WS_METHODS.forkExtensionsInspectSource]: (input) => forkExtensions.inspectSource(input.text),
    [WS_METHODS.forkExtensionsInstall]: (input) => forkExtensions.install(input),
    [WS_METHODS.forkExtensionsUninstall]: (input) => forkExtensions.uninstall(input),
    [WS_METHODS.forkExtensionsSetEnabled]: (input) => forkExtensions.setEnabled(input),
    [WS_METHODS.forkExtensionsAuthorize]: (input) => forkExtensions.authorize(input),
    [WS_METHODS.forkExtensionsAuthorizeComplete]: (input) =>
      forkExtensions.authorizeComplete(input).pipe(Effect.as({})),
    // Dashboard.
    [WS_METHODS.forkTailnetStatus]: (input) => forkTailnet.status(input),
    [WS_METHODS.forkMachinesHostResources]: (_input) => forkMachines.hostResources,
    [WS_METHODS.forkMachinesNodeExporters]: (_input) => forkMachines.nodeExporters,
    [WS_METHODS.forkInsightsLimitHistory]: (input) => forkInsights.limitHistory(input),
    [WS_METHODS.forkInsightsActivity]: (input) => forkInsights.activity(input),
    [WS_METHODS.forkActivityFeed]: (input) => forkActivity.feed(input),
  });
});
