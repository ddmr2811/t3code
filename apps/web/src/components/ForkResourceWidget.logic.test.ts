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
} from "./ForkResourceWidget.logic";

describe("forkWidgetScale", () => {
  const natural = forkWidgetDefaultSize(2);

  it("leaves the default window at its natural size", () => {
    expect(forkWidgetScale({ ...natural, machineCount: 2 })).toBe(1);
  });

  it("grows the content with the window", () => {
    expect(
      forkWidgetScale({ width: natural.width * 2, height: natural.height * 2, machineCount: 2 }),
    ).toBe(2);
  });

  it("is held back by whichever side has less room", () => {
    expect(forkWidgetScale({ width: 4000, height: natural.height, machineCount: 2 })).toBe(1);
    expect(forkWidgetScale({ width: natural.width, height: 4000, machineCount: 2 })).toBe(1);
  });

  it("shrinks so that more machines still fit", () => {
    expect(forkWidgetScale({ ...natural, machineCount: 4 })).toBeLessThan(1);
  });

  it("stays within sane limits", () => {
    expect(forkWidgetScale({ width: 10, height: 10, machineCount: 2 })).toBe(0.6);
    expect(forkWidgetScale({ width: 9000, height: 9000, machineCount: 1 })).toBe(3);
    expect(forkWidgetScale({ width: 0, height: 0, machineCount: 0 })).toBe(1);
  });
});

describe("forkWidgetDefaultSize", () => {
  it("makes room for every machine", () => {
    expect(forkWidgetDefaultSize(5).height).toBeGreaterThan(forkWidgetDefaultSize(2).height);
    expect(forkWidgetScale({ ...forkWidgetDefaultSize(5), machineCount: 5 })).toBe(1);
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
  });

  it("lists the heaviest server-side processes first", () => {
    const top = forkWidgetTopProcesses(
      [
        process(1, "node.exe", "server", 2, 300),
        process(2, "claude.exe", "provider-root", 40, 900),
        process(3, "pytest", "server-child", 2, 500),
        process(4, "bash", "terminal-root", 0, 10),
      ],
      3,
    );
    expect(top.map((entry) => entry.name)).toEqual(["claude", "pytest", "T3 server"]);
    expect(top[0]).toMatchObject({ pid: 2, cpuPercent: 40, residentBytes: 900 });
  });

  it("leaves out the desktop app and the monitor", () => {
    const top = forkWidgetTopProcesses(
      [
        process(1, "T3 Code", "electron-renderer", 90, 900),
        process(2, "t3-resource-monitor", "resource-monitor", 50, 900),
        process(3, "node", "server", 1, 100),
      ],
      3,
    );
    expect(top.map((entry) => entry.pid)).toEqual([3]);
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
