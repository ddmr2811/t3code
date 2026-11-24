import { describe, expect, it, vi } from "vite-plus/test";

import { hasTracingPublicConfig, resolveCloudPublicConfig } from "./publicConfig";

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {},
    },
  },
}));

describe("resolveCloudPublicConfig", () => {
  it("rejects an insecure relay URL", () => {
    expect(
      resolveCloudPublicConfig({
        clerk: { publishableKey: "pk_test_example", jwtTemplate: "t3-relay" },
        relay: { url: "http://relay.example.test" },
      }),
    ).toEqual({
      clerk: {
        publishableKey: "pk_test_example",
        jwtTemplate: "t3-relay",
      },
      relay: {
        url: null,
      },
      observability: {
        enabled: false,
        tracesUrl: null,
        tracesDataset: null,
        tracesToken: null,
      },
    });
  });
});

describe("hasTracingPublicConfig", () => {
  it.each([
    { build: "has tracing credentials but no opt-in", enabled: undefined, traces: false },
    { build: "opted in", enabled: true, traces: true },
  ])("a build that $build traces: $traces", ({ enabled, traces }) => {
    const config = resolveCloudPublicConfig({
      observability: {
        enabled,
        tracesUrl: "https://api.axiom.test/v1/traces",
        tracesDataset: "mobile-traces",
        tracesToken: "public-ingest-token",
      },
    });

    expect(hasTracingPublicConfig(config)).toBe(traces);
  });
});
