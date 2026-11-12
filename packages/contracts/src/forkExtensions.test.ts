import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ExecutionEnvironmentCapabilities } from "./environment.ts";
import {
  FORK_EXTENSIONS_PROTOCOL_VERSION,
  ForkExtensionsSnapshot,
  ForkInstallRequest,
} from "./forkExtensions.ts";

const decodeSnapshot = Schema.decodeSync(ForkExtensionsSnapshot);
const decodeInstallRequest = Schema.decodeUnknownSync(ForkInstallRequest);
const decodeCapabilities = Schema.decodeSync(ExecutionEnvironmentCapabilities);

describe("Fork Extensions contracts", () => {
  it("decodes a snapshot with a needsAttention cell and its problem", () => {
    const snapshot = decodeSnapshot({
      protocolVersion: FORK_EXTENSIONS_PROTOCOL_VERSION,
      agents: [{ agent: "claude", available: true }],
      projects: [{ path: "/repo", title: "repo" }],
      items: [
        {
          id: "mcp:playwright",
          kind: "mcp",
          name: "playwright",
          source: "user",
          transport: "stdio",
          pluginId: null,
          readOnly: false,
          cells: [
            {
              agent: "claude",
              state: "needsAttention",
              scopes: ["user"],
              projects: [{ path: "/repo", title: "repo", disabled: false }],
              problem: {
                reason: "timeout",
                summary: "Timed out",
                nextStep: "Retry",
                rawOutput: null,
              },
              usageCount: 0,
              lastUsedAt: null,
              stashDiscarded: false,
            },
          ],
        },
      ],
      healthCheckedAt: null,
    });
    expect(snapshot.items[0]?.cells[0]?.problem?.reason).toBe("timeout");
  });

  it("rejects an install request with an empty agents list", () => {
    expect(() =>
      decodeInstallRequest({
        _tag: "skill",
        name: "x",
        agents: [],
        source: "/tmp/x",
      }),
    ).toThrow();
  });

  it("ExecutionEnvironmentCapabilities decodes without forkExtensions", () => {
    expect(decodeCapabilities({}).forkExtensions).toBe(undefined);
  });
});
