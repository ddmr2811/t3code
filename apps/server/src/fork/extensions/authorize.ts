import {
  ForkExtensionsError,
  type ForkAuthorizeCompleteInput,
  type ForkAuthorizeEvent,
  type ForkExtensionAgent,
  type ForkExtensionProblem,
} from "@t3tools/contracts";
import { isCommandMissingCause } from "@t3tools/provider-core/server/snapshotProbe";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import type * as Cause from "effect/Cause";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import type { ResolvedAgent } from "./agents.ts";

// `<agent> mcp login --no-browser` runs in a pseudo-terminal, not with piped stdin: Claude
// Code reads the pasted redirect address only from a terminal (a pipe aborts the login).

/** A session not finished by then is stopped, and its login killed. */
const AUTHORIZE_SESSION_TTL = "10 minutes";

// Wide enough that no authorization URL is ever wrapped by the terminal.
const PTY_COLUMNS = 4096;
const PTY_ROWS = 40;

const RAW_OUTPUT_LIMIT = 8 * 1024;
/** Output kept per login; a login prints a few lines. */
const OUTPUT_LIMIT = 64 * 1024;

const AGENT_DISPLAY_NAMES: Record<ForkExtensionAgent, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

export interface AuthorizeTarget {
  readonly itemId: string;
  readonly agent: ForkExtensionAgent;
}

const problem = (
  reason: ForkExtensionProblem["reason"],
  summary: string,
  nextStep: string,
  rawOutput: string | null = null,
): ForkExtensionProblem => ({ reason, summary, nextStep, rawOutput });

const fail = (...args: Parameters<typeof problem>) =>
  new ForkExtensionsError({ problem: problem(...args) });

// CSI (colors, cursor) and other escape sequences; OSC 8 hyperlinks keep their target.
const OSC_PATTERN = /\u001b\]8;[^;\u0007\u001b]*;([^\u0007\u001b]*)(?:\u0007|\u001b\\)/g;
const OTHER_OSC_PATTERN = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const CSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g;

/** Terminal output as plain text: no colors or cursor moves, hyperlinks as their target. */
const plainText = (output: string): string =>
  output
    .replace(OSC_PATTERN, (_match, target: string) => (target === "" ? "" : ` ${target} `))
    .replace(OTHER_OSC_PATTERN, "")
    .replace(CSI_PATTERN, "")
    .replace(/\r\n?/g, "\n");

const URL_PATTERN = /https:\/\/[^\s\u0000-\u001f\u007f"'<>`]+/;

/**
 * The first `https://` URL in the login's output. Output arrives in chunks, so until the login
 * has `ended` a URL counts only once something follows it (it may still be growing).
 */
export const extractAuthUrl = (output: string, ended: boolean): string | null => {
  const text = plainText(output);
  const match = URL_PATTERN.exec(text);
  if (match === null) return null;
  if (!ended && match.index + match[0].length >= text.length) return null;
  return match[0].replace(/[.,;:)\]]+$/, "");
};

/** The redirect address carries the authorization code: it never leaves the machine again. */
const redact = (text: string, pasted: ReadonlyArray<string>): string => {
  let result = text;
  for (const line of pasted) {
    result = result.split(line).join("[redirect address]");
    // The CLI may quote the code alone, e.g. in a token-exchange error.
    const params = URL.canParse(line) ? new URL(line).searchParams : new URLSearchParams();
    for (const value of params.values()) {
      if (value.length >= 4) result = result.split(value).join("…");
    }
  }
  return result.replace(/([?&](?:code|state)=)[^&\s)]+/g, "$1…");
};

const rawOutputOf = (output: string, pasted: ReadonlyArray<string>): string | null => {
  const text = redact(plainText(output), pasted)
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
  if (text === "") return null;
  return text.length <= RAW_OUTPUT_LIMIT ? text : `${text.slice(0, RAW_OUTPUT_LIMIT)}\n…`;
};

/** `mcp:<name>` → `<name>`, exactly as `claude mcp list` prints it. */
const mcpServerName = (itemId: string): string | null => {
  if (!itemId.startsWith("mcp:")) return null;
  const name = itemId.slice("mcp:".length);
  return name.trim() === "" ? null : name;
};

const isClaudeOnlyServer = (name: string) =>
  name.startsWith("claude.ai ") || name.startsWith("plugin:");

