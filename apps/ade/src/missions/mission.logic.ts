import type {
  ForkBot,
  ThreadId,
  WorkflowQuestion,
  WorkflowRun,
  WorkflowRunDetail,
  WorkflowRunReference,
  WorkflowStep,
} from "@t3tools/contracts";

import type { BotStatus } from "../bots/bots.logic.ts";

export type MissionColumn = "todo" | "doing" | "you" | "done";

export const MISSION_COLUMNS: ReadonlyArray<{
  readonly id: MissionColumn;
  readonly title: string;
}> = [
  { id: "todo", title: "Por hacer" },
  { id: "doing", title: "En curso" },
  { id: "you", title: "Para ti" },
  { id: "done", title: "Hecho" },
];

export interface MissionCard {
  /** The first step's name: an integration's question and its yes join the step that asked. */
  readonly key: string;
  readonly title: string;
  readonly column: MissionColumn;
  /** The step's bot, or null for a step the workflow's own code runs. */
  readonly bot: ForkBot | null;
  /** The face its avatar wears, so the card's state never rests on colour alone. */
  readonly face: BotStatus;
  readonly status: string;
  /** The open question it waits on, answered on the card. */
  readonly question: WorkflowQuestion | null;
  /** The thread its agent works in, on this machine. */
  readonly threadId: string | null;
}

export interface MissionInput {
  readonly detail: WorkflowRunDetail;
  readonly questions: ReadonlyArray<WorkflowQuestion>;
  readonly bots: ReadonlyArray<ForkBot>;
  /** Whether a thread waits on the user, such as an approval its agent asked for. */
  readonly threadNeedsYou: (threadId: string) => boolean;
  readonly now: number;
}

const CLOCK = new Intl.DateTimeFormat("es-ES", { hour: "2-digit", minute: "2-digit" });
const clock = (iso: string) => CLOCK.format(Date.parse(iso));

/** «comentar-12» → «Comentar 12». */
const stepTitle = (name: string) => {
  const words = name.replace(/[-_]+/g, " ").trim();
  return words === "" ? name : words[0]!.toUpperCase() + words.slice(1);
};

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)[key]
    : undefined;

/** What an integration step's journal says about the bot it acted as, when it asked. */
const askedBot = (result: WorkflowStep["result"]): string | null => {
  const bot = field(field(result, "asked"), "bot");
  return typeof bot === "string" ? bot : null;
};

const outcomeOf = (result: WorkflowStep["result"]): string | null => {
  const choice = field(result, "choice");
  if (typeof choice === "string") return `Respondido: ${choice}`;
  switch (field(result, "status")) {
    case "denied":
      return "No se hizo";
    case "failed":
      return "Falló";
    case "unknown":
      return "Sin confirmar";
    default:
      return null;
  }
};

/**
 * The run's steps as a mission's cards. A step `x/…` joins an earlier step `x`, so an
 * integration's question and its yes stay on the card that asked; the card sits where its newest
 * part is. Steps not started yet cannot be known: a workflow is code, so «Por hacer» holds what
 * waits its turn (a queue, a sleep, a signal, a retry).
 */
