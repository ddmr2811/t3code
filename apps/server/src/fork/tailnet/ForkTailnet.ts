// Fork-only: the tailnet as this machine's Tailscale client sees it, for the Dashboard.
// It only runs the local `tailscale` CLI; it never connects to the other machines.
import type { ForkTailnetStatus, ForkTailnetStatusInput } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../../processRunner.ts";
import {
  parseTailscalePing,
  parseTailscaleStatus,
  pingAddress,
  withPong,
} from "./tailscaleStatus.ts";

export class ForkTailnet extends Context.Service<
  ForkTailnet,
  {
    /** Never fails: a missing or stopped Tailscale answers `available: false`. */
    readonly status: (input: ForkTailnetStatusInput) => Effect.Effect<ForkTailnetStatus>;
  }
>()("t3/fork/tailnet/ForkTailnet") {}

const STATUS_TIMEOUT = Duration.seconds(5);
const PING_TIMEOUT_SECONDS = 2;
const PING_CONCURRENCY = 4;
/** Every open Dashboard asks every 45 s; clients on several devices share one read. */
const CACHE_TTL = Duration.seconds(20);

/** @public */
export const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;

  const readStatus = Effect.fn("ForkTailnet.readStatus")(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const unavailable = (problem: string): ForkTailnetStatus => ({
      checkedAt,
      available: false,
      problem,
      self: null,
      peers: [],
    });
    const output = yield* runner
      .run({ command: "tailscale", args: ["status", "--json"], timeout: STATUS_TIMEOUT })
      .pipe(Effect.option);
    if (output._tag === "None") return unavailable("Tailscale is not installed on this machine.");
    const { stdout, stderr, code, timedOut } = output.value;
    if (timedOut) return unavailable("Tailscale did not answer.");
    if (code !== 0 && stdout.trim() === "") {
      return unavailable(stderr.trim().split("\n")[0] || "Tailscale could not report its status.");
    }
    const parsed = parseTailscaleStatus(stdout);
    if (!parsed.available) return unavailable(parsed.problem);
    return { checkedAt, available: true, problem: null, self: parsed.self, peers: parsed.peers };
  });

  // Without --until-direct=false a relayed pong exits 1 and waits for a direct path first.
  // Any failure, a defect included, costs only this peer's latency, never the whole read.
  const ping = Effect.fn("ForkTailnet.ping")(function* (address: string) {
    return yield* runner
      .run({
        command: "tailscale",
        args: [
          "ping",
          "-c",
          "1",
          "--until-direct=false",
          `--timeout=${PING_TIMEOUT_SECONDS}s`,
          address,
        ],
        timeout: Duration.seconds(PING_TIMEOUT_SECONDS + 2),
        timeoutBehavior: "timedOutResult",
      })
      .pipe(
        Effect.map((output) => parseTailscalePing(`${output.stdout}\n${output.stderr}`)),
        Effect.catchCause(() => Effect.succeed(null)),
      );
  });

  const readWithPings = Effect.fn("ForkTailnet.readWithPings")(function* () {
    const status = yield* readStatus();
    const peers = yield* Effect.forEach(
      status.peers,
      (peer) => {
        const address = pingAddress(peer);
        return address === null
          ? Effect.succeed(peer)
          : ping(address).pipe(Effect.map((pong) => withPong(peer, pong)));
      },
      { concurrency: PING_CONCURRENCY },
    );
    return { ...status, peers };
  });

  const cachedStatus = yield* Effect.cachedWithTTL(readStatus(), CACHE_TTL);
  const cachedWithPings = yield* Effect.cachedWithTTL(readWithPings(), CACHE_TTL);

  return ForkTailnet.of({
    status: Effect.fn("ForkTailnet.status")(function* (input) {
      return yield* input.ping === true ? cachedWithPings : cachedStatus;
    }),
  });
});

export const layer = Layer.effect(ForkTailnet, make).pipe(Layer.provide(ProcessRunner.layer));
