import { describe, expect, it } from "@effect/vitest";

import { redactSecrets, summaryLine } from "./redact.ts";

describe("redactSecrets", () => {
  it.each([
    ["GitHub token", "pushed with ghp_abcdefghijklmnopqrstuvwxyz0123456789", "ghp_"],
    ["fine-grained GitHub token", "github_pat_11ABCDEFG0123456789_abcdefghij", "github_pat_"],
    ["OpenAI key", "OPENAI sk-proj-abc123DEF456ghi789", "sk-proj"],
    ["Slack token", "slack xoxb-1234567890-abcdefghij", "xoxb-"],
    [
      "JWT",
      "auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
      "eyJhbGci",
    ],
    ["long hex", "secret 0123456789abcdef0123456789abcdef01 here", "0123456789abcdef"],
    ["long base64", "blob QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0MjQyNDI= end", "QUJDREVG"],
    ["key=", "curl api_key=hunter2hunter2 now", "hunter2"],
    ["token:", 'set token: "abc def"', "abc def"],
    ["password=", "PASSWORD=correct-horse", "correct-horse"],
    ["Bearer", "Authorization: Bearer abcdefghijklmnop", "abcdefghijklmnop"],
  ])("masks a %s", (_name, text, leaked) => {
    const out = redactSecrets(text);
    expect(out).not.toContain(leaked);
    expect(out).toContain("•••");
  });

  it("keeps ordinary words, paths and short hashes", () => {
    const text =
      "fix(web): no-test-timeout-or-unreasoned-skip in apps/web/src/fork/x.ts at 8de89f7731";
    expect(redactSecrets(text)).toBe(text);
  });

  it("keeps the name of a masked setting", () => {
    expect(redactSecrets("GH_TOKEN=abc123")).toBe("GH_TOKEN=•••");
  });
});

describe("summaryLine", () => {
  it("keeps only the first non-empty line, with whitespace collapsed", () => {
    expect(summaryLine("\n\n  Tests   in green\nsecond line with sk-secretsecret")).toBe(
      "Tests in green",
    );
  });

  it("cuts to the limit with an ellipsis", () => {
    const out = summaryLine("word ".repeat(100));
    expect(out).toHaveLength(160);
    expect(out.endsWith("…")).toBe(true);
    expect(summaryLine("abcdef", 4)).toBe("abc…");
  });

  it("masks before cutting, and drops the partial word of a very long line", () => {
    const token = `ghp_${"a".repeat(40)}`;
    expect(summaryLine(`deploy ${token} done`)).toBe("deploy ••• done");
    const long = `${"x ".repeat(499)}${token}`;
    expect(summaryLine(long)).not.toContain("ghp_a");
  });
});
