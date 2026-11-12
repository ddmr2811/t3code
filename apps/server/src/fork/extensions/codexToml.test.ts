import { describe, expect, it } from "@effect/vitest";
import { ForkExtensionsError } from "@t3tools/contracts";

import { isValidToml, setCodexMcpEnabled } from "./codexToml.ts";

const FIXTURE = [
  "# my codex config",
  'model = "gpt-5"',
  "",
  "[mcp_servers.node_repl]  # keep me",
  'command = "node"',
  'args = ["repl.js"]',
  "",
  "[mcp_servers.node_repl.env]",
  'NODE_ENV = "dev"',
  "",
  "[mcp_servers.other]",
  "enabled = true",
  'command = "other"',
  "",
].join("\n");

describe("setCodexMcpEnabled", () => {
  it("keeps comments and other tables byte-for-byte", () => {
    const next = setCodexMcpEnabled(FIXTURE, "node_repl", false);
    expect(next).toBe(
      FIXTURE.replace(
        "[mcp_servers.node_repl]  # keep me\n",
        "[mcp_servers.node_repl]  # keep me\nenabled = false\n",
      ),
    );
    expect(isValidToml(next)).toBe(true);
  });

  it("replaces an existing enabled line in place, only in the matching table", () => {
    const next = setCodexMcpEnabled(FIXTURE, "other", false);
    expect(next).toBe(FIXTURE.replace("enabled = true", "enabled = false"));
    expect(setCodexMcpEnabled(next, "other", true)).toBe(FIXTURE);
  });

  it("does not touch the .env subtable", () => {
    const withEnvEnabled = FIXTURE.replace('NODE_ENV = "dev"', 'NODE_ENV = "dev"\nenabled = "x"');
    const next = setCodexMcpEnabled(withEnvEnabled, "node_repl", false);
    expect(next).toContain('NODE_ENV = "dev"\nenabled = "x"');
    expect(next.match(/enabled = false/g)).toHaveLength(1);
    expect(next.indexOf("enabled = false")).toBeLessThan(
      next.indexOf("[mcp_servers.node_repl.env]"),
    );
  });

  it("handles quoted table names", () => {
    const toml = [
      '[mcp_servers."my server"]',
      'url = "https://x"',
      "",
      "[other]",
      "a = 1",
      "",
    ].join("\n");
    const next = setCodexMcpEnabled(toml, "my server", false);
    expect(next).toBe(toml.replace('url = "https://x"', 'enabled = false\nurl = "https://x"'));
    expect(isValidToml(next)).toBe(true);
  });

  it("matches a quoted form of a bare name", () => {
    const toml = '[mcp_servers."node_repl"]\ncommand = "node"\n';
    expect(setCodexMcpEnabled(toml, "node_repl", true)).toBe(
      '[mcp_servers."node_repl"]\nenabled = true\ncommand = "node"\n',
    );
  });

  it("preserves CRLF line endings", () => {
    const crlf = FIXTURE.replaceAll("\n", "\r\n");
    const inserted = setCodexMcpEnabled(crlf, "node_repl", false);
    expect(inserted).toBe(crlf.replace("# keep me\r\n", "# keep me\r\nenabled = false\r\n"));
    expect(inserted.replaceAll("\r\n", "")).not.toContain("\n");
    const replaced = setCodexMcpEnabled(crlf, "other", false);
    expect(replaced).toBe(crlf.replace("enabled = true", "enabled = false"));
  });

  it("keeps a trailing comment on a replaced enabled line", () => {
    const toml = "[mcp_servers.a]\nenabled = true # why\n";
    expect(setCodexMcpEnabled(toml, "a", false)).toBe("[mcp_servers.a]\nenabled = false # why\n");
  });

  it("handles a header on the last line without a trailing newline", () => {
    expect(setCodexMcpEnabled("[mcp_servers.a]", "a", false)).toBe(
      "[mcp_servers.a]\nenabled = false",
    );
  });

  it("throws notFound when the table does not exist", () => {
    try {
      setCodexMcpEnabled(FIXTURE, "missing", false);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ForkExtensionsError);
      expect((error as ForkExtensionsError).problem.reason).toBe("notFound");
    }
  });
});

describe("isValidToml", () => {
  it("accepts valid and rejects invalid TOML", () => {
    expect(isValidToml("a = 1\n")).toBe(true);
    expect(isValidToml("a = \n[")).toBe(false);
  });
});