export function missionCards(input: MissionInput): ReadonlyArray<MissionCard> {
  const { run, steps } = input.detail;
  const groups = new Map<string, WorkflowStep[]>();
  for (const step of steps) {
    const head = step.name.split("/", 1)[0]!;
    const group = head !== step.name ? groups.get(head) : undefined;
    if (group !== undefined) group.push(step);
    else groups.set(step.name, [step]);
  }
  const botByThread = new Map(
    input.bots.flatMap((bot) => (bot.threadId === null ? [] : [[bot.threadId, bot] as const])),
  );
  const botByHandle = new Map(input.bots.map((bot) => [bot.handle.toLowerCase(), bot] as const));
  const ended = run.endedAt !== null;

  return [...groups].map(([key, parts]): MissionCard => {
    const last = parts.at(-1)!;
    const local = (step: WorkflowStep) => step.threadId !== null && step.environmentId === null;
    const threadId = parts.findLast(local)?.threadId ?? null;
    const handle = parts.map((step) => askedBot(step.result)).find((name) => name !== null);
    const bot =
      (threadId === null ? undefined : botByThread.get(threadId as ThreadId)) ??
      (handle == null ? undefined : botByHandle.get(handle.replace(/^@/, "").toLowerCase())) ??
      null;
    const question =
      input.questions.find(
        (open) => open.runId === run.runId && parts.some((step) => step.name === open.name),
      ) ?? null;
    const card = (column: MissionColumn, face: BotStatus, status: string): MissionCard => ({
      key,
      title: stepTitle(key),
      column,
      bot,
      face,
      status,
      question,
      threadId,
    });

    if (question !== null) return card("you", "needs-you", "Te pregunta");
    // Cancelling fails what was still going; that is the cancel, not the step.
    if (run.status === "cancelled" && last.status !== "completed") {
      return card("done", "error", "Cancelado");
    }
    if (last.status === "completed") {
      return card("done", "done", outcomeOf(last.result) ?? "Hecho");
    }
    if (last.status === "failed") {
      if (ended) return card("done", "error", "Falló");
      if (run.status === "paused" && run.resumesAt === null) {
        return card("you", "error", "Falló · espera que lo reanudes");
      }
      return card(
        "todo",
        "error",
        run.resumesAt === null ? "Falló" : `Falló · reintenta a las ${clock(run.resumesAt)}`,
      );
    }
    // Still running in a run that has ended: the cancel cut it.
    if (ended) return card("done", "error", "Cortado");
    if (threadId !== null && input.threadNeedsYou(threadId)) {
      return card("you", "needs-you", "Pide permiso en su hilo");
    }
    switch (last.kind) {
      case "queue":
        return card(
          "todo",
          "asleep",
          last.ahead === undefined || last.ahead === 0
            ? "En cola"
            : `En cola · ${last.ahead} antes`,
        );
      case "sleep": {
        const wakes = last.detail === null ? NaN : Date.parse(last.detail);
        return card(
          "todo",
          "asleep",
          Number.isNaN(wakes) || wakes <= input.now
            ? "Despertando"
            : `Duerme hasta las ${clock(last.detail!)}`,
        );
      }
      case "wait":
        return card("todo", "asleep", "Espera una señal");
      case "ask":
        // Its question is not in the list yet: it opens a moment after the step.
        return card("you", "needs-you", "Te pregunta");
      default:
        return card(
          "doing",
          "working",
          last.attempts > 1 ? `Trabajando · intento ${last.attempts}` : "Trabajando",
        );
    }
  });
}

type MissionTone = "you" | "working" | "quiet" | "done" | "failed";

/** A mission's state in one word, from its run and the questions it has open. */
export function missionState(
  run: Pick<WorkflowRun, "status" | "resumesAt" | "detail">,
  openQuestions: number,
): { readonly word: string; readonly tone: MissionTone } {
  if (openQuestions > 0) return { word: "Para ti", tone: "you" };
  switch (run.status) {
    case "paused":
      return run.resumesAt === null
        ? { word: "En pausa · para ti", tone: "you" }
        : { word: "En pausa · reintenta sola", tone: "failed" };
    case "running":
      return { word: "En marcha", tone: "working" };
    case "waiting":
      return run.detail?.startsWith("agent ") === true
        ? { word: "En marcha", tone: "working" }
        : { word: "Esperando", tone: "quiet" };
    case "completed":
      return { word: "Hecha", tone: "done" };
    case "stopped":
      return { word: "Parada", tone: "quiet" };
    case "skipped":
      return { word: "Saltada", tone: "quiet" };
    case "cancelled":
      return { word: "Cancelada", tone: "failed" };
  }
}

/** `?mision=` holds the machine and the run, so a mission is a link like a thread. */
export const missionKey = (environmentId: string, runId: string) => `${environmentId}~${runId}`;

