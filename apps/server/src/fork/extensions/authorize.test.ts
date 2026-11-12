import { describe, expect, it } from "@effect/vitest";
import type { ForkAuthorizeEvent } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type { ResolvedAgent } from "./agents.ts";
import { extractAuthUrl, makeAuthorizer, type AuthorizeTarget } from "./authorize.ts";

const AUTH_URL = "https://claude.ai/oauth/x?y=1";
const REDIRECT = "http://localhost:43123/callback?code=secret-code&state=s1";

const claude: ResolvedAgent = {
  agent: "claude",
  binaryPath: "claude",
  home: "/home/u/.claude",
  env: { CLAUDE_CONFIG_DIR: "/home/u/.claude" },
  skillsDir: "/home/u/.claude/skills",
  configFile: "/home/u/.claude.json",
};
const codex: ResolvedAgent = {
  agent: "codex",
  binaryPath: "codex",
  home: "/home/u/.codex",
  env: {},
  skillsDir: "/home/u/.codex/skills",
  configFile: "/home/u/.codex/config.toml",
};

/** One fake login process: the test prints into it and decides when it exits. */
interface FakeLogin {
  readonly input: PtyAdapter.PtySpawnInput;
  readonly written: Array<string>;
  readonly print: (text: string) => void;
  readonly exit: (code: number) => void;
  readonly killed: () => boolean;
}

/**
 * PtyAdapter whose processes behave like `claude mcp login --no-browser`: they print what the
 * test says, and exit 0 once a line ending in Enter is typed (unless `exitOnLine` is false).
 */
const fakePty = (options: { readonly exitOnLine?: boolean } = {}) =>
  Effect.gen(function* () {
    const spawned = yield* Queue.unbounded<FakeLogin>();
    const adapter = PtyAdapter.PtyAdapter.of({
      spawn: (input) =>
        Effect.sync(() => {
          const dataListeners = new Set<(data: string) => void>();
          const exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();
          // Output printed before anyone listens is kept, as a real pipe would.
          const pending: Array<string> = [];
          let exited = false;
          let killed = false;
          const exit = (code: number) => {
            if (exited) return;
            exited = true;
            for (const listener of exitListeners) listener({ exitCode: code, signal: null });
          };
          const print = (text: string) => {
            if (dataListeners.size === 0) pending.push(text);
            for (const listener of dataListeners) listener(text);
          };
          const login: FakeLogin = {
            input,
            written: [],
            print,
            exit,
            killed: () => killed,
          };
          const process: PtyAdapter.PtyProcess = {
            pid: 4242,
            write: (data) => {
              login.written.push(data);
              print(data); // a terminal echoes what is typed
              if (data.endsWith("\r") && options.exitOnLine !== false) exit(0);
            },
            resize: () => {},
            kill: () => {
              killed = true;
              exit(1);
            },
            onData: (callback) => {
              dataListeners.add(callback);
              for (const text of pending.splice(0)) callback(text);
              return () => dataListeners.delete(callback);
            },
            onExit: (callback) => {
              exitListeners.add(callback);
              return () => exitListeners.delete(callback);
            },
          };
          Queue.offerUnsafe(spawned, login);
          return process;
        }),
    });
    return { adapter, spawned };
  });

const withAuthorizer = <A, E>(
  body: (input: {
    readonly authorizer: Effect.Success<ReturnType<typeof makeAuthorizer>>;
    readonly spawned: Queue.Queue<FakeLogin>;
    readonly doneTargets: Ref.Ref<ReadonlyArray<AuthorizeTarget>>;
  }) => Effect.Effect<A, E>,
  options: { readonly exitOnLine?: boolean } = {},
) =>
  Effect.gen(function* () {
    const { adapter, spawned } = yield* fakePty(options);
    const doneTargets = yield* Ref.make<ReadonlyArray<AuthorizeTarget>>([]);
    const authorizer = yield* makeAuthorizer({
      onDone: (target) => Ref.update(doneTargets, (all) => [...all, target]),
    }).pipe(Effect.provideService(PtyAdapter.PtyAdapter, adapter));
    return yield* body({ authorizer, spawned, doneTargets });
  }).pipe(
    // Spawn resolution stays an identity: the tests never look up a real binary.
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(HostProcess.Platform, "linux"),
        Layer.succeed(HostProcess.Environment, { PATH: "/usr/bin" }),
        Layer.succeed(HostProcess.HomeDirectory, "/home/u"),
      ),
    ),
  );

