// An agent step that names a `bot` runs in that bot's thread; every other step is upstream's.
import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { WorkflowAgentError, WorkflowAgents } from "../../workflows/WorkflowAgents.ts";
import { hooks } from "./ForkWorkflowLink.ts";

const refused = (reason: string) => new WorkflowAgentError({ reason });

export const layer = Layer.effect(
  WorkflowAgents,
  Effect.gen(function* () {
    const base = yield* WorkflowAgents;
    const digest = yield* Digest.Digest;
    return WorkflowAgents.of({
      ...base,
      start: Effect.fn("ForkWorkflowAgents.start")(function* (input) {
        const link = yield* Effect.option(hooks);
        if (input.bot === undefined) {
          // Continuing a bot's thread by its id would skip the bot's queue and its ceiling, and
          // one the bot has left keeps the modes the bot had there.
          if (
            input.thread !== undefined &&
            Option.isSome(link) &&
            (yield* link.value.wasBotThread(ThreadId.make(input.thread)))
          ) {
            return yield* refused(
              `Thread ${input.thread} is a bot's. Name the bot with \`bot\` instead of continuing its thread.`,
            );
          }
          return yield* base.start(input);
        }
        if (Option.isNone(link))
          return yield* refused("Bots are not available to workflows on this server.");
        const fork = link.value;
        const hash = yield* digest
          .digest(Digest.sha256, new TextEncoder().encode(input.key))
          .pipe(Effect.mapError(() => refused("Could not derive the turn's id.")));
        const id = `workflow-bot:${Hex.encode(hash)}`;
        const turn = yield* fork
          .workflowTurn({
            handle: input.bot,
            commandId: CommandId.make(id),
            messageId: MessageId.make(id),
            text: input.prompt,
            outputSchema: input.outputSchema,
          })
          .pipe(Effect.mapError((error) => refused(`@${input.bot}: ${error.message}`)));
        return { threadId: turn.threadId, turnId: turn.turnId };
      }),
    });
  }),
);
