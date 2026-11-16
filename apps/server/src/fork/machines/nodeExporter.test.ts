import { describe, expect, it } from "@effect/vitest";

import {
  cpuUtilizationBetween,
  nodeExporterResources,
  nodeExporterUrlProblem,
  parseNodeExporterMetrics,
} from "./nodeExporter.ts";

// node_exporter 1.8 on a 2-core Ubuntu VM, trimmed to the families around the ones read.
const SAMPLE = `# HELP node_cpu_guest_seconds_total Seconds the CPUs spent in guests (VMs) for each mode.
# TYPE node_cpu_guest_seconds_total counter
node_cpu_guest_seconds_total{cpu="0",mode="nice"} 0
node_cpu_guest_seconds_total{cpu="0",mode="user"} 0
# HELP node_cpu_seconds_total Seconds the CPUs spent in each mode.
# TYPE node_cpu_seconds_total counter
node_cpu_seconds_total{cpu="0",mode="idle"} 712934.21
node_cpu_seconds_total{cpu="0",mode="iowait"} 1532.14
node_cpu_seconds_total{cpu="0",mode="irq"} 0
node_cpu_seconds_total{cpu="0",mode="nice"} 12.5
node_cpu_seconds_total{cpu="0",mode="softirq"} 874.33
node_cpu_seconds_total{cpu="0",mode="steal"} 2210.07
node_cpu_seconds_total{cpu="0",mode="system"} 9123.4
node_cpu_seconds_total{cpu="0",mode="user"} 30817.92
node_cpu_seconds_total{cpu="1",mode="idle"} 713550.6
node_cpu_seconds_total{cpu="1",mode="iowait"} 1490.02
node_cpu_seconds_total{cpu="1",mode="irq"} 0
node_cpu_seconds_total{cpu="1",mode="nice"} 11.97
node_cpu_seconds_total{cpu="1",mode="softirq"} 801.45
node_cpu_seconds_total{cpu="1",mode="steal"} 2198.64
node_cpu_seconds_total{cpu="1",mode="system"} 9087.13
node_cpu_seconds_total{cpu="1",mode="user"} 30533.48
# HELP node_memory_MemAvailable_bytes Memory information field MemAvailable_bytes.
# TYPE node_memory_MemAvailable_bytes gauge
node_memory_MemAvailable_bytes 2.738683904e+09
# HELP node_memory_MemFree_bytes Memory information field MemFree_bytes.
# TYPE node_memory_MemFree_bytes gauge
node_memory_MemFree_bytes 3.12360960e+08
# HELP node_memory_MemTotal_bytes Memory information field MemTotal_bytes.
# TYPE node_memory_MemTotal_bytes gauge
node_memory_MemTotal_bytes 4.015427584e+09
# HELP node_scrape_collector_success node_exporter: Whether a collector succeeded.
# TYPE node_scrape_collector_success gauge
node_scrape_collector_success{collector="cpu"} 1
`;

describe("parseNodeExporterMetrics", () => {
  it("sums every core's CPU seconds and reads memory in exponent form", () => {
    const metrics = parseNodeExporterMetrics(SAMPLE);
    expect(metrics.cpuCount).toBe(2);
    expect(metrics.cpu?.idleSeconds).toBeCloseTo(712934.21 + 1532.14 + 713550.6 + 1490.02, 2);
    expect(metrics.cpu?.totalSeconds).toBeCloseTo(1_515_177.86, 2);
    expect(metrics.availableMemoryBytes).toBe(2_738_683_904);
    expect(metrics.totalMemoryBytes).toBe(4_015_427_584);
  });

  it("keeps what it can read from a partial or odd exposition", () => {
    expect(
      parseNodeExporterMetrics(
        'node_cpu_seconds_total{mode="idle"} 1\nnode_memory_MemTotal_bytes NaN\r\ngarbage\n',
      ),
    ).toEqual({ cpu: null, cpuCount: 0, availableMemoryBytes: null, totalMemoryBytes: null });
  });
});

describe("cpuUtilizationBetween", () => {
  it("is the busy share of the time that passed between two readings", () => {
    expect(
      cpuUtilizationBetween(
        { idleSeconds: 100, totalSeconds: 200 },
        { idleSeconds: 103, totalSeconds: 204 },
      ),
    ).toBeCloseTo(0.25);
  });

  it("says nothing without a forward step, as after an exporter restart", () => {
    expect(cpuUtilizationBetween(null, { idleSeconds: 1, totalSeconds: 2 })).toBe(null);
    expect(
      cpuUtilizationBetween(
        { idleSeconds: 100, totalSeconds: 200 },
        { idleSeconds: 3, totalSeconds: 4 },
      ),
    ).toBe(null);
    expect(
      cpuUtilizationBetween(
        { idleSeconds: 100, totalSeconds: 200 },
        { idleSeconds: 100, totalSeconds: 200 },
      ),
    ).toBe(null);
  });

  it("turns two readings into the machine's load, memory and cores", () => {
    const metrics = parseNodeExporterMetrics(SAMPLE);
    expect(nodeExporterResources(metrics, 0.25, 1_000)).toEqual({
      sampledAt: 1_000,
      cpuUtilization: 0.25,
      cpuCount: 2,
      availableMemoryBytes: 2_738_683_904,
      totalMemoryBytes: 4_015_427_584,
    });
  });
});

describe("nodeExporterUrlProblem", () => {
  it.each([
    ["http://100.96.210.49:9100/metrics", null],
    ["http://prod-cx43.tail0.ts.net:9100/metrics", null],
    ["http://[fd7a:115c:a1e0::5]:9100/metrics", null],
    ["https://100.96.210.49:9100/metrics", "Only http URLs are read."],
    ["http://user:pass@100.96.210.49:9100/metrics", "URLs with credentials are not read."],
    ["http://192.168.1.10:9100/metrics", "Only Tailscale addresses"],
    ["http://169.254.169.254/latest/meta-data", "Only Tailscale addresses"],
    ["http://127.0.0.1:9100/metrics", "Only Tailscale addresses"],
    ["http://prod-cx43:9100/metrics", "Only Tailscale addresses"],
    ["http://example.com/metrics", "Only Tailscale addresses"],
    ["http://100.128.0.1:9100/metrics", "Only Tailscale addresses"],
    ["not a url", "Not a URL."],
  ])("%s", (url, problem) => {
    const answer = nodeExporterUrlProblem(url);
    if (problem === null) expect(answer).toBe(null);
    else expect(answer).toContain(problem);
  });
});
