import { describe, expect, it } from "vite-plus/test";

import {
  appendCpuSample,
  cpuSparklinePath,
  FORK_WIDGET_CPU_SAMPLES,
  forkWaitingReason,
  forkWidgetDefaultSize,
  forkWidgetScale,
  forkWidgetTopProcesses,
  parseForkWidgetBounds,
  parseForkWidgetCollapsed,
} from "./ForkResourceWidget.logic";

describe("forkWidgetScale", () => {
  // Two machines with their details closed, at natural size.
  const rows = { width: 620, height: 136 };

  it("leaves the rows at their natural size in a window that just holds them", () => {
    expect(forkWidgetScale({ ...rows, machineCount: 2 })).toBe(1);
  });

  it("grows the content with the window", () => {
    expect(
      forkWidgetScale({ width: rows.width * 2, height: rows.height * 2, machineCount: 2 }),
    ).toBe(2);
  });

  it("is held back by whichever side has less room", () => {
    expect(forkWidgetScale({ width: 4000, height: rows.height, machineCount: 2 })).toBe(1);
    expect(forkWidgetScale({ width: rows.width, height: 4000, machineCount: 2 })).toBe(1);
  });

  it("shrinks so that more machines still fit", () => {
    expect(forkWidgetScale({ ...rows, machineCount: 4 })).toBeLessThan(1);
  });

  it("stays within sane limits", () => {
    expect(forkWidgetScale({ width: 10, height: 10, machineCount: 2 })).toBe(0.6);
    expect(forkWidgetScale({ width: 9000, height: 9000, machineCount: 1 })).toBe(3);
    expect(forkWidgetScale({ width: 0, height: 0, machineCount: 0 })).toBe(1);
  });

  it("fits open details when the window has room for them", () => {
    const open = forkWidgetDefaultSize(2);
    expect(forkWidgetScale({ ...open, machineCount: 2, detailCount: 2 })).toBe(1);
    expect(
      forkWidgetScale({
        width: open.width * 2,
        height: open.height * 2,
        machineCount: 2,
        detailCount: 2,
      }),
    ).toBe(2);
  });

  it("lets open details scroll rather than shrink the widget below natural size", () => {
    expect(forkWidgetScale({ width: 980, height: 430, machineCount: 2, detailCount: 2 })).toBe(1);
  });

  it("still shrinks when the rows themselves do not fit", () => {
    expect(
      forkWidgetScale({ width: 400, height: 136, machineCount: 2, detailCount: 2 }),
    ).toBeLessThan(1);
  });
});

describe("forkWidgetDefaultSize", () => {
  it("makes room for every machine and its details", () => {
    expect(forkWidgetDefaultSize(5).height).toBeGreaterThan(forkWidgetDefaultSize(2).height);
    expect(forkWidgetScale({ ...forkWidgetDefaultSize(5), machineCount: 5, detailCount: 5 })).toBe(
      1,
    );
  });
});

describe("parseForkWidgetCollapsed", () => {
  it("reads the machines whose details were closed", () => {
    expect(parseForkWidgetCollapsed('["a","b"]')).toEqual(["a", "b"]);
  });

  it("treats anything malformed as none closed", () => {
    expect(parseForkWidgetCollapsed(null)).toEqual([]);
    expect(parseForkWidgetCollapsed("{")).toEqual([]);
    expect(parseForkWidgetCollapsed('{"a":1}')).toEqual([]);
    expect(parseForkWidgetCollapsed('["a",3,null]')).toEqual(["a"]);
  });
});

describe("parseForkWidgetBounds", () => {
  it("reads a position saved before sizes were remembered", () => {
    expect(parseForkWidgetBounds('{"left":10,"top":20}')).toEqual({ left: 10, top: 20 });
  });

  it("reads a position with its size", () => {
    expect(parseForkWidgetBounds('{"left":10,"top":20,"width":700,"height":300}')).toEqual({
      left: 10,
      top: 20,
      width: 700,
      height: 300,
    });
  });

  it("drops a size smaller than the window can be", () => {
    expect(parseForkWidgetBounds('{"left":1,"top":2,"width":50,"height":300}')).toEqual({
      left: 1,
      top: 2,
    });
  });

  it("ignores anything malformed", () => {
    expect(parseForkWidgetBounds(null)).toBeNull();
    expect(parseForkWidgetBounds("not json")).toBeNull();
    expect(parseForkWidgetBounds('{"left":"a","top":2}')).toBeNull();
  });
});

describe("CPU chart", () => {
  it("keeps only the samples that fit the chart", () => {
    let samples: ReadonlyArray<number> = [];
    for (let index = 0; index < FORK_WIDGET_CPU_SAMPLES + 10; index++) {
      samples = appendCpuSample(samples, index / 1000);
    }
    expect(samples).toHaveLength(FORK_WIDGET_CPU_SAMPLES);
    expect(samples.at(-1)).toBeCloseTo((FORK_WIDGET_CPU_SAMPLES + 9) / 1000);
  });

  it("keeps a sample inside the machine's range", () => {
    expect(appendCpuSample([], 1.4)).toEqual([1]);
    expect(appendCpuSample([], -1)).toEqual([0]);
    expect(appendCpuSample([], Number.NaN)).toEqual([0]);
  });

  it("draws nothing until there is a line to draw", () => {
    expect(cpuSparklinePath([], 56, 16)).toBe("");
    expect(cpuSparklinePath([0.5], 56, 16)).toBe("");
  });

  it("ends at the right edge, with a busy machine at the top", () => {
    const path = cpuSparklinePath([0, 1], 56, 16);
    expect(path.startsWith("M")).toBe(true);
    expect(path.endsWith("L56,0")).toBe(true);
  });

  it("spans the whole width once full", () => {
    const full = Array.from({ length: FORK_WIDGET_CPU_SAMPLES }, () => 0);
    expect(cpuSparklinePath(full, 56, 16).startsWith("M0,16")).toBe(true);
  });
});

