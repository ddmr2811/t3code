// A code step that acts in an outside app as one of the fork's bots, within the bot's card.
import { ForkIntegrationApp } from "@t3tools/contracts";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { checkOptions } from "../../workflows/options.ts";
import { RunContext, step } from "../../workflows/workflow.ts";
import { ask } from "../../workflows/workflowAgent.ts";
import { sortKeys } from "../integrations/ForkIntegrations.ts";
import { slot } from "./ForkWorkflowLink.ts";

/** The exact call a question puts to the user, kept with the step so a yes runs only this. */
const Asked = Schema.Struct({
  botId: Schema.String,
  bot: Schema.String,
  app: ForkIntegrationApp,
  action: Schema.String,
  arguments: Schema.Record(Schema.String, Schema.Json),
});

const Outcome = Schema.Struct({
  status: Schema.Literals(["done", "failed", "denied", "ask", "unknown"]),
  text: Schema.String,
  asked: Schema.optional(Asked),
});

export interface IntegrationResult {
  /** `unknown`: the yes was sent once and its answer was lost, so it is not sent again. */
  readonly status: "done" | "failed" | "denied" | "unknown";
  readonly text: string;
}

const APP_LABELS: Record<ForkIntegrationApp, string> = { github: "GitHub" };

const bare = (handle: string) => handle.replace(/^@/, "").toLowerCase();
const callText = (call: Omit<typeof Asked.Type, "botId">) =>
  JSON.stringify(sortKeys([bare(call.bot), call.app, call.action, call.arguments]));

/**
 * Runs `action` in `app` as bot `bot`. What its card allows runs at once; what it sends to the user
 * becomes a question in the inbox, with these exact arguments, and runs once on a yes. What the
 * card denies, or a no, comes back as `denied`. Never more than the bot itself may do.
 */
export const integration = Effect.fn("workflow.integration")(function* (
  name: string,
  options: {
    readonly bot: string;
    readonly app: ForkIntegrationApp;
    readonly action: string;
    readonly arguments: Readonly<Record<string, Schema.Json>>;
    /** How long the question waits for an answer; a question that times out is a no. */
    readonly timeout?: Duration.Input;
  },
) {
  checkOptions(`integration("${name}")`, options, ["bot", "app", "action", "arguments", "timeout"]);
  const input = { app: options.app, action: options.action, arguments: options.arguments };
  const call = { bot: options.bot, ...input };
  // Read in the body: a step's code sees only the step's own services.
  const fork = yield* slot;
  const run = yield* RunContext;
  const first = yield* step(
    name,
    { returns: Outcome },
    Effect.gen(function* () {
      const { status, text, botId } = yield* (yield* fork)
        .callAsBot({ handle: options.bot }, input, false)
        .pipe(Effect.mapError((error) => error.message));
      return status === "ask" && botId !== undefined
        ? { status, text, asked: { ...call, botId } }
        : { status, text };
    }),
  );
  if (first.status !== "ask" || first.asked === undefined) return first as IntegrationResult;
  const asked = first.asked;
  const answer = yield* ask(`${name}/pregunta`, {
    title: `¿Dejo que @${asked.bot} haga ${asked.action} en ${APP_LABELS[asked.app]}?`,
    choices: [
      { value: "Sí", description: "Una sola vez, con estos argumentos exactos." },
      { value: "No", description: "El flujo sigue sin hacerlo." },
    ],
    data: { bot: asked.bot, app: asked.app, action: asked.action, arguments: asked.arguments },
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
  });
  if (Option.isNone(answer) || answer.value.choice !== "Sí") {
    return { status: "denied", text: "The user said no." } satisfies IntegrationResult;
  }
  // The server stamps the session of an answer given in an app. A signal sent over MCP or the
  // CLI has none: an agent with a terminal, the bot itself included, cannot say yes for the user.
  if (answer.value.answeredBySession === undefined) {
    return {
      status: "denied",
      text: "The yes did not come from the user's app, so nothing ran.",
    } satisfies IntegrationResult;
  }
  // A definition edited while the question waited asks for something the user never saw.
  if (callText(call) !== callText(asked)) {
    return {
      status: "denied",
      text: "The step changed after the question was asked, so nothing ran.",
    } satisfies IntegrationResult;
  }
  // Counted before GitHub is called: a step resumed after a lost answer must not send it again.
  const yes = Effect.gen(function* () {
    const bots = yield* fork;
    if ((yield* run.store.mark(run.runId, `${name}/si/enviado`)) > 1) {
      return {
        status: "unknown",
        text: "The yes was already sent once and its answer was lost; check the app before asking again.",
      } satisfies IntegrationResult;
    }
    const { status, text } = yield* bots
      .callAsBot(
        { id: asked.botId },
        { app: asked.app, action: asked.action, arguments: asked.arguments },
        true,
      )
      .pipe(Effect.mapError((error) => error.message));
    return { status, text };
  });
  // Checked again on the yes: a card lowered to deny since the question still refuses.
  return (yield* step(`${name}/si`, { returns: Outcome }, yes)) as IntegrationResult;
});