export function parseMissionKey(
  key: string | null,
): { readonly environmentId: string; readonly runId: string } | null {
  if (key === null) return null;
  const at = key.lastIndexOf("~");
  if (at <= 0 || at === key.length - 1) return null;
  return { environmentId: key.slice(0, at), runId: key.slice(at + 1) };
}

export interface MissionAnswer {
  readonly key: string;
  readonly title: string;
  readonly choice: string;
}

/** The questions the run already had answered, with the choice, in the order they were asked. */
export function missionAnswers(steps: ReadonlyArray<WorkflowStep>): ReadonlyArray<MissionAnswer> {
  return steps.flatMap((step) => {
    const choice = step.kind === "ask" ? field(step.result, "choice") : undefined;
    return typeof choice === "string"
      ? [{ key: step.name, title: stepTitle(step.name.split("/", 1)[0]!), choice }]
      : [];
  });
}

export interface MissionDeliverable {
  readonly key: string;
  readonly kind: string;
  readonly label: string;
  /** Where it lives, such as «acme/app #12», when the address says. */
  readonly where: string | null;
  readonly title: string;
  readonly url: string | null;
  /** Backroom's piece states: green for done, blue for open, amber for what waits, grey for the rest. */
  readonly state: "published" | "scheduled" | "waiting" | "preparing" | null;
  readonly stateWord: string | null;
  readonly steps: ReadonlyArray<string>;
}

const KIND_LABEL: Readonly<Record<string, string>> = {
  issue: "Issue",
  pullRequest: "Pull request",
  thread: "Hilo",
  url: "Enlace",
};
const STATE: Readonly<Record<string, readonly [MissionDeliverable["state"], string]>> = {
  open: ["scheduled", "Abierta"],
  draft: ["waiting", "Borrador"],
  merged: ["published", "Fusionada"],
  closed: ["preparing", "Cerrada"],
};

const whereOf = (reference: WorkflowRunReference): string | null => {
  const { address } = reference;
  const repository = field(address, "repository") ?? field(address, "scope");
  const number = field(address, "number") ?? field(address, "key");
  if (typeof repository === "string") {
    return typeof number === "string" || typeof number === "number"
      ? `${repository} #${number}`
      : repository;
  }
  if (reference.url === null) return null;
  try {
    return new URL(reference.url).host;
  } catch {
    return null;
  }
};

/** What the run's steps touched, as its deliverables; what started the run is not one. */
export function missionDeliverables(
  references: ReadonlyArray<WorkflowRunReference>,
): ReadonlyArray<MissionDeliverable> {
  return references
    .filter((reference) => reference.origin === "step")
    .map((reference) => {
      const state = reference.state === null ? undefined : STATE[reference.state];
      return {
        key: `${reference.kind}:${reference.key}`,
        kind: reference.kind,
        label: KIND_LABEL[reference.kind] ?? reference.kind,
        where: whereOf(reference),
        title: reference.title || reference.key,
        url: reference.url,
        state: reference.state === null ? null : (state?.[0] ?? "waiting"),
        stateWord: reference.state === null ? null : (state?.[1] ?? reference.state),
        steps: reference.steps.map(stepTitle),
      };
    });
}

const WEEKDAY: Readonly<Record<string, string>> = {
  Sun: "dom",
  Mon: "lun",
  Tue: "mar",
  Wed: "mié",
  Thu: "jue",
  Fri: "vie",
  Sat: "sáb",
};

/** The server says what starts a workflow in English («daily at 09:00 on Mon»); the chip says it here. */
export function triggerLabel(text: string): string {
  const every = /^every (.+)$/.exec(text);
  if (every !== null) return `Cada ${every[1]}`;
  const daily = /^daily at (\d\d:\d\d)(?: on (.+))?$/.exec(text);
  if (daily === null) return text;
  const days = daily[2]?.split(", ").map((day) => WEEKDAY[day] ?? day);
  return days === undefined ? `Cada día, ${daily[1]}` : `Cada ${days.join(", ")}, ${daily[1]}`;
}
