import type {
  ForkBot,
  WorkflowQuestion,
  WorkflowRun,
  WorkflowRunDetail,
  WorkflowStep,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { missionCards, missionKey, parseMissionKey } from "./mission.logic.ts";

const AT = "2026-11-26T10:00:00.000Z";
const NOW = Date.parse(AT);

const run = (overrides: Partial<WorkflowRun> = {}): WorkflowRun => ({
  runId: "run-1",
  workflow: "guia",
  version: 1,
  title: "Publicar la guía",
  status: "waiting",
  detail: null,
  result: null,
  pauses: 0,
  retired: false,
  resumesAt: null,
  parentRunId: null,
  parentStep: null,
  startedAt: AT,
  updatedAt: AT,
  endedAt: null,
  ...overrides,
});

const step = (name: string, overrides: Partial<WorkflowStep> = {}): WorkflowStep => ({
  name,
  kind: "step",
  status: "completed",
  attempts: 1,
  detail: null,
  threadId: null,
  environmentId: null,
  result: null,
  said: null,
  startedAt: AT,
  endedAt: AT,
  ...overrides,
});

const bot = (handle: string, threadId: string | null): ForkBot =>
  ({ id: `bot-${handle}`, handle, name: handle, threadId }) as unknown as ForkBot;

const question = (name: string): WorkflowQuestion => ({
  runId: "run-1",
  name,
  request: { title: "¿Sí?", choices: ["Sí", "No"] },
  askedAt: AT,
  thread: null,
});

const cards = (
  steps: ReadonlyArray<WorkflowStep>,
  options: {
    run?: Partial<WorkflowRun>;
    questions?: ReadonlyArray<WorkflowQuestion>;
    bots?: ReadonlyArray<ForkBot>;
    needsYou?: ReadonlySet<string>;
  } = {},
) => {
  const detail: WorkflowRunDetail = { run: run(options.run), steps, references: [] };
  return missionCards({
    detail,
    questions: options.questions ?? [],
    bots: options.bots ?? [],
    threadNeedsYou: (threadId) => options.needsYou?.has(threadId) ?? false,
    now: NOW,
  });
};

const columns = (list: ReturnType<typeof cards>) =>
  Object.fromEntries(list.map((card) => [card.key, card.column]));

describe("missionCards", () => {
  it("keeps an integration's question and its yes on the card that asked, where its newest part is", () => {
    const nico = bot("nico", "fork-bot-thread:nico");
    const asked = step("comentar-12", { result: { status: "ask", asked: { bot: "@Nico" } } });
    const waiting = cards(
      [asked, step("comentar-12/pregunta", { kind: "ask", status: "running" })],
      {
        questions: [question("comentar-12/pregunta")],
        bots: [nico],
      },
    );
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ key: "comentar-12", column: "you", bot: nico });
    expect(waiting[0]!.question?.name).toBe("comentar-12/pregunta");

    const answered = cards(
      [
        asked,
        step("comentar-12/pregunta", { kind: "ask", result: { choice: "Sí" } }),
        step("comentar-12/si", { status: "running" }),
      ],
      { bots: [nico] },
    );
    expect(answered).toHaveLength(1);
    expect(answered[0]).toMatchObject({ column: "doing", bot: nico, question: null });
  });

  it("names the bot whose thread an agent step ran in, and none for the workflow's own code", () => {
    const vega = bot("vega", "fork-bot-thread:vega");
    const list = cards(
      [
        step("ordenar", { kind: "agent", threadId: "fork-bot-thread:vega" }),
        step("compilar", { status: "running" }),
      ],
      { bots: [vega] },
    );
    expect(list.map((card) => card.bot)).toEqual([vega, null]);
    expect(columns(list)).toEqual({ ordenar: "done", compilar: "doing" });
  });

  it("does not take a thread on a linked machine for one of this machine's", () => {
    const vega = bot("vega", "fork-bot-thread:vega");
    const [card] = cards(
      [step("fuera", { kind: "agent", threadId: "fork-bot-thread:vega", environmentId: "otra" })],
      { bots: [vega] },
    );
    expect(card).toMatchObject({ bot: null, threadId: null });
  });

  it("puts what waits its turn in Por hacer", () => {
    const list = cards([
      step("cola", { kind: "queue", status: "running", ahead: 2 }),
      step("dormir", { kind: "sleep", status: "running", detail: "2026-11-26T13:00:00.000Z" }),
      step("senal", { kind: "wait", status: "running" }),
    ]);
    expect(columns(list)).toEqual({ cola: "todo", dormir: "todo", senal: "todo" });
  });

  it("sends a failure to the user only when the paused run waits for a person", () => {
    const failed = [step("compilar", { status: "failed" })];
    expect(cards(failed, { run: { status: "paused" } })[0]!.column).toBe("you");
    expect(
      cards(failed, { run: { status: "paused", resumesAt: "2026-11-26T10:05:00.000Z" } })[0]!
        .column,
    ).toBe("todo");
  });

  it("files every step of an ended run as done, a cut or failed one included", () => {
    const list = cards(
      [step("a", { status: "failed" }), step("b", { kind: "agent", status: "running" })],
      { run: { status: "cancelled", endedAt: AT } },
    );
    expect(columns(list)).toEqual({ a: "done", b: "done" });
    expect(list.map((card) => card.face)).toEqual(["error", "error"]);
  });

  it("sends an agent step whose thread waits on an approval to the user", () => {
    const [card] = cards([step("escribir", { kind: "agent", status: "running", threadId: "t1" })], {
      needsYou: new Set(["t1"]),
    });
    expect(card!.column).toBe("you");
  });

  it("keeps a step with a slash as its own card when no step of that head came first", () => {
    const list = cards([step("docs/es"), step("docs/en")]);
    expect(list.map((card) => card.key)).toEqual(["docs/es", "docs/en"]);
  });
});

describe("mission keys", () => {
  it("reads back the machine and run it was made of, and nothing from a broken one", () => {
    expect(parseMissionKey(missionKey("env-1", "abc"))).toEqual({
      environmentId: "env-1",
      runId: "abc",
    });
    expect(parseMissionKey("sin-separador")).toBeNull();
    expect(parseMissionKey("env~")).toBeNull();
  });
});