/** A pasted redirect address: one line, http(s), parseable. Outer whitespace is dropped. */
const parseRedirectUrl = (input: string): string | null => {
  const url = input.trim();
  if (url === "" || /[\s\u0000-\u001f\u007f]/.test(url)) return null;
  if (!/^https?:\/\//i.test(url) || !URL.canParse(url)) return null;
  return url;
};

/** 256 secure random bits: a session id can't be guessed. */
const newSessionId = Effect.sync(() =>
  Buffer.from(SecureRandom.randomBytesUnsafe(32)).toString("base64url"),
);

type LoginEvent =
  | { readonly _tag: "data"; readonly text: string }
  | { readonly _tag: "exit"; readonly code: number }
  | { readonly _tag: "stop"; readonly problem: ForkExtensionProblem };

interface Run {
  readonly stop: (reason: ForkExtensionProblem) => Effect.Effect<void>;
}

interface Session {
  readonly submit: (redirectUrl: string) => Effect.Effect<void>;
}

export const makeAuthorizer = Effect.fn("ForkExtensions.makeAuthorizer")(function* (options: {
  /** After a login ends with exit 0 (e.g. the cached health cell is now stale). */
  readonly onDone: (target: AuthorizeTarget) => Effect.Effect<void>;
}) {
  const pty = yield* PtyAdapter.PtyAdapter;
  // At most one login per (item, agent); a newer Authorize replaces the older one.
  const runs = yield* Ref.make<ReadonlyMap<string, Run>>(new Map());
  // Only sessions whose URL was streamed; the id is the client's only handle to its login.
  const sessions = yield* Ref.make<ReadonlyMap<string, Session>>(new Map());

  const login = Effect.fn("ForkExtensions.authorizeLogin")(function* (
    agent: ResolvedAgent,
    target: AuthorizeTarget,
    name: string,
    events: Queue.Queue<ForkAuthorizeEvent, ForkExtensionsError | Cause.Done>,
  ) {
    const key = `${target.itemId}|${target.agent}`;
    const label = `${agent.agent} mcp login ${name}`;
    const inbox = yield* Queue.unbounded<LoginEvent>();
    const run: Run = { stop: (reason) => Queue.offer(inbox, { _tag: "stop", problem: reason }) };
    let sessionId: string | null = null;
    let process: PtyAdapter.PtyProcess | null = null;
    let exited = false;
    const pasted: Array<string> = [];

    const previous = yield* Ref.modify(runs, (all) => {
      const next = new Map(all);
      next.set(key, run);
      return [all.get(key), next] as const;
    });
    if (previous !== undefined) {
      yield* previous.stop(
        problem(
          "commandFailed",
          "A newer Authorize for this server replaced this one.",
          "Finish the sign-in in the newest Authorize window.",
        ),
      );
    }

    // Idempotent: runs when the login ends and again when the stream closes (client gone).
    const release = Effect.gen(function* () {
      yield* Ref.update(runs, (all) => {
        if (all.get(key) !== run) return all;
        const next = new Map(all);
        next.delete(key);
        return next;
      });
      const id = sessionId;
      if (id !== null) {
        yield* Ref.update(sessions, (all) => {
          const next = new Map(all);
          next.delete(id);
          return next;
        });
      }
      if (process !== null && !exited) {
        const running = process;
        exited = true;
        yield* Effect.sync(() => running.kill()).pipe(Effect.ignore);
      }
    });
    yield* Effect.addFinalizer(() => release);

    const finish = Effect.fn("ForkExtensions.authorizeFinish")(function* (
      event: ForkAuthorizeEvent,
    ) {
      yield* release;
      yield* Queue.offer(events, event);
      yield* Queue.end(events);
    });

    const args = ["mcp", "login", "--no-browser", name];
    const command = yield* resolveSpawnCommand(agent.binaryPath, args, {
      env: agent.env,
      extendEnv: true,
      bypassNpmShim: true,
    });
    if (command.shell) {
      // A Windows script shim needs cmd.exe, which would re-parse the server name.
      return yield* finish({
        _tag: "failed",
        problem: problem(
          "unsupported",
          `${AGENT_DISPLAY_NAMES[agent.agent]} is installed as a script shim, so T3 can't run its login here.`,
          `Run \`${label}\` in a terminal on that machine.`,
        ),
      });
    }
    const hostEnvironment = yield* HostProcess.Environment;
    const cwd = yield* HostProcess.HomeDirectory;
    const spawned = yield* pty
      .spawn({
        shell: command.command,
        args: [...command.args],
        cwd,
        cols: PTY_COLUMNS,
        rows: PTY_ROWS,
        env: { ...hostEnvironment, ...agent.env },
      })
      .pipe(Effect.result);
    if (spawned._tag === "Failure") {
      const cause = spawned.failure.cause;
      const missing = isCommandMissingCause(cause) || /ENOENT|not found/i.test(String(cause));
      return yield* finish({
        _tag: "failed",
        problem: missing
          ? problem(
              "binaryNotFound",
              `${AGENT_DISPLAY_NAMES[agent.agent]} was not found on this machine (${agent.binaryPath}).`,
              `Install ${AGENT_DISPLAY_NAMES[agent.agent]} on this machine or set its path in Settings → Providers.`,
              String(cause),
            )
          : problem(
              "commandFailed",
              `Could not start \`${label}\`.`,
              `Run \`${label}\` in a terminal on that machine.`,
              spawned.failure.message,
            ),
      });
    }
    const child = spawned.success;
    process = child;
    const stopData = child.onData((text) => {
      Queue.offerUnsafe(inbox, { _tag: "data", text });
    });
    const stopExit = child.onExit((event) => {
      Queue.offerUnsafe(inbox, { _tag: "exit", code: event.exitCode });
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        stopData();
        stopExit();
      }),
    );
    yield* Effect.sleep(AUTHORIZE_SESSION_TTL).pipe(
      Effect.andThen(
        run.stop(
          problem(
            "timeout",
            "The authorization wasn't finished within 10 minutes.",
            "Click Authorize to start again.",
          ),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );

    const session: Session = {
      submit: (redirectUrl) =>
        Effect.sync(() => {
          if (exited) return;
          pasted.push(redirectUrl);
          // Enter, as typed in a terminal.
          child.write(`${redirectUrl}\r`);
        }),
    };
    const streamUrl = Effect.fn("ForkExtensions.authorizeStreamUrl")(function* (url: string) {
      const id = yield* newSessionId;
      sessionId = id;
      if (!exited) {
        yield* Ref.update(sessions, (all) => new Map(all).set(id, session));
      }
      yield* Queue.offer(events, { _tag: "authUrl", sessionId: id, url });
    });

    let output = "";
    while (true) {
      const event = yield* Queue.take(inbox);
      if (event._tag === "data") {
        if (output.length < OUTPUT_LIMIT) output += event.text;
        if (sessionId === null) {
          const url = extractAuthUrl(output, false);
          if (url !== null) yield* streamUrl(url);
        }
        continue;
      }
      if (event._tag === "stop") {
        return yield* finish({ _tag: "failed", problem: event.problem });
      }
      exited = true;
      if (sessionId === null) {
        const url = extractAuthUrl(output, true);
        if (url !== null) yield* streamUrl(url);
      }
      if (event.code === 0 && sessionId !== null) {
        yield* options.onDone(target);
        return yield* finish({ _tag: "done" });
      }
      const rawOutput = rawOutputOf(output, pasted);
      const tooOld = /(unexpected argument|unknown option)[^\n]*--no-browser/i.test(
        rawOutput ?? "",
      );
      return yield* finish({
        _tag: "failed",
        problem: problem(
          "commandFailed",
          sessionId === null
            ? `\`${label}\` ended without an authorization link (exit code ${event.code}).`
            : `\`${label}\` failed (exit code ${event.code}).`,
          tooOld
            ? `Update ${AGENT_DISPLAY_NAMES[agent.agent]} on that machine, or run \`${label}\` in a terminal there.`
            : "Read the output below, then click Authorize to try again.",
          rawOutput,
        ),
      });
    }
  });

  /**
   * One login: `authUrl` once its URL is printed, then `done` (exit 0) or `failed`.
   * Closing the stream kills the login.
   */
  const authorize = (
    agent: ResolvedAgent,
    target: AuthorizeTarget,
  ): Stream.Stream<ForkAuthorizeEvent, ForkExtensionsError> =>
    Stream.callback<ForkAuthorizeEvent, ForkExtensionsError>((events) =>
      Effect.gen(function* () {
        const name = mcpServerName(target.itemId);
        if (name === null) {
          return yield* fail(
            "invalidInput",
            "Only MCP servers can be authorized.",
            "Pick an MCP server row.",
          );
        }
        if (agent.agent === "codex" && isClaudeOnlyServer(name)) {
          return yield* fail(
            "unsupported",
            `"${name}" belongs to Claude Code, not Codex.`,
            "Authorize it in the Claude Code column.",
          );
        }
        yield* login(agent, target, name, events);
      }).pipe(Effect.withSpan("ForkExtensions.authorize")),
    );

  /** Types the pasted redirect address into the session's login. Never logged. */
  const authorizeComplete = Effect.fn("ForkExtensions.authorizeComplete")(function* (
    input: ForkAuthorizeCompleteInput,
  ) {
    const redirectUrl = parseRedirectUrl(input.redirectUrl);
    if (redirectUrl === null) {
      return yield* fail(
        "invalidInput",
        "That isn't a single web address.",
        "Copy the whole address from the browser's address bar after approving, then paste it.",
      );
    }
    const session = (yield* Ref.get(sessions)).get(input.sessionId);
    if (session === undefined) {
      return yield* fail(
        "notFound",
        "This authorization has ended or expired.",
        "Click Authorize to start again.",
      );
    }
    yield* session.submit(redirectUrl);
  });

  return { authorize, authorizeComplete };
});
