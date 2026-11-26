// The workflow engine sits below the fork's services in the server's layers, so it reaches the
// bots through this slot, filled once both are up (as upstream's EngineLink does for the engine).
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ForkBots from "../bots/ForkBots.ts";
import * as ForkIntegrations from "../integrations/ForkIntegrations.ts";

export interface ForkWorkflowHooks {
  readonly workflowTurn: ForkBots.ForkBots["Service"]["workflowTurn"];
  readonly wasBotThread: ForkBots.ForkBots["Service"]["wasBotThread"];
  readonly callAsBot: ForkIntegrations.ForkIntegrations["Service"]["callAsBot"];
}

export class ForkWorkflowLink extends Context.Service<
  ForkWorkflowLink,
  { current: ForkWorkflowHooks | undefined }
>()("t3/fork/workflows/ForkWorkflowLink") {}

/** One slot per server: layers memoize by reference, so the engine and the fork share it. */
export const layer = Layer.sync(ForkWorkflowLink, () => ({ current: undefined }));

/** Fills the slot while the fork's services are up. */
export const layerFill = Layer.effectDiscard(
  Effect.gen(function* () {
    const link = yield* ForkWorkflowLink;
    const bots = yield* ForkBots.ForkBots;
    const integrations = yield* ForkIntegrations.ForkIntegrations;
    link.current = {
      workflowTurn: bots.workflowTurn,
      wasBotThread: bots.wasBotThread,
      callAsBot: integrations.callAsBot,
    };
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        link.current = undefined;
      }),
    );
  }),
).pipe(Layer.provide(layer));

/** The fork's hooks, or why a bot step cannot run here. */
export const hooks = Effect.flatMap(Effect.serviceOption(ForkWorkflowLink), (link) =>
  Option.isSome(link) && link.value.current !== undefined
    ? Effect.succeed(link.value.current)
    : Effect.fail("Bots are not available to workflows on this server."),
);
