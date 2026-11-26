// A code step that acts in an outside app as one of the fork's bots, within the bot's card.
import type { ForkIntegrationApp } from "@t3tools/contracts";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { checkOptions } from "../../workflows/options.ts";
import { step } from "../../workflows/workflow.ts";
import { ask } from "../../workflows/workflowAgent.ts";
import { hooks } from "./ForkWorkflowLink.ts";

const Outcome = Schema.Struct({
  status: Schema.Literals(["done", "failed", "denied", "ask"]),
  text: Schema.String,
});

export interface IntegrationResult {
  readonly status: "done" | "failed" | "denied";
  readonly text: string;
}

const APP_LABELS: Record<ForkIntegrationApp, string> = { github: "GitHub" };

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
  // Read in the body: a step's code sees only the step's own services.
  const fork = yield* Effect.orDie(hooks);
  const callAs = (approved: boolean) =>
    fork.callAsBot(options.bot, input, approved).pipe(Effect.mapError((error) => error.message));
  const first = yield* step(name, { returns: Outcome }, callAs(false));
  if (first.status !== "ask") return first as IntegrationResult;
  const app = APP_LABELS[options.app];
  const answer = yield* ask(`${name}/pregunta`, {
    title: `¿Dejo que @${options.bot} haga ${options.action} en ${app}?`,
    choices: [
      { value: "Sí", description: "Una sola vez, con estos argumentos exactos." },
      { value: "No", description: "El flujo sigue sin hacerlo." },
    ],
    data: {
      body: `Argumentos exactos: ${first.text}`,
      bot: options.bot,
      app: options.app,
      action: options.action,
      arguments: options.arguments,
    },
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
  // Checked again on the yes: a card lowered to deny since the question still refuses.
  return (yield* step(`${name}/si`, { returns: Outcome }, callAs(true))) as IntegrationResult;
});