/** Runs the stream in the background; events land in a queue the test reads one by one. */
const subscribe = (stream: Stream.Stream<ForkAuthorizeEvent, unknown>) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<ForkAuthorizeEvent>();
    const finished = yield* Deferred.make<void>();
    const fiber = yield* stream.pipe(
      Stream.runForEach((event) => Queue.offer(events, event)),
      Effect.ensuring(Deferred.succeed(finished, undefined)),
      Effect.forkChild({ startImmediately: true }),
    );
    return { events, fiber, finished };
  });

const authUrlOf = (event: ForkAuthorizeEvent) => {
  if (event._tag !== "authUrl") throw new Error(`expected authUrl, got ${event._tag}`);
  return event;
};

describe("extractAuthUrl", () => {
  it("waits until the URL is complete", () => {
    expect(extractAuthUrl("Open this URL: https://claude.ai/oau", false)).toBeNull();
    expect(extractAuthUrl("Open this URL: https://claude.ai/oauth/x?y=1\r\n", false)).toBe(
      AUTH_URL,
    );
    expect(extractAuthUrl("Open this URL: https://claude.ai/oauth/x?y=1", true)).toBe(AUTH_URL);
  });

  it("reads through terminal colors and hyperlinks", () => {
    const osc8 = `\u001b]8;;${AUTH_URL}\u0007${AUTH_URL}\u001b]8;;\u0007`;
    expect(extractAuthUrl(`Visit this URL to authorize:\r\n  ${osc8}\r\n`, false)).toBe(AUTH_URL);
    expect(extractAuthUrl(`\u001b[1mVisit\u001b[22m ${AUTH_URL}\u001b[0m\r\n`, false)).toBe(
      AUTH_URL,
    );
    expect(extractAuthUrl("see http://localhost:1/x and nothing else\n", false)).toBeNull();
  });
});

