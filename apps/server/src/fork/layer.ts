import * as Layer from "effect/Layer";
import * as ForkActivity from "./activity/ForkActivity.ts";
import * as ForkExtensions from "./extensions/ForkExtensions.ts";
import * as ForkGateway from "./gateway/ForkGateway.ts";
import * as ForkGatewayHttp from "./gateway/http.ts";
import * as ForkInsights from "./insights/ForkInsights.ts";
import * as ForkMachines from "./machines/ForkMachines.ts";
import * as ForkTailnet from "./tailnet/ForkTailnet.ts";

/** Every fork service, one per server; `server.ts` merges this as a single line. */
export const ForkLayer = Layer.mergeAll(
  // Its write queue, health check and logins span every client.
  ForkExtensions.layer,
  // Dashboards on several devices share one Tailscale read.
  ForkTailnet.layer,
  // node_exporter readings and CPU baselines are shared by every client.
  ForkMachines.layer,
  // The limit history has one sampler and one file.
  ForkInsights.layer,
  // Every open activity card shares one cached read.
  ForkActivity.layer,
  // Reads its manifest on each request, so it holds nothing.
  ForkGateway.layer,
);

/** Every fork HTTP route; `server.ts` merges this beside its own routes. */
export const ForkRoutes = ForkGatewayHttp.routeLayer;
