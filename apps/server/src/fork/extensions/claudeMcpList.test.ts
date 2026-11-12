import { assert, it } from "@effect/vitest";

import { mcpToolPrefix, parseClaudeMcpList } from "./claudeMcpList.ts";

const STDOUT = `Checking MCP server health…

claude.ai MCP Gestion/Patricia: https://n8n-n8n.46rgou.easypanel.host/mcp/MCPPatricia/sse - ✔ Connected
claude.ai Stripe: https://mcp.stripe.com - ! Needs authentication
plugin:cloudflare:cloudflare: https://mcp.cloudflare.com/mcp (HTTP) - ! Needs authentication
plugin:playwright:playwright: npx @playwright/mcp@latest - ✔ Connected
`;

it("parseClaudeMcpList parses names with spaces, slashes and colons", () => {
  const entries = parseClaudeMcpList(STDOUT);
  assert.strictEqual(entries.length, 4);
  assert.deepStrictEqual(
    entries.map((entry) => entry.name),
    [
      "claude.ai MCP Gestion/Patricia",
      "claude.ai Stripe",
      "plugin:cloudflare:cloudflare",
      "plugin:playwright:playwright",
    ],
  );
  assert.deepStrictEqual(
    entries.map((entry) => entry.state),
    ["working", "needsAttention", "needsAttention", "working"],
  );
  assert.strictEqual(
    entries[0]?.target,
    "https://n8n-n8n.46rgou.easypanel.host/mcp/MCPPatricia/sse",
  );
  assert.strictEqual(entries[2]?.target, "https://mcp.cloudflare.com/mcp (HTTP)");
  assert.strictEqual(entries[3]?.target, "npx @playwright/mcp@latest");
  assert.strictEqual(entries[1]?.detail, "Needs authentication");
});

it("parseClaudeMcpList treats other statuses as failed", () => {
  const [entry] = parseClaudeMcpList("srv: npx foo - ✗ Failed to connect\n");
  assert.strictEqual(entry?.state, "failed");
  assert.strictEqual(entry?.detail, "Failed to connect");
});

it("mcpToolPrefix sanitises the server name", () => {
  assert.strictEqual(
    mcpToolPrefix("claude.ai MCP Gestion/Patricia"),
    "mcp__claude_ai_MCP_Gestion_Patricia__",
  );
  assert.strictEqual(
    mcpToolPrefix("plugin:playwright:playwright"),
    "mcp__plugin_playwright_playwright__",
  );
});
