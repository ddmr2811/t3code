import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../../processRunner.ts";
import * as ForkTailnet from "./ForkTailnet.ts";

const output = (stdout: string, code = 0): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const STATUS = JSON.stringify({
  BackendState: "Running",
  Self: { ID: "nSelf", HostName: "dev-box", DNSName: "dev-box.ts.net.", OS: "linux" },
  Peer: {
    a: {
      ID: "nProd",
      HostName: "prod-box",
      OS: "linux",
      TailscaleIPs: ["100.64.0.2"],
      Online: true,
      Relay: "hel",
    },
    b: {
      ID: "nPhone",
      HostName: "Phone",
      OS: "android",
      TailscaleIPs: ["100.64.0.4"],
      Online: true,
    },
    c: {
      ID: "nOld",
      HostName: "old-box",
      OS: "linux",
      TailscaleIPs: ["100.64.0.5"],
      Online: false,
    },
  },
});

type Behavior = "running" | "missing" | "failing";

const runnerLayer = (calls: Ref.Ref<ReadonlyArray<string>>, behavior: Behavior) =>
  Layer.succeed(
    ProcessRunner.ProcessRunner,
    ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Ref.update(calls, (all) => [...all, [input.command, ...input.args].join(" ")]).pipe(
          Effect.andThen(() => {
            if (behavior === "missing") {
              return Effect.fail(
                new ProcessRunner.ProcessSpawnError({
                  command: input.command,
                  argumentCount: input.args.length,
                  cause: PlatformError.systemError({
                    _tag: "NotFound",
                    module: "ChildProcess",
                    method: "spawn",
                  }),
                }),
              );
            }
            if (behavior === "failing") {
              return Effect.succeed({
                ...output("", 1),
                stderr: "failed to connect to local tailscaled; it doesn't appear to be running",
              });
            }
            if (input.args[0] === "ping") {
              return Effect.succeed(
                output("pong from prod-box (100.64.0.2) via DERP(hel) in 83ms\n", 1),
              );
            }
            return Effect.succeed(output(STATUS));
          }),
        ),
    }),
  );

const run = (
  behavior: Behavior,
  program: (
    calls: Ref.Ref<ReadonlyArray<string>>,
  ) => Effect.Effect<void, never, ForkTailnet.ForkTailnet>,
) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    yield* program(calls).pipe(
      Effect.provide(
        Layer.effect(ForkTailnet.ForkTailnet, ForkTailnet.make).pipe(
          Layer.provide(runnerLayer(calls, behavior)),
        ),
      ),
    );
  });

describe("ForkTailnet", () => {
  it.effect("reads the status without pinging unless asked", () =>
    run("running", (calls) =>
      Effect.gen(function* () {
        const tailnet = yield* ForkTailnet.ForkTailnet;
        const status = yield* tailnet.status({});
        expect(status.available).toBe(true);
        expect(status.self?.hostName).toBe("dev-box");
        expect(status.peers.map((peer) => [peer.hostName, peer.latencyMs])).toEqual([
          ["Phone", null],
          ["prod-box", null],
          ["old-box", null],
        ]);
        expect(yield* Ref.get(calls)).toEqual(["tailscale status --json"]);
      }),
    ),
  );

  it.effect("pings only online computers, and shares one read between callers", () =>
    run("running", (calls) =>
      Effect.gen(function* () {
        const tailnet = yield* ForkTailnet.ForkTailnet;
        const status = yield* tailnet.status({ ping: true });
        yield* tailnet.status({ ping: true });
        const prod = status.peers.find((peer) => peer.hostName === "prod-box");
        expect(prod).toMatchObject({ latencyMs: 83, connection: "relay", relay: "hel" });
        expect(yield* Ref.get(calls)).toEqual([
          "tailscale status --json",
          "tailscale ping -c 1 --timeout=2s 100.64.0.2",
        ]);
      }),
    ),
  );

  it.effect("answers unavailable when tailscale is missing", () =>
    run("missing", () =>
      Effect.gen(function* () {
        const status = yield* (yield* ForkTailnet.ForkTailnet).status({ ping: true });
        expect(status).toMatchObject({
          available: false,
          problem: "Tailscale is not installed on this machine.",
          self: null,
          peers: [],
        });
      }),
    ),
  );

  it.effect("answers unavailable with the CLI's reason when tailscaled is down", () =>
    run("failing", () =>
      Effect.gen(function* () {
        const status = yield* (yield* ForkTailnet.ForkTailnet).status({});
        expect(status).toMatchObject({
          available: false,
          problem: "failed to connect to local tailscaled; it doesn't appear to be running",
        });
      }),
    ),
  );
});
