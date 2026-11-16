// Fork-only: the Dashboard's machines: this machine's load as a live stream, and the
// node_exporters the settings name for machines that do not run T3 Code.
import type {
  ForkNodeExporter,
  ForkNodeExporterReading,
  ForkNodeExportersStatus,
  HostResourcesSnapshot,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as HostResources from "../../resourceTelemetry/HostResources.ts";
import * as ServerSettings from "../../serverSettings.ts";
import {
  type CpuCounters,
  cpuUtilizationBetween,
  nodeExporterHost,
  nodeExporterResources,
  nodeExporterUrlProblem,
  parseNodeExporterMetrics,
} from "./nodeExporter.ts";

export class ForkMachines extends Context.Service<
  ForkMachines,
  {
    /** A fresh sample about every second, for as long as the caller listens. */
    readonly hostResources: Stream.Stream<HostResourcesSnapshot>;
    /** Never fails: an exporter that does not answer reads as a problem. */
    readonly nodeExporters: Effect.Effect<ForkNodeExportersStatus>;
  }
>()("t3/fork/machines/ForkMachines") {}

class NodeExporterTooLarge extends Schema.TaggedError<NodeExporterTooLarge>()(
  "NodeExporterTooLarge",
  {},
) {}

// The sample itself takes 200 ms, so a sample starts about every second.
const HOST_SAMPLE_SPACING = Duration.millis(800);
const SCRAPE_TIMEOUT = Duration.seconds(2);
const MAX_SCRAPE_BYTES = 4 * 1024 * 1024;
/** Readings older than this make a poor baseline; a fresh pair is taken instead. */
const BASELINE_MAX_AGE_MS = 60_000;
const BASELINE_GAP = Duration.millis(500);
/** Every open Dashboard asks every few seconds; clients on several devices share one read. */
const CACHE_TTL = Duration.seconds(2);

/** @public */
export const make = Effect.gen(function* () {
  const hostResources = yield* HostResources.HostResources;
  const settings = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const baselines = new Map<string, { readonly counters: CpuCounters; readonly atMs: number }>();

  const scrapeText = (url: string) =>
    httpClient.get(url, { headers: { accept: "text/plain" } }).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) =>
        Number(response.headers["content-length"] ?? 0) > MAX_SCRAPE_BYTES
          ? Effect.fail(new NodeExporterTooLarge())
          : response.text,
      ),
      Effect.timeout(SCRAPE_TIMEOUT),
    );

  const read = Effect.fn("ForkMachines.readExporter")(function* (exporter: ForkNodeExporter) {
    const base = { name: exporter.name, host: nodeExporterHost(exporter.url) };
    const refused = nodeExporterUrlProblem(exporter.url);
    if (refused !== null) {
      return { ...base, resources: null, problem: refused, latencyMs: null };
    }
    const startedAt = yield* Clock.currentTimeMillis;
    const text = yield* scrapeText(exporter.url).pipe(Effect.option);
    const answeredAt = yield* Clock.currentTimeMillis;
    if (text._tag === "None") {
      return { ...base, resources: null, problem: "The exporter did not answer.", latencyMs: null };
    }
    const metrics = parseNodeExporterMetrics(text.value);
    let previous = baselines.get(exporter.url);
    let latest = metrics;
    if (metrics.cpu !== null && (!previous || answeredAt - previous.atMs > BASELINE_MAX_AGE_MS)) {
      // Without a recent reading, a second one shortly after gives the load at once.
      yield* Effect.sleep(BASELINE_GAP);
      const again = yield* scrapeText(exporter.url).pipe(Effect.option);
      if (again._tag === "Some") {
        previous = { counters: metrics.cpu, atMs: answeredAt };
        latest = parseNodeExporterMetrics(again.value);
      }
    }
    const nowMs = yield* Clock.currentTimeMillis;
    if (latest.cpu !== null) baselines.set(exporter.url, { counters: latest.cpu, atMs: nowMs });
    const resources = nodeExporterResources(
      latest,
      cpuUtilizationBetween(previous?.counters ?? null, latest.cpu),
      nowMs,
    );
    return {
      ...base,
      resources,
      problem: resources === null ? "The exporter reported no CPU or memory." : null,
      latencyMs: answeredAt - startedAt,
    };
  });

  const readAll = Effect.fn("ForkMachines.readExporters")(function* () {
    const exporters = yield* settings.getSettings.pipe(
      Effect.map((current) => current.forkNodeExporters),
      Effect.orElseSucceed((): ReadonlyArray<ForkNodeExporter> => []),
    );
    const readings = yield* Effect.forEach(
      exporters,
      (exporter) =>
        read(exporter).pipe(
          Effect.catchCause((): Effect.Effect<ForkNodeExporterReading> =>
            Effect.succeed({
              name: exporter.name,
              host: nodeExporterHost(exporter.url),
              resources: null,
              problem: "The exporter could not be read.",
              latencyMs: null,
            }),
          ),
        ),
      { concurrency: 4 },
    );
    return { exporters: readings };
  });

  const cachedExporters = yield* Effect.cachedWithTTL(readAll(), CACHE_TTL);

  return ForkMachines.of({
    hostResources: Stream.fromEffectSchedule(
      hostResources.readFresh,
      Schedule.spaced(HOST_SAMPLE_SPACING),
    ),
    nodeExporters: cachedExporters,
  });
});

export const layer = Layer.effect(ForkMachines, make);
