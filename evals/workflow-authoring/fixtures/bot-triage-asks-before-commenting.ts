// Written the way an agent with only the skill would write it.
const { workflow, agent, integration, stop, daily, Tick } = T3;

export default [
  workflow(
    "issue-triage",
    { version: 1, payload: Tick, triggers: [daily("08:00")] },
    Effect.fn(function* () {
      const repo = { owner: "acme", repo: "app" };
      const open = yield* integration("leer", {
        bot: "triaje",
        app: "github",
        action: "list_issues",
        arguments: { ...repo, state: "OPEN" },
      });
      if (open.status !== "done") return yield* stop(`could not read the issues: ${open.text}`);
      const triage = yield* agent("clasificar", {
        bot: "triaje",
        brief: `Classify these open issues. Change nothing.\n${open.text}`,
        returns: Schema.Struct({
          issues: Schema.Array(Schema.Struct({ number: Schema.Number, comment: Schema.String })),
        }),
      });
      for (const issue of triage.value.issues) {
        yield* integration(`comentar-${issue.number}`, {
          bot: "triaje",
          app: "github",
          action: "add_issue_comment",
          arguments: { ...repo, issue_number: issue.number, body: issue.comment },
          timeout: "2 days",
        });
      }
    }),
  ),
];
