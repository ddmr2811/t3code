import { describe, expect, it } from "@effect/vitest";

import { aonEntry, type AonEventRow } from "./aonActivity.ts";
import { runStatus, threadActor, wordActor, wordStatus } from "./classify.ts";
import { commitEntry, parseGitLog, pickDevRef } from "./gitActivity.ts";
import { commandMatches, commandSummary, parsePesadoWho, pesadoEntry } from "./pesadoActivity.ts";

const origin = {
  createdBy: "agent",
  relationshipToParent: null,
  delegated: false,
  scheduled: false,
};

describe("threadActor", () => {
  it.each([
    ["a top-level thread an agent made", origin, "orchestrator"],
    ["a subagent", { ...origin, relationshipToParent: "subagent" }, "worker"],
    ["a delegated task", { ...origin, delegated: true }, "worker"],
    ["a scheduled run", { ...origin, createdBy: "user", scheduled: true }, "timer"],
    [
      "a scheduled run in a subagent",
      { ...origin, relationshipToParent: "subagent", scheduled: true },
      "timer",
    ],
    ["a thread Dani made", { ...origin, createdBy: "user" }, "user"],
    ["a server-made thread", { ...origin, createdBy: "system" }, "unknown"],
  ] as const)("classes %s", (_name, value, actor) => {
    expect(threadActor(value)).toBe(actor);
  });
});

describe("statuses", () => {
  it("shows only runs that ended or wait", () => {
    expect(runStatus("completed")).toBe("ok");
    expect(runStatus("failed")).toBe("error");
    expect(runStatus("waiting")).toBe("waiting");
    for (const status of ["running", "queued", "interrupted", "cancelled", "rolled_back"]) {
      expect(runStatus(status)).toBe(null);
    }
  });

  it("reads Spanish and English words, accents and case aside", () => {
    expect(wordStatus("Hecho")).toBe("ok");
    expect(wordStatus("fallido")).toBe("error");
    expect(wordStatus("DECISIÓN")).toBe("waiting");
    expect(wordStatus("en curso")).toBe("running");
    expect(wordStatus("en_curso")).toBe("running");
    expect(wordStatus("quizá")).toBe(null);
    expect(wordActor("Orquestador")).toBe("orchestrator");
    expect(wordActor("subagente")).toBe("worker");
    expect(wordActor("Dani")).toBe("user");
    expect(wordActor("dev-cx53")).toBe("unknown");
    expect(wordActor(null)).toBe("unknown");
  });
});

describe("aonEntry", () => {
  const row: AonEventRow = {
    id: 7,
    fuente: "github",
    tipo: "github",
    proyecto: "nexo",
    estado: "hecho",
    creado: "2026-11-17T04:18:30+00:00",
    terminado: "2026-11-17T04:18:37+00:00",
    decision: 0,
  };
  const since = Date.parse("2026-11-16T00:00:00Z");

  it("names the source and type and keeps when the event ended", () => {
    expect(aonEntry(row, since)).toEqual({
      id: "aon:7",
      at: "2026-11-17T04:18:37.000Z",
      source: "aon",
      project: "nexo",
      actor: "orchestrator",
      summary: "github · github",
      status: "ok",
    });
  });

  it("maps its state, decisions and who sent it", () => {
    expect(aonEntry({ ...row, estado: "fallido" }, since)?.status).toBe("error");
    expect(aonEntry({ ...row, estado: "pendiente", terminado: null }, since)?.status).toBe(
      "running",
    );
    expect(aonEntry({ ...row, fuente: "dev-box", tipo: "eco", decision: 1 }, since)).toMatchObject({
      status: "waiting",
      summary: "dev-box · eco · decisión pendiente",
    });
    expect(aonEntry({ ...row, tipo: "decisión" }, since)?.status).toBe("waiting");
    expect(aonEntry({ ...row, fuente: "timer", tipo: "tests" }, since)).toMatchObject({
      actor: "timer",
      summary: "timer · tests",
    });
    expect(aonEntry({ ...row, fuente: "dev-cx53", tipo: "eco" }, since)?.actor).toBe("unknown");
    expect(aonEntry({ ...row, creado: "2026-11-10T00:00:00Z", terminado: null }, since)).toBe(null);
  });
});

