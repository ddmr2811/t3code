// @effect-diagnostics globalJsonInEffect:off - the cases compare small literals.
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { Case, World } from "./grade.ts";

const defined = (world: World, name: string) =>
  world.definitions.find((definition) => definition.name === name);
const missing = (name: string) => [`No workflow named ${name} is defined.`];

const todos = [
  { file: "src/a.ts", line: 3, text: "handle the empty list" },
  { file: "src/b.ts", line: 9, text: "remove after the migration" },
];

const SUCCEEDED = JSON.stringify({ status: "succeeded", service: "billing" });
const FAILED = JSON.stringify({ status: "failed", service: "checkout-api" });

const openIssues = JSON.stringify([
  { number: 12, title: "Crash on save" },
  { number: 15, title: "Typo in the docs" },
]);

export const cases: ReadonlyArray<Case> = [
  {
    id: "bot-triage-asks-before-commenting",
    source:
      "Fork F4 (26-11-2026): GitHub issue triage done by a bot, its writes through the bot's card and the inbox.",
    task: [
      "Write a workflow named `issue-triage` that runs every day at 08:00.",
      "It reads the open issues of the GitHub repository acme/app as the bot `triaje`.",
      "The bot `triaje` classifies them, without changing anything, as data shaped `{ issues: [{ number: number, comment: string }] }`.",
      "Then, for each issue, the bot `triaje` comments the text it proposed on that issue on GitHub. Nothing is commented without the user's yes.",
    ].join("\n"),
    scenarios: [
      {
        name: "classifies and comments as the bot",
        read: () => openIssues,
        agent: () => ({
          output: {
            issues: [
              { number: 12, comment: "Bug: needs a repro." },
              { number: 15, comment: "Docs: good first issue." },
            ],
          },
        }),
        check: (world) =>
          world.server(
            Effect.fn(function* (workflows) {
              if (defined(world, "issue-triage") === undefined) return missing("issue-triage");
              const problems: Array<string> = [];
              const { runId } = yield* workflows.start(
                "issue-triage",
                { scheduledAt: "2026-01-05T08:00:00.000Z" },
                { idempotencyKey: "a" },
              );
              // Each of the two comments waits for a yes in the inbox.
              for (let answered = 0; answered < 2; answered++) {
                const question = yield* world.asks(workflows, runId);
                if (Option.isNone(question)) break;
                yield* workflows.answer(
                  runId,
                  question.value,
                  { choice: "Sí" },
                  { label: "ADE", sessionId: "session-1" },
                );
              }
              const ended = yield* world.reaches(
                workflows,
                runId,
                "completed",
                "paused",
                "stopped",
              );
              if (Option.isNone(ended) || ended.value.status !== "completed") {
                problems.push(
                  `The run did not complete: ${Option.getOrUndefined(ended)?.detail ?? "never ended"}`,
                );
              }
              const bots = world.turns.map((turn) => turn.bot);
              if (bots.length === 0 || bots.some((bot) => bot !== "triaje")) {
                problems.push(
                  `Its agent turns did not all go to the bot triaje: ${JSON.stringify(bots)}.`,
                );
              }
              if (world.turns.some((turn) => turn.project !== undefined)) {
                problems.push("It gave a bot step a project as well.");
              }
              const read = world.integrations.find(
                (call) => /issue/.test(call.action) && /^(list|search)_/.test(call.action),
              );
              if (read === undefined) problems.push("It did not read the issues as the bot.");
              const commented = world.integrations
                .filter((call) => call.approved && call.action === "add_issue_comment")
                .map((call) => call.arguments.issue_number)
                .toSorted();
              if (JSON.stringify(commented) !== "[12,15]") {
                problems.push(
                  `It commented on ${JSON.stringify(commented)} as the bot, not on 12 and 15.`,
                );
              }
              if (world.integrations.some((call) => call.bot.replace(/^@/, "") !== "triaje")) {
                problems.push("It acted in GitHub as someone other than triaje.");
              }
              return problems;
            }),
          ),
      },
    ],
  },
  {
    id: "scheduled-agent-then-approval",
    source:
      "The dependency report in the skill: a schedule, typed agent data, a question, a continued thread.",
    task: [
      "Write a workflow named `todo-sweep` that runs every weekday (Monday to Friday) at 09:00.",
      "An agent in the project with id `proj-1` lists the TODO comments in the repository as data shaped `{ todos: [{ file: string, line: number, text: string }] }`, without changing files.",
      "If there are none, the run ends there; that is not a failure.",
      "Otherwise a person is asked whether to fix them, with the choices `fix` and `skip`, and the run waits at most one day for the answer.",
      "On `fix`, the same agent thread fixes them. On `skip` or no answer, the run ends.",
    ].join("\n"),
    scenarios: [
      {
        name: "nothing to do",
        agent: () => ({ output: { todos: [] } }),
        check: (world) =>
          world.server(
            Effect.fn(function* (workflows) {
              const definition = defined(world, "todo-sweep");
              if (definition === undefined) return missing("todo-sweep");
              const problems: Array<string> = [];
              const schedule = definition.triggers.flatMap((trigger) =>
                trigger.kind === "schedule" && trigger.schedule.type === "fixed_time"
                  ? [trigger.schedule]
                  : [],
              )[0];
              if (schedule === undefined) {
                problems.push("It has no time-of-day trigger.");
              } else {
                if (!/^0?9:00$/.test(schedule.timeOfDay)) {
                  problems.push(`It runs at ${schedule.timeOfDay}, not 09:00.`);
                }
                if ([...(schedule.weekdays ?? [])].toSorted().join() !== "1,2,3,4,5") {
                  problems.push("It does not run on exactly Monday to Friday.");
                }
              }
              const { runId } = yield* workflows.start(
                "todo-sweep",
                { scheduledAt: "2026-01-05T09:00:00.000Z" },
                { idempotencyKey: "a" },
              );
              const ended = yield* world.reaches(
                workflows,
                runId,
                "stopped",
                "completed",
                "paused",
              );
              if (Option.isNone(ended)) return [...problems, "The run never ended."];
              if (ended.value.status === "paused") {
                problems.push(`The run paused: ${ended.value.detail}`);
              }
              if (world.turns.length !== 1) {
                problems.push(`It asked for ${world.turns.length} agent turns, not 1.`);
              }
              if (world.turns[0]?.project !== "proj-1") {
                problems.push("The agent did not start in proj-1.");
              }
              if ((yield* workflows.questions).length > 0) {
                problems.push("It asked a person although there was nothing to fix.");
              }
              return problems;
            }),
          ),
      },
      {
        name: "approved",
        agent: (turn) =>
          turn.outputSchema === undefined ? { reply: "Fixed." } : { output: { todos } },
        check: (world) =>
          world.server(
            Effect.fn(function* (workflows) {
              if (defined(world, "todo-sweep") === undefined) return missing("todo-sweep");
              const { runId } = yield* workflows.start(
                "todo-sweep",
                { scheduledAt: "2026-01-05T09:00:00.000Z" },
                { idempotencyKey: "b" },
              );
              const question = yield* world.asks(workflows, runId);
              if (Option.isNone(question)) return ["It did not ask a person whether to fix them."];
              yield* workflows.signal(
                { runId, wait: question.value },
                { choice: "fix" },
                { id: "answer-1" },
              );
              const ended = yield* world.reaches(
                workflows,
                runId,
                "completed",
                "paused",
                "stopped",
              );
              if (Option.isNone(ended) || ended.value.status !== "completed") {
                return [
                  `After "fix" the run did not complete: ${Option.getOrUndefined(ended)?.status ?? "never ended"}`,
                ];
              }
              const [first, second] = world.turns;
              if (world.turns.length !== 2) {
                return [`It asked for ${world.turns.length} agent turns, not 2.`];
              }
              return second?.thread === `thread-${first?.key}`
                ? []
                : ["The fix did not continue the first agent's thread."];
            }),
          ),
      },
    ],
  },
  {
    id: "webhook-filter-and-dedupe",
    source:
      "Scheduled-task webhooks keep filters and replay keys as settings; a workflow has to write both.",
    task: [
      "Write a workflow named `deploy-watch` started by a webhook named `deploys`.",
      'The request body is JSON shaped `{ "status": string, "service": string }`.',
      "A sender may deliver the same event more than once; the header `x-delivery-id` identifies an event, and one event must be one run.",
      "Anything whose status is not `failed` is ignored: the run ends there, which is not a failure.",
      "For a failed deploy, an agent in the project with id `proj-1` investigates. Its brief must name the service.",
    ].join("\n"),
    scenarios: [
      {
        name: "deliveries",
        agent: () => ({ reply: "The migration timed out." }),
        check: (world) =>
          world.server(
            Effect.fn(function* (workflows) {
              if (defined(world, "deploy-watch") === undefined) return missing("deploy-watch");
              const hook = (yield* workflows.hooks).find((entry) => entry.name === "deploys");
              if (hook === undefined) return ["It has no webhook named deploys."];
              const [hookId, token] = hook.path.split("/").slice(-2).map(decodeURIComponent);
              const deliver = (delivery: string, body: string) =>
                workflows
                  .deliver({
                    hookId: hookId!,
                    token: token!,
                    request: {
                      method: "POST",
                      headers: { "content-type": "application/json", "x-delivery-id": delivery },
                      query: "",
                      body,
                    },
                  })
                  .pipe(Effect.map(Option.getOrThrow));
              const problems: Array<string> = [];

              const fine = yield* deliver("d1", SUCCEEDED);
              const ignored = yield* world.reaches(
                workflows,
                fine.runId,
                "skipped",
                "stopped",
                "completed",
                "paused",
              );
              if (Option.isNone(ignored) || ignored.value.status === "paused") {
                problems.push("A deploy that did not fail left its run paused or unfinished.");
              }
              if (world.turns.length > 0)
                problems.push("It started an agent for a deploy that did not fail.");

              const failed = yield* deliver("d2", FAILED);
              const again = yield* deliver("d2", FAILED);
              if (again.runId !== failed.runId)
                problems.push("A redelivered event started a second run.");
              const done = yield* world.reaches(
                workflows,
                failed.runId,
                "completed",
                "paused",
                "stopped",
              );
              if (Option.isNone(done) || done.value.status !== "completed") {
                problems.push(
                  `A failed deploy's run did not complete: ${Option.getOrUndefined(done)?.detail ?? "never ended"}`,
                );
              }
              const turn = world.turns[0];
              if (turn === undefined)
                return [...problems, "It started no agent for a failed deploy."];
              if (turn.project !== "proj-1") problems.push("The agent did not start in proj-1.");
              if (!turn.prompt.includes("checkout-api"))
                problems.push("The brief does not name the service.");
              return problems;
            }),
          ),
      },
    ],
  },
  {
    id: "replay-keeps-what-it-read",
    source:
      "The replay rule: the body runs again after a wait, so a value read from the world outside a step changes under the run.",
    task: [
      "Write a workflow named `stamp`, started by hand with the payload `{ label: string }`, that returns a string.",
      "It reads the current time in milliseconds since the epoch, then waits for a signal named `go` whose value is a string.",
      "When the signal arrives it returns `<label>:<time>:<signal value>`, where time is the time it read at the start.",
      "The server may restart while it waits.",
    ].join("\n"),
    scenarios: [
      {
        name: "restart while waiting",
        agent: () => ({}),
        check: Effect.fn(function* (world) {
          if (defined(world, "stamp") === undefined) return missing("stamp");
          const started = yield* world.server(
            Effect.fn(function* (workflows) {
              const { runId } = yield* workflows.start(
                "stamp",
                { label: "a" },
                { idempotencyKey: "s" },
              );
              const waiting = yield* world.reaches(
                workflows,
                runId,
                "waiting",
                "paused",
                "completed",
              );
              return { runId, waiting };
            }),
          );
          if (Option.isNone(started.waiting) || started.waiting.value.status !== "waiting") {
            return ["It never waited for the signal."];
          }
          const before = yield* Clock.currentTimeMillis;
          // Long enough that a time read again after the restart is plainly a later one.
          yield* Effect.sleep("300 millis");
          return yield* world.server(
            Effect.fn(function* (workflows) {
              yield* workflows.signal({ runId: started.runId, wait: "go" }, "now", { id: "go-1" });
              const done = yield* world.reaches(workflows, started.runId, "completed", "paused");
              if (Option.isNone(done) || done.value.status !== "completed") {
                return [
                  `It did not complete after the signal: ${Option.getOrUndefined(done)?.detail ?? "never ended"}`,
                ];
              }
              const match = /^a:(\d+):now$/.exec(String(done.value.result));
              if (match === null) return [`It returned ${String(done.value.result)}.`];
              return Number(match[1]) <= before
                ? []
                : [
                    "The time it returned was read again after the restart, not kept from the start.",
                  ];
            }),
          );
        }),
      },
    ],
  },
];
