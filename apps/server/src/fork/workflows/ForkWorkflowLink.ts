// The workflow engine sits below the fork's services in the server's layers, so it reaches the
// bots through this slot, filled once both are up (as upstream's EngineLink does for the engine).
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import * as ForkBots from "../bots/ForkBots.ts";
import * as ForkIntegrations from "../integrations/ForkIntegrations.ts";

export interface ForkWorkflowHooks {
  readonly workflowTurn: ForkBots.ForkBots["Service"]["workflowTurn"];
  readonly wasBotThread: ForkBots.ForkBots["Service"]["wasBotThread"];
  readonly callAsBot: ForkIntegrations.ForkIntegrations["Service"]["callAsBot"];
}

export class ForkWorkflowLink extends Context.Service<
  ForkWorkflowLink,
  {
    current: ForkWorkflowHooks | undefined;
    /** Set by the workflow runtime, which runs its engine only while `current` is. */
    engine?: (forkUp: boolean) => Effect.Effect<void>;
  }
>()("t3/fork/workflows/ForkWorkflowLink") {}

/** One slot per server: layers memoize by reference, so the engine and the fork share it. */
export const layer = Layer.sync(ForkWorkflowLink, () => ({ current: undefined }));

/**
 * Fills the slot with `hooks` for the scope, starting the engine after and stopping it before:
 * the engine starts before the fork's services and stops after them, and no step may run without.
 */
export const attach = (link: ForkWorkflowLink["Service"], hooks: ForkWorkflowHooks) =>
  Effect.acquireRelease(
    Effect.suspend(() => {
      link.current = hooks;
      return link.engine?.(true) ?? Effect.void;
    }),
    () =>
      // A later attach owns the slot now; this one leaves it and the engine alone.
      link.current !== hooks
        ? Effect.void
        : (link.engine?.(false) ?? Effect.void).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (link.current === hooks) link.current = undefined;
              }),
            ),
          ),
  );

/** Fills the slot while the fork's services are up. */
export const layerFill = Layer.effectDiscard(
  Effect.gen(function* () {
    const bots = yield* ForkBots.ForkBots;
    const integrations = yield* ForkIntegrations.ForkIntegrations;
    yield* attach(yield* ForkWorkflowLink, {
      workflowTurn: bots.workflowTurn,
      wasBotThread: bots.wasBotThread,
      callAsBot: integrations.callAsBot,
    });
  }),
).pipe(Layer.provide(layer));

/**
 * The workflow runtime's `turn`, run only while the fork is attached where the server has a fork.
 * The runtime still asks for what settings say; `attach` turns it on and off around the fork.
 */
export const gateTurn = Effect.fn("ForkWorkflowLink.gateTurn")(function* <E>(
  turn: (on: boolean) => Effect.Effect<void, E>,
) {
  const found = yield* Effect.serviceOption(ForkWorkflowLink);
  if (Option.isNone(found)) return turn;
  const link = found.value;
  let enabled = false;
  let forkUp = link.current !== undefined;
  // Each turn reads both flags once it is its go, so none applies a state already gone.
  const lock = yield* Semaphore.make(1);
  const apply = lock.withPermits(1)(Effect.suspend(() => turn(enabled && forkUp)));
  link.engine = (up) =>
    Effect.suspend(() => {
      forkUp = up;
      return Effect.ignore(apply);
    });
  return (on: boolean) =>
    Effect.suspend(() => {
      enabled = on;
      return apply;
    });
});

/**
 * The fork's hooks as a step reads them when it runs, or why it cannot (a server without the fork,
 * or a test's engine without `attach`).
 */
export const slot = Effect.map(Effect.serviceOption(ForkWorkflowLink), (link) =>
  Effect.suspend(() =>
    Option.isSome(link) && link.value.current !== undefined
      ? Effect.succeed(link.value.current)
      : Effect.fail("Bots are not available to workflows on this server right now."),
  ),
);

export const hooks = Effect.flatten(slot);