describe("authorize", () => {
  it.effect("streams the URL, types the pasted redirect into the login, then done", () =>
    withAuthorizer(({ authorizer, spawned, doneTargets }) =>
      Effect.gen(function* () {
        const target = { itemId: "mcp:context7", agent: "claude" } as const;
        const { events } = yield* subscribe(authorizer.authorize(claude, target));
        const login = yield* Queue.take(spawned);
        expect([login.input.shell, ...(login.input.args ?? [])]).toEqual([
          "claude",
          "mcp",
          "login",
          "--no-browser",
          "context7",
        ]);
        expect(login.input.env).toMatchObject({
          PATH: "/usr/bin",
          CLAUDE_CONFIG_DIR: "/home/u/.claude",
        });
        expect(login.input.cwd).toBe("/home/u");
        // The URL arrives split across chunks.
        login.print("Starting authentication…\r\nOpen this URL: https://claude.ai/oau");
        login.print("th/x?y=1\r\nOr paste the redirect URL here: ");

        const first = authUrlOf(yield* Queue.take(events));
        expect(first.url).toBe(AUTH_URL);
        expect(first.sessionId).toMatch(/^[A-Za-z0-9_-]{32,}$/);

        yield* authorizer.authorizeComplete({ sessionId: first.sessionId, redirectUrl: REDIRECT });
        expect(login.written).toEqual([`${REDIRECT}\r`]);
        expect(yield* Queue.take(events)).toEqual({ _tag: "done" });
        expect(yield* Ref.get(doneTargets)).toEqual([target]);
        // The session is gone once the login ended.
        const error = yield* Effect.flip(
          authorizer.authorizeComplete({ sessionId: first.sessionId, redirectUrl: REDIRECT }),
        );
        expect(error.problem.reason).toBe("notFound");
      }),
    ),
  );

  it.effect("uses each CLI's name: claude.ai connectors and Codex servers", () =>
    withAuthorizer(({ authorizer, spawned }) =>
      Effect.gen(function* () {
        const connector = yield* subscribe(
          authorizer.authorize(claude, { itemId: "mcp:claude.ai Gmail", agent: "claude" }),
        );
        const claudeLogin = yield* Queue.take(spawned);
        expect(claudeLogin.input.args).toEqual(["mcp", "login", "--no-browser", "claude.ai Gmail"]);
        // A claude.ai connector prints its link and exits: approval happens on claude.ai.
        claudeLogin.print(`Visit this URL to authorize:\r\n  ${AUTH_URL}\r\n\r\nOnce authorized…`);
        claudeLogin.exit(0);
        expect(authUrlOf(yield* Queue.take(connector.events)).url).toBe(AUTH_URL);
        expect(yield* Queue.take(connector.events)).toEqual({ _tag: "done" });

        yield* subscribe(authorizer.authorize(codex, { itemId: "mcp:docs", agent: "codex" }));
        const codexLogin = yield* Queue.take(spawned);
        expect([codexLogin.input.shell, ...(codexLogin.input.args ?? [])]).toEqual([
          "codex",
          "mcp",
          "login",
          "--no-browser",
          "docs",
        ]);
      }),
    ),
  );

  it.effect("rejects items that are not MCP servers, and Codex for claude.ai or plugins", () =>
    withAuthorizer(({ authorizer, spawned }) =>
      Effect.gen(function* () {
        for (const [agent, itemId, reason] of [
          [claude, "plugin:superpowers@official", "invalidInput"],
          [claude, "mcp:", "invalidInput"],
          [codex, "mcp:claude.ai Gmail", "unsupported"],
          [codex, "mcp:plugin:design:figma", "unsupported"],
        ] as const) {
          const error = yield* Effect.flip(
            Stream.runDrain(authorizer.authorize(agent, { itemId, agent: agent.agent })),
          );
          expect(error.problem.reason).toBe(reason);
        }
        expect(yield* Queue.size(spawned)).toBe(0);
      }),
    ),
  );

  it.effect("a login that exits before printing a URL fails with its output", () =>
    withAuthorizer(({ authorizer, spawned }) =>
      Effect.gen(function* () {
        const { events } = yield* subscribe(
          authorizer.authorize(claude, { itemId: "mcp:ghost", agent: "claude" }),
        );
        const login = yield* Queue.take(spawned);
        login.print('\u001b[31mNo MCP server named "ghost".\u001b[0m\r\n');
        login.exit(1);
        const event = yield* Queue.take(events);
        expect(event).toMatchObject({
          _tag: "failed",
          problem: { reason: "commandFailed", rawOutput: 'No MCP server named "ghost".' },
        });
      }),
    ),
  );

  it.effect("a failed login never reports the pasted redirect address", () =>
    withAuthorizer(
      ({ authorizer, spawned, doneTargets }) =>
        Effect.gen(function* () {
          const { events } = yield* subscribe(
            authorizer.authorize(claude, { itemId: "mcp:context7", agent: "claude" }),
          );
          const login = yield* Queue.take(spawned);
          login.print(`Open this URL: ${AUTH_URL}\r\n`);
          const { sessionId } = authUrlOf(yield* Queue.take(events));
          yield* authorizer.authorizeComplete({ sessionId, redirectUrl: ` ${REDIRECT}\n` });
          login.print("\r\nToken exchange failed (code=secret-code rejected)\r\n");
          login.exit(1);
          const event = yield* Queue.take(events);
          if (event._tag !== "failed") throw new Error("expected failed");
          expect(event.problem.rawOutput).toContain("Token exchange failed");
          expect(event.problem.rawOutput).not.toContain("secret-code");
          expect(yield* Ref.get(doneTargets)).toEqual([]);
        }),
      { exitOnLine: false },
    ),
  );

  it.effect("authorizeComplete accepts only a single-line http(s) address", () =>
    withAuthorizer(
      ({ authorizer, spawned }) =>
        Effect.gen(function* () {
          const { events } = yield* subscribe(
            authorizer.authorize(claude, { itemId: "mcp:context7", agent: "claude" }),
          );
          const login = yield* Queue.take(spawned);
          login.print(`Open this URL: ${AUTH_URL}\r\n`);
          const { sessionId } = authUrlOf(yield* Queue.take(events));
          for (const redirectUrl of [
            `${REDIRECT}\nmore`,
            `${REDIRECT}\rmore`,
            "http://localhost:1/cb?code=a b",
            "javascript:alert(1)",
            "localhost:1/cb?code=x",
            "",
          ]) {
            const error = yield* Effect.flip(
              authorizer.authorizeComplete({ sessionId, redirectUrl }),
            );
            expect(error.problem.reason).toBe("invalidInput");
          }
          expect(login.written).toEqual([]);
          const unknown = yield* Effect.flip(
            authorizer.authorizeComplete({ sessionId: "nope", redirectUrl: REDIRECT }),
          );
          expect(unknown.problem.reason).toBe("notFound");
        }),
      { exitOnLine: false },
    ),
  );

  it.effect("a session expires after 10 minutes and its login is stopped", () =>
    withAuthorizer(({ authorizer, spawned }) =>
      Effect.gen(function* () {
        const { events } = yield* subscribe(
          authorizer.authorize(claude, { itemId: "mcp:context7", agent: "claude" }),
        );
        const login = yield* Queue.take(spawned);
        login.print(`Open this URL: ${AUTH_URL}\r\n`);
        const { sessionId } = authUrlOf(yield* Queue.take(events));

        yield* TestClock.adjust("9 minutes");
        expect(login.killed()).toBe(false);
        yield* TestClock.adjust("1 minute");
        expect(yield* Queue.take(events)).toMatchObject({
          _tag: "failed",
          problem: { reason: "timeout" },
        });
        expect(login.killed()).toBe(true);
        const error = yield* Effect.flip(
          authorizer.authorizeComplete({ sessionId, redirectUrl: REDIRECT }),
        );
        expect(error.problem.reason).toBe("notFound");
        expect(login.written).toEqual([]);
      }),
    ),
  );

  it.effect("closing the stream (client gone) stops the login and drops the session", () =>
    withAuthorizer(({ authorizer, spawned }) =>
      Effect.gen(function* () {
        const { events, fiber } = yield* subscribe(
          authorizer.authorize(claude, { itemId: "mcp:context7", agent: "claude" }),
        );
        const login = yield* Queue.take(spawned);
        login.print(`Open this URL: ${AUTH_URL}\r\n`);
        const { sessionId } = authUrlOf(yield* Queue.take(events));
        yield* Fiber.interrupt(fiber);
        expect(login.killed()).toBe(true);
        const error = yield* Effect.flip(
          authorizer.authorizeComplete({ sessionId, redirectUrl: REDIRECT }),
        );
        expect(error.problem.reason).toBe("notFound");
      }),
    ),
  );

  it.effect("a new Authorize for the same server and agent replaces the old one", () =>
    withAuthorizer(({ authorizer, spawned }) =>
      Effect.gen(function* () {
        const target = { itemId: "mcp:context7", agent: "claude" } as const;
        const old = yield* subscribe(authorizer.authorize(claude, target));
        const oldLogin = yield* Queue.take(spawned);
        oldLogin.print(`Open this URL: ${AUTH_URL}\r\n`);
        const oldSession = authUrlOf(yield* Queue.take(old.events)).sessionId;

        // Another server, or the same server on the other agent, is left alone.
        yield* subscribe(authorizer.authorize(claude, { itemId: "mcp:other", agent: "claude" }));
        const otherLogin = yield* Queue.take(spawned);

        const fresh = yield* subscribe(authorizer.authorize(claude, target));
        const freshLogin = yield* Queue.take(spawned);
        expect(yield* Queue.take(old.events)).toMatchObject({
          _tag: "failed",
          problem: { reason: "commandFailed" },
        });
        yield* Deferred.await(old.finished);
        expect(oldLogin.killed()).toBe(true);
        expect(otherLogin.killed()).toBe(false);
        const stale = yield* Effect.flip(
          authorizer.authorizeComplete({ sessionId: oldSession, redirectUrl: REDIRECT }),
        );
        expect(stale.problem.reason).toBe("notFound");

        freshLogin.print(`Open this URL: ${AUTH_URL}&n=2\r\n`);
        const freshSession = authUrlOf(yield* Queue.take(fresh.events));
        expect(freshSession.url).toBe(`${AUTH_URL}&n=2`);
        expect(freshSession.sessionId).not.toBe(oldSession);
        yield* authorizer.authorizeComplete({
          sessionId: freshSession.sessionId,
          redirectUrl: REDIRECT,
        });
        expect(yield* Queue.take(fresh.events)).toEqual({ _tag: "done" });
      }),
    ),
  );

  it.effect("an old CLI without --no-browser gets an update hint", () =>
    withAuthorizer(({ authorizer, spawned }) =>
      Effect.gen(function* () {
        const { events } = yield* subscribe(
          authorizer.authorize(codex, { itemId: "mcp:docs", agent: "codex" }),
        );
        const login = yield* Queue.take(spawned);
        login.print("error: unexpected argument '--no-browser' found\r\n");
        login.exit(2);
        const event = yield* Queue.take(events);
        if (event._tag !== "failed") throw new Error("expected failed");
        expect(event.problem.nextStep).toBe(
          "Update Codex on that machine, or run `codex mcp login docs` in a terminal there.",
        );
      }),
    ),
  );
});
