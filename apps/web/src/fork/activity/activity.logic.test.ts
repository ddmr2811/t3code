import type { EnvironmentId, ForkActivityEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { filterOptions, filterRows, groupByDay, mergeFeeds, NO_FILTERS } from "./activity.logic";

const A = "env-a" as EnvironmentId;
const B = "env-b" as EnvironmentId;

const entry = (
  id: string,
  at: string,
  extra: Partial<ForkActivityEntry> = {},
): ForkActivityEntry => ({
  id,
  at,
  source: "log",
  actor: "worker",
  summary: id,
  status: "ok",
  ...extra,
});

const feeds = [
  {
    environmentId: A,
    machine: "dev-cx53",
    entries: [
      entry("a1", "2026-11-17T09:00:00.000Z", { project: "Nexo" }),
      entry("a2", "2026-11-16T22:30:00.000Z", { project: "Fork", status: "error" }),
    ],
  },
  {
    environmentId: B,
    machine: "laptop",
    entries: [
      // The same id on another machine is another entry.
      entry("a1", "2026-11-17T08:00:00.000Z", { project: "Fork" }),
      entry("b2", "2026-11-15T10:00:00.000Z"),
    ],
  },
];

describe("mergeFeeds", () => {
  it("merges machines newest first, keyed by machine, and keeps the newest when limited", () => {
    const rows = mergeFeeds(feeds);
    expect(rows.map((row) => [row.key, row.machine])).toEqual([
      ["env-a:a1", "dev-cx53"],
      ["env-b:a1", "laptop"],
      ["env-a:a2", "dev-cx53"],
      ["env-b:b2", "laptop"],
    ]);
    expect(mergeFeeds(feeds, 2).map((row) => row.key)).toEqual(["env-a:a1", "env-b:a1"]);
  });
});

describe("filters", () => {
  const rows = mergeFeeds(feeds);

  it("narrows by project, machine and errors, together", () => {
    expect(filterRows(rows, NO_FILTERS)).toHaveLength(4);
    expect(filterRows(rows, { ...NO_FILTERS, project: "Fork" }).map((row) => row.key)).toEqual([
      "env-b:a1",
      "env-a:a2",
    ]);
    expect(filterRows(rows, { ...NO_FILTERS, machine: B }).map((row) => row.key)).toEqual([
      "env-b:a1",
      "env-b:b2",
    ]);
    expect(
      filterRows(rows, { project: "Fork", machine: A, errorsOnly: true }).map((row) => row.key),
    ).toEqual(["env-a:a2"]);
    expect(
      filterRows(rows, { ...NO_FILTERS, project: "Fork", machine: B, errorsOnly: true }),
    ).toEqual([]);
  });

  it("offers every machine asked and keeps a saved choice that is gone, so it can be cleared", () => {
    const machines = [
      { environmentId: B, label: "laptop" },
      { environmentId: A, label: "dev-cx53" },
    ];
    expect(filterOptions(rows, machines, NO_FILTERS)).toEqual({
      projects: ["Fork", "Nexo"],
      machines: [
        { environmentId: A, label: "dev-cx53" },
        { environmentId: B, label: "laptop" },
      ],
    });
    const stale = filterOptions(rows, machines, {
      project: "Old",
      machine: "env-gone",
      errorsOnly: false,
    });
    expect(stale.projects).toEqual(["Fork", "Nexo", "Old"]);
    expect(stale.machines.at(-1)).toEqual({
      environmentId: "env-gone",
      label: "Disconnected machine",
    });
  });
});

describe("groupByDay", () => {
  it("splits at the viewer's midnight and names today and yesterday", () => {
    const rows = mergeFeeds(feeds);
    const now = Date.parse("2026-11-17T12:00:00.000Z");
    const madrid = groupByDay(rows, now, "Europe/Madrid");
    expect(madrid.map((group) => [group.label, group.rows.length])).toEqual([
      ["Today", 2],
      // 22:30 UTC is 23:30 in Madrid: still the 16th.
      ["Yesterday", 1],
      ["Sunday 15 November", 1],
    ]);
    const tokyo = groupByDay(rows, now, "Asia/Tokyo");
    // 22:30 UTC on the 16th is 07:30 on the 17th in Tokyo.
    expect(tokyo.map((group) => [group.day, group.rows.length])).toEqual([
      ["2026-11-17", 3],
      ["2026-11-15", 1],
    ]);
  });
});
