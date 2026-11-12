import { assert, it } from "@effect/vitest";

import {
  CLAUDE_PROJECT_DISABLED_KEY,
  readClaudeJson,
  setClaudeProjectDisabled,
} from "./claudeJson.ts";

const SAMPLE = JSON.stringify(
  {
    numStartups: 3,
    mcpServers: { a: { type: "stdio", command: "x" } },
    claudeAiMcpEverConnected: ["claude.ai Stripe"],
    projects: {
      "C:/repo": {
        allowedTools: [],
        mcpServers: { b: { type: "http", url: "https://b" } },
        [CLAUDE_PROJECT_DISABLED_KEY]: ["a"],
      },
      "C:/other": { allowedTools: [] },
    },
  },
  null,
  2,
);

it("readClaudeJson extracts user servers, projects and connectors", () => {
  const view = readClaudeJson(SAMPLE);
  assert.deepStrictEqual(Object.keys(view.userServers), ["a"]);
  assert.deepStrictEqual(view.claudeAiConnectors, ["claude.ai Stripe"]);
  const repo = view.projects.find((project) => project.path === "C:/repo");
  assert.deepStrictEqual(Object.keys(repo?.servers ?? {}), ["b"]);
  assert.deepStrictEqual(repo?.disabled, ["a"]);
  assert.deepStrictEqual(view.projects.find((p) => p.path === "C:/other")?.disabled, []);
});

it("readClaudeJson tolerates empty or invalid text", () => {
  for (const text of ["", "not json", "[]"]) {
    const view = readClaudeJson(text);
    assert.deepStrictEqual(view.userServers, {});
    assert.deepStrictEqual(view.projects, []);
    assert.deepStrictEqual(view.claudeAiConnectors, []);
  }
});

it("setClaudeProjectDisabled adds and removes only that name", () => {
  const added = setClaudeProjectDisabled(SAMPLE, "C:/repo", "b", true);
  const addedJson = JSON.parse(added);
  assert.deepStrictEqual(addedJson.projects["C:/repo"][CLAUDE_PROJECT_DISABLED_KEY], ["a", "b"]);
  const rest = JSON.parse(SAMPLE);
  delete rest.projects["C:/repo"][CLAUDE_PROJECT_DISABLED_KEY];
  delete addedJson.projects["C:/repo"][CLAUDE_PROJECT_DISABLED_KEY];
  assert.deepStrictEqual(addedJson, rest);
  assert.include(added, '\n  "numStartups": 3');

  const removed = setClaudeProjectDisabled(added, "C:/repo", "a", false);
  assert.deepStrictEqual(JSON.parse(removed).projects["C:/repo"][CLAUDE_PROJECT_DISABLED_KEY], [
    "b",
  ]);
});

it("setClaudeProjectDisabled is idempotent and creates missing projects", () => {
  assert.strictEqual(setClaudeProjectDisabled(SAMPLE, "C:/repo", "a", true), SAMPLE);
  const created = JSON.parse(setClaudeProjectDisabled(SAMPLE, "C:/new", "z", true));
  assert.deepStrictEqual(created.projects["C:/new"][CLAUDE_PROJECT_DISABLED_KEY], ["z"]);
});
