import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient } from "effect/http";

import * as HostResources from "../../resourceTelemetry/HostResources.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ForkMachines from "./ForkMachines.ts";

const machinesWith = (reads: Ref.Ref<number>) =>
  Layer.effect(ForkMachines.ForkMachines, ForkMachines.make).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          HostResources.HostResources,
          HostResources.HostResources.of({
            read: Effect.die("the stream reads fresh samples"),
            readFresh: Ref.updateAndGet(reads, (count) => count + 1).pipe(
              Effect.map((count) => ({
                sampledAt: count,
                cpuUtilization: 0.5,
                cpuCount: 4,
                availableMemoryBytes: 1,
                totalMemoryBytes: 2,
              })),
            ),
          }),
        ),
        ServerSettings.layerTest(),
        FetchHttpClient.layer,
      ),
    ),
  );

describe("ForkMachines.hostResources", () => {
  it.effect("shares one sampler between listeners, one read per cycle", () =>
    Effect.gen(function* () {
      const reads = yield* Ref.make(0);
      yield* Effect.gen(function* () {
        const machines = yield* ForkMachines.ForkMachines;
        const listen = machines.hostResources.pipe(
          Stream.map((sample) => sample.sampledAt),
          Stream.take(3),
          Stream.runCollect,
          Effect.forkChild,
        );
        const first = yield* listen;
        const second = yield* listen;
        yield* TestClock.adjust("800 millis");
        yield* TestClock.adjust("800 millis");
        const [left, right] = [yield* Fiber.join(first), yield* Fiber.join(second)];
        expect(left).toEqual([1, 2, 3]);
        expect(right).toEqual([1, 2, 3]);
        expect(yield* Ref.get(reads)).toBe(3);
      }).pipe(Effect.provide(machinesWith(reads)));
    }),
  );
});
