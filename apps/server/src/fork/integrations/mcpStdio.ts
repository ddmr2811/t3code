// Relays foreign JSON-RPC, which no schema of ours describes.
// @effect-diagnostics globalJsonInEffect:off
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

export interface StdioMcpProcess {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** The whole environment of the process: nothing of the server's own is inherited. */
  readonly env: Readonly<Record<string, string>>;
}

/** Never carries the process's output or environment, which may hold its credential. */
export class StdioMcpError extends Schema.TaggedError<StdioMcpError>()("StdioMcpError", {
  message: Schema.String,
}) {}

interface Reply {
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly message?: unknown };
}

/** A line that is not JSON is the process talking to itself, not an answer. */
function parseReply(line: string): Reply {
  try {
    return JSON.parse(line) as Reply;
  } catch {
    return {};
  }
}

const REQUEST_TIMEOUT = "60 seconds";

/**
 * One MCP server process for the life of the scope, asked one request at a time. Its stderr is
 * dropped, not logged.
 */
export const openStdioMcp = Effect.fn("ForkIntegrations.openStdioMcp")(function* (
  process: StdioMcpProcess,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const name = process.command.replace(/^.*[\\/]/, "");
  const child = yield* spawner
    .spawn(
      ChildProcess.make(process.command, [...process.args], {
        env: process.env,
        extendEnv: false,
        stdin: { stream: "pipe", endOnDone: false },
        stdout: "pipe",
        stderr: "ignore",
        forceKillAfter: "1 second",
      }),
    )
    .pipe(
      Effect.mapError(
        () => new StdioMcpError({ message: `Could not start ${name}. Is it installed?` }),
      ),
    );
  const lines = yield* Queue.unbounded<string | null>();
  yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) => Queue.offer(lines, line)),
    Effect.ignore,
    // Null marks the end: the process stopped, so nothing more will answer.
    Effect.ensuring(Queue.offer(lines, null)),
    Effect.forkScoped,
  );
  const send = (message: object) =>
    Stream.run(Stream.encodeText(Stream.make(`${JSON.stringify(message)}\n`)), child.stdin).pipe(
      Effect.mapError(() => new StdioMcpError({ message: `${name} stopped before it was asked.` })),
    );

  let nextId = 0;
  const request = Effect.fn("ForkIntegrations.stdioMcpRequest")(function* (
    method: string,
    params: object,
  ) {
    const id = ++nextId;
    yield* send({ jsonrpc: "2.0", id, method, params });
    while (true) {
      const line = yield* Queue.take(lines).pipe(Effect.timeoutOption(REQUEST_TIMEOUT));
      if (line._tag === "None" || line.value === null) {
        return yield* new StdioMcpError({ message: `${name} gave no answer to ${method}.` });
      }
      const reply = parseReply(line.value);
      if (reply.id !== id) continue;
      if (reply.error !== undefined) {
        return yield* new StdioMcpError({
          message: `${name} refused ${method}: ${String(reply.error.message)}`,
        });
      }
      return reply.result;
    }
  });

  yield* request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "t3code", version: "1" },
  });
  yield* send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return { request };
});
