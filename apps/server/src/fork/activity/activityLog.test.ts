import { describe, expect, it } from "@effect/vitest";

import { parseActivityLog } from "./activityLog.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const SINCE = Date.parse("2026-11-16T00:00:00Z");

const line = (fields: Record<string, unknown>) => JSON.stringify(fields);

describe("parseActivityLog", () => {
  it("keeps valid lines and skips broken, foreign, old and unknown-state ones", () => {
    const text = [
      line({
        ts: "2026-11-17T04:00:00Z",
        proyecto: "nexo",
        quien: "orquestador",
        que: "Tanda pesado: vitest",
        estado: "ok",
      }),
      "{not json",
      "[1, 2]",
      line({ ts: "not a date", que: "x", estado: "ok" }),
      line({ ts: "2026-11-15T23:59:59Z", que: "too old", estado: "ok" }),
      line({ ts: "2026-11-17T04:05:00Z", que: "no state" }),
      line({ ts: "2026-11-17T04:06:00Z", que: "odd state", estado: "maybe" }),
      line({ ts: "2026-11-17T04:07:00Z", que: "   ", estado: "ok" }),
      "",
      line({
        ts: "2026-11-17T04:10:00+01:00",
        quien: "Dani",
        que: "Modo noche: ON\nsecond line",
        estado: "en curso",
      }),
    ].join("\n");
    const entries = parseActivityLog("actividad-dev-cx53.jsonl", encode(text), 0, SINCE);
    expect(entries).toEqual([
      {
        id: "log:actividad-dev-cx53.jsonl:0",
        at: "2026-11-17T04:00:00.000Z",
        source: "log",
        project: "nexo",
        actor: "orchestrator",
        summary: "Tanda pesado: vitest",
        status: "ok",
      },
      {
        id: expect.stringMatching(/^log:actividad-dev-cx53\.jsonl:\d+$/),
        at: "2026-11-17T03:10:00.000Z",
        source: "log",
        actor: "user",
        summary: "Modo noche: ON",
        status: "running",
      },
    ]);
  });

  it("drops the partial first line of a tail and ids lines by their offset in the file", () => {
    const first = line({ ts: "2026-11-17T01:00:00Z", que: "cut", estado: "ok" });
    const second = line({
      ts: "2026-11-17T02:00:00Z",
      que: "whole",
      quien: "worker",
      estado: "error",
    });
    const file = `${first}\n${second}\n`;
    const offset = 10;
    const entries = parseActivityLog(
      "actividad-a.jsonl",
      encode(file).subarray(offset),
      offset,
      SINCE,
    );
    expect(entries.map((entry) => [entry.id, entry.summary, entry.actor, entry.status])).toEqual([
      [`log:actividad-a.jsonl:${first.length + 1}`, "whole", "worker", "error"],
    ]);
    expect(parseActivityLog("actividad-a.jsonl", encode("no newline at all"), 5, SINCE)).toEqual(
      [],
    );
  });

  it("masks secrets a line carries", () => {
    const entries = parseActivityLog(
      "actividad-a.jsonl",
      encode(
        line({
          ts: "2026-11-17T01:00:00Z",
          que: "rotated GH_TOKEN=ghp_0123456789abcdefghij",
          estado: "ok",
        }),
      ),
      0,
      SINCE,
    );
    expect(entries[0]!.summary).toBe("rotated GH_TOKEN=•••");
  });
});
