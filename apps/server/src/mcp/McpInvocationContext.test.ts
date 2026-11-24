import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  McpCapabilityUnavailableError,
  PreviewAutomationUnavailableError,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "./McpInvocationContext.ts";

it.effect("reports other missing capabilities with the neutral error", () => {
  const invocation: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    requestNamespace: "provider-session-1",
    thread: {
      threadId: ThreadId.make("thread-1"),
      providerSessionId: "provider-session-1",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    capabilities: new Set(["preview"]),
    issuedAt: 1,
  };

  return Effect.gen(function* () {
    const error = yield* McpInvocationContext.requireMcpCapability("pull-requests").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.flip,
    );

    expect(error).toBeInstanceOf(McpCapabilityUnavailableError);
    expect(error).toMatchObject({
      capability: "pull-requests",
      threadId: invocation.thread?.threadId,
    });

    const scope = yield* McpInvocationContext.requireMcpCapability("preview").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    );
    expect(scope).toBe(invocation);
  });
});

it.effect("refuses thread-owned capabilities to a caller signed in from outside a thread", () => {
  const invocation: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    requestNamespace: "client:session-1",
    thread: undefined,
    client: { sessionId: "session-1", label: "Claude Code", access: "auto" },
    capabilities: new Set(["preview", "orchestration"]),
    issuedAt: 1,
  };

  return Effect.gen(function* () {
    const error = yield* McpInvocationContext.requireThreadMcpCapability("preview").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.flip,
    );
    expect(error).toBeInstanceOf(PreviewAutomationUnavailableError);
    expect(error).toMatchObject({ capability: "preview", environmentId: "environment-1" });
    expect(error.threadId).toBeUndefined();
  });
});

it("acts at an administrator's ceiling for a client approved above it", () => {
  const scope = (
    access: McpInvocationContext.McpClientCaller["access"],
    narrowedTo?: McpInvocationContext.ClientModes,
  ): McpInvocationContext.McpInvocationScope => ({
    environmentId: EnvironmentId.make("environment-1"),
    requestNamespace: "client:session-1",
    thread: undefined,
    client: { sessionId: "session-1", label: "Claude Code", access, narrowedTo },
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  });
  const modes = (invocation: McpInvocationContext.McpInvocationScope, ceiling?: "auto") =>
    McpInvocationContext.clientModeCeiling(
      McpInvocationContext.withRuntimeModeCeiling(invocation, ceiling).client,
    );

  expect(modes(scope("full-access"), "auto")).toEqual({
    runtimeMode: "auto",
    interactionMode: "default",
  });
  // A narrower request and the approved mode still win below the ceiling.
  expect(
    modes(
      scope("full-access", { runtimeMode: "approval-required", interactionMode: "plan" }),
      "auto",
    ),
  ).toEqual({ runtimeMode: "approval-required", interactionMode: "plan" });
  expect(modes(scope("auto-accept-edits"), "auto").runtimeMode).toBe("auto-accept-edits");
  expect(modes(scope("full-access")).runtimeMode).toBe("full-access");
});

it.effect.each([
  ["a bot's own thread", { bot: true }, true],
  ["an ordinary thread", { bot: false }, false],
  ["a subagent of a bot's thread", { bot: true, subagent: true }, false],
  ["an outside client", { bot: true, outside: true }, false],
] as const)("hiddenOutsideBotThreads lists bot_handoff for %s: %s", ([, caller, shown]) => {
  const scope: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    requestNamespace: "provider-session-1",
    thread:
      "outside" in caller
        ? undefined
        : {
            threadId: ThreadId.make("thread-1"),
            providerSessionId: "provider-session-1",
            providerInstanceId: ProviderInstanceId.make("codex"),
            ...("subagent" in caller ? { subagent: true } : {}),
          },
    client:
      "outside" in caller
        ? { sessionId: "session-1", label: "Claude Code", access: "auto" }
        : undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
    bot: caller.bot,
  };
  return Effect.sync(McpInvocationContext.hiddenOutsideBotThreads).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.map((visible) => expect(visible).toBe(shown)),
  );
});
