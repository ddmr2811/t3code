import {
  type ForkBot,
  type ForkMemoryNote,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { memoryAge, memoryChanges, memoryReaders, turnOpen } from "./memory.logic.ts";

const project = ProjectId.make("proj-1");

const note = (id: string, text: string, extra: Partial<ForkMemoryNote> = {}): ForkMemoryNote => ({
  id,
  projectId: project,
  text,
  inclusion: "searchable",
  origin: "agent",
  createdAt: "2026-11-20T10:00:00.000Z",
  updatedAt: "2026-11-20T10:00:00.000Z",
  ...extra,
});

const bot = (id: string, extra: Partial<ForkBot> = {}): ForkBot => ({
  id,
  handle: id,
  name: id,
  role: "",
  instructions: "",
  projectId: project,
  threadId: ThreadId.make(`thread-${id}`),
  runtimeMode: "approval-required",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  archived: false,
  coordinator: false,
  memoryHash: null,
  handoffHops: 0,
  handoffToolsMissing: false,
  integrations: {},
  createdAt: "2026-11-24T00:00:00.000Z",
  updatedAt: "2026-11-24T00:00:00.000Z",
  ...extra,
});

describe("memoryChanges", () => {
  it("shows a merge as the old note gone and the new one added, and skips what stayed", () => {
    const price = note("mem:a", "El pack cuesta 2.400 €.");
    const tone = note("mem:b", "Tono cálido.");
    const merged = note("mem:c", "El pack cuesta 1.800 €.");
    expect(memoryChanges([price, tone], [tone, merged])).toEqual([
      { before: price, after: null },
      { before: null, after: merged },
    ]);
  });

  it("pairs a note edited in place, also when only its switch to essential changed", () => {
    const before = note("mem:a", "Tono cálido.");
    const edited = { ...before, text: "Tono directo." };
    const promoted = { ...before, inclusion: "essential" as const };
    expect(memoryChanges([before], [edited])).toEqual([{ before, after: edited }]);
    expect(memoryChanges([before], [promoted])).toEqual([{ before, after: promoted }]);
  });
});

describe("memoryReaders", () => {
  it("lists only this project's live bots, coordinator first, with what it receives", () => {
    const readers = memoryReaders(
      [
        bot("vega"),
        bot("otro", { projectId: ProjectId.make("proj-2") }),
        bot("viejo", { archived: true }),
        bot("coord", { coordinator: true }),
      ],
      project,
      1,
    );
    expect(readers.map((reader) => [reader.bot.id, reader.reads])).toEqual([
      ["coord", "Recibe la esencial y busca el resto"],
      ["vega", "Busca en ella cuando le hace falta"],
    ]);
  });
});

describe("memoryAge", () => {
  it("counts whole days and falls back to the date after a month", () => {
    const now = Date.parse("2026-11-26T12:00:00.000Z");
    expect(memoryAge("2026-11-25T11:00:00.000Z", now)).toBe("ayer");
    expect(memoryAge("2026-11-23T13:00:00.000Z", now)).toBe("hace 2 días");
    expect(memoryAge("2026-10-20T12:00:00.000Z", now)).toMatch(/20 oct/);
  });
});

describe("turnOpen", () => {
  type Thread = NonNullable<Parameters<typeof turnOpen>[0]>;
  const thread = (status: "running" | "completed", overrides: Partial<Thread> = {}): Thread => ({
    archivedAt: null,
    deletedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingGuestMessageCount: 0,
    interactionMode: "default",
    hasActionableProposedPlan: false,
    pendingSubagentRequest: null,
    latestRun: {
      runId: RunId.make("run-1"),
      status,
      requestedAt: "2026-11-23T10:00:00.000Z",
      startedAt: "2026-11-23T10:00:00.000Z",
      completedAt: status === "running" ? null : "2026-11-23T10:05:00.000Z",
      assistantMessageId: null,
    },
    runtime: {
      status: status === "running" ? "running" : "idle",
      activeRunId: status === "running" ? RunId.make("run-1") : null,
    } as Thread["runtime"],
    ...overrides,
  });

  it("holds while the coordinator works or waits for an approval, and frees once it finished", () => {
    expect(turnOpen(thread("running"))).toBe(true);
    expect(turnOpen(thread("running", { hasPendingApprovals: true }))).toBe(true);
    expect(turnOpen(thread("completed"))).toBe(false);
    expect(turnOpen(undefined)).toBe(false);
  });
});