describe("pesado turns", () => {
  it("parses a turn file and checks the pid still runs that command", () => {
    expect(parsePesadoWho("2026-11-17T05:15:43+00:00 pid 4084693 cargo test -j 4\n")).toEqual({
      at: "2026-11-17T05:15:43.000Z",
      pid: 4084693,
      command: "cargo test -j 4",
    });
    expect(parsePesadoWho("garbage")).toBe(null);
    expect(parsePesadoWho("2026-11-17T05:15:43+00:00 pid 1 init")).toBe(null);
    expect(commandMatches("node\0/usr/bin/npx\0vitest\0run", "npx vitest run")).toBe(true);
    expect(commandMatches("node\0/usr/bin/npx\0vitest", "env CI=1 /usr/bin/npx vitest")).toBe(true);
    expect(commandMatches("bash\0-l", "npx vitest run")).toBe(false);
  });

  it.each([
    ["vp run check:changed", "vp run"],
    ["npx vitest run --maxWorkers=2 apps/x", "npx vitest run"],
    ["curl -u usuario:clave https://example.com", "curl"],
    ["deploy --password hunter2", "deploy"],
    ["env CI=1 TOKEN=abc /usr/local/bin/cargo test -p core", "cargo test"],
    ["git push origin dev feature extra", "git push origin dev"],
    ["sh .githooks/integrate-dev.sh", "sh"],
    ["tool user@example.com", "tool"],
    [`tool ${"a".repeat(33)}`, "tool"],
    ["-x", null],
    ["./9run go", null],
  ])("shows only the program and its subcommands of %s", (command, summary) => {
    expect(commandSummary(command)).toBe(summary);
  });

  it("never puts a turn's free arguments in its entry", () => {
    for (const command of [
      "deploy --password hunter2",
      "curl -u usuario:clave https://x.example",
    ]) {
      const entry = pesadoEntry("slot1", { at: "2026-11-17T05:00:00.000Z", pid: 42, command });
      expect(entry.summary).toBe(`Heavy job: ${command.split(" ")[0]}`);
      for (const secret of ["hunter2", "password", "usuario", "clave", "x.example"]) {
        expect(JSON.stringify(entry)).not.toContain(secret);
      }
    }
  });
});

describe("dev commits", () => {
  it("prefers origin, then a GitHub remote", () => {
    const urls = new Map([
      ["forge", "https://forge.example/x.git"],
      ["gh", "git@github.com:ddmr2811/t3code.git"],
    ]);
    expect(pickDevRef(["refs/remotes/gh/dev", "refs/remotes/origin/dev"], urls)).toBe(
      "refs/remotes/origin/dev",
    );
    expect(pickDevRef(["refs/remotes/forge/dev", "refs/remotes/gh/dev"], urls)).toBe(
      "refs/remotes/gh/dev",
    );
    expect(pickDevRef(["refs/remotes/forge/main"], urls)).toBe(null);
  });

  it("cleans the project title like every other source", () => {
    const commit = { hash: "8de89f7731", at: "2026-11-17T04:00:00.000Z", subject: "Fork: a" };
    const entry = commitEntry("Orbita TOKEN=ghp_abcdefghijklmnop\nsecond line", commit);
    expect(entry.project).toBe("Orbita TOKEN=•••");
    expect(JSON.stringify(entry)).not.toContain("ghp_");
    expect(JSON.stringify(entry)).not.toContain("second line");
    expect("project" in commitEntry(" \n ", commit)).toBe(false);
  });

  it("parses the log lines it asked for", () => {
    const hash = "8de89f7731aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect(parseGitLog(`${hash}\x1f2026-11-17T05:00:00+01:00\x1fFork: a\x1fb\nnoise`)).toEqual([
      { hash, at: "2026-11-17T04:00:00.000Z", subject: "Fork: a\x1fb" },
    ]);
  });
});