describe("forkWidgetTopProcesses", () => {
  const process = (
    pid: number,
    name: string,
    category: Parameters<typeof forkWidgetTopProcesses>[0][number]["category"],
    cpuPercent: number,
    residentBytes: number,
  ) => ({
    identity: { pid, startTimeMs: 0 },
    name,
    command: "",
    category,
    cpuPercent,
    residentBytes,
    ioReadBytesPerSecond: pid * 10,
    ioWriteBytesPerSecond: pid * 100,
  });

  it("lists the busiest processes first, then the largest", () => {
    const top = forkWidgetTopProcesses(
      [
        process(1, "bash", "terminal-root", 0, 10),
        process(2, "claude.exe", "provider-root", 40, 900),
        process(3, "pytest", "server-child", 2, 500),
        process(4, "node.exe", "server-child", 2, 300),
      ],
      3,
    );
    expect(top.map((entry) => entry.name)).toEqual(["claude", "pytest", "node"]);
    expect(top[0]).toEqual({
      pid: 2,
      name: "claude",
      cpuPercent: 40,
      residentBytes: 900,
      readBytesPerSecond: 20,
      writeBytesPerSecond: 200,
    });
  });

  it("names the app's own processes by what they are", () => {
    const top = forkWidgetTopProcesses(
      [
        process(1, "T3 Code Fork (Beta).exe", "server", 5, 1),
        process(2, "T3 Code Fork (Beta).exe", "electron-renderer", 4, 1),
        process(3, "T3 Code Fork (Beta).exe", "electron-main", 3, 1),
        process(4, "t3-resource-monitor.exe", "resource-monitor", 2, 1),
      ],
      10,
    );
    expect(top.map((entry) => entry.name)).toEqual([
      "T3 server",
      "App window",
      "App",
      "Resource monitor",
    ]);
  });

  it("names a process by its command when it has no name", () => {
    const [entry] = forkWidgetTopProcesses(
      [{ ...process(1, " ", "server-child", 1, 1), command: '"C:\\tools\\rg.exe" --files' }],
      1,
    );
    expect(entry?.name).toBe("rg");
  });
});

describe("forkWaitingReason", () => {
  const thread = (
    overrides: Partial<Parameters<typeof forkWaitingReason>[0]> = {},
  ): Parameters<typeof forkWaitingReason>[0] => ({
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    pendingGuestMessageCount: 0,
    interactionMode: "default",
    latestRun: null,
    runtime: null,
    ...overrides,
  });
  const run = (status: string) =>
    ({ status }) as NonNullable<Parameters<typeof forkWaitingReason>[0]["latestRun"]>;

  it("lets an approval be answered from the widget", () => {
    expect(forkWaitingReason(thread({ hasPendingApprovals: true }))).toMatchObject({
      label: "Needs approval",
      answerable: true,
      dismissible: false,
    });
    expect(forkWaitingReason(thread({ pendingSubagentRequest: "approval" }))).toMatchObject({
      label: "Subagent needs approval",
      answerable: true,
    });
  });

  it("sends questions and plans to the thread", () => {
    for (const waiting of [
      thread({ hasPendingUserInput: true }),
      thread({ pendingSubagentRequest: "user_input" }),
      thread({ pendingGuestMessageCount: 2 }),
      thread({ interactionMode: "plan", hasActionableProposedPlan: true }),
    ]) {
      expect(forkWaitingReason(waiting)).toMatchObject({ answerable: false, dismissible: false });
    }
  });

  it("puts a pending request before the way the last run ended", () => {
    expect(
      forkWaitingReason(thread({ hasPendingApprovals: true, latestRun: run("interrupted") })).label,
    ).toBe("Needs approval");
  });

  it("lets a thread that only ended badly be marked done", () => {
    expect(forkWaitingReason(thread({ latestRun: run("interrupted") }))).toEqual({
      label: "Interrupted",
      answerable: false,
      dismissible: true,
      detail: null,
    });
    expect(forkWaitingReason(thread({ latestRun: run("failed") })).label).toBe("Failed");
    expect(forkWaitingReason(thread()).label).toBe("Not started");
  });

  it("shows the error a thread stopped on", () => {
    const runtime = { lastError: "rate limited" } as NonNullable<
      Parameters<typeof forkWaitingReason>[0]["runtime"]
    >;
    expect(forkWaitingReason(thread({ runtime, latestRun: run("completed") }))).toMatchObject({
      label: "Error",
      detail: "rate limited",
      dismissible: true,
    });
  });
});
