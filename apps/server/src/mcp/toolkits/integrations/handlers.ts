import { type ForkIntegrationsError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ForkIntegrations from "../../../fork/integrations/ForkIntegrations.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller } from "../../threadAccess.ts";
import { IntegrationsToolkit } from "./tools.ts";

const toFailure = (error: ForkIntegrationsError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "permissionDenied"
        ? "capability_denied"
        : error.reason === "storageFailed" || error.reason === "unavailable"
          ? "orchestration_error"
          : "invalid_request",
    message: error.message,
  });

/** The calling thread; the service decides which bot it is and what that bot may do. */
const callerThread = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, "Integrations")),
  Effect.map((scope) => scope.thread.threadId),
);

// Not `writesOutside`: that refuses every caller that needs approval, and here each call is
// checked against the bot's own permissions and goes to the user's inbox when it must.
export const layer = McpToolAccess.toLayer(IntegrationsToolkit, {
  integration_search: McpToolAccess.readsAsCaller(({ query }) =>
    Effect.gen(function* () {
      const integrations = yield* ForkIntegrations.ForkIntegrations;
      const actions = yield* integrations
        .search(yield* callerThread, query)
        .pipe(Effect.mapError(toFailure));
      return {
        actions: actions.map(({ app, action, needsApproval, description, parameters }) => ({
          app,
          action,
          needsApproval,
          description,
          parameters,
        })),
      };
    }),
  ),
  integration_call: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const integrations = yield* ForkIntegrations.ForkIntegrations;
      // The thread's modes as they are now, which a client or a policy ceiling may have lowered.
      const { limits } = yield* loadCaller();
      return yield* integrations
        .call(yield* callerThread, limits, input)
        .pipe(Effect.mapError(toFailure));
    }),
  ),
});
