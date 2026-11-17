// Fork-only: who did a piece of work and how it ended, from the words each activity source uses.
import type { ForkActivityActor, ForkActivityStatus } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** Epoch ms as the feed's ISO time; every source writes `at` through this. */
export const isoAt = (ms: number): string => DateTime.formatIso(DateTime.makeUnsafe(ms));

export interface ThreadOrigin {
  /** `user`, `agent` or `system`, as the thread recorded it. */
  readonly createdBy: string | null;
  readonly relationshipToParent: string | null;
  readonly delegated: boolean;
  /** The run's prompt came from a scheduled task. */
  readonly scheduled: boolean;
}

export function threadActor(origin: ThreadOrigin): ForkActivityActor {
  if (origin.scheduled) return "timer";
  if (origin.relationshipToParent === "subagent" || origin.delegated) return "worker";
  if (origin.createdBy === "agent") return "orchestrator";
  if (origin.createdBy === "user") return "user";
  return "unknown";
}

/** Only the outcomes the feed shows; a run still going or stopped by hand answers null. */
export function runStatus(status: string): ForkActivityStatus | null {
  switch (status) {
    case "completed":
      return "ok";
    case "failed":
      return "error";
    case "waiting":
      return "waiting";
    default:
      return null;
  }
}

export const RUN_OUTCOME_LABEL: Readonly<Record<ForkActivityStatus, string>> = {
  ok: "finished",
  error: "failed",
  waiting: "waiting on you",
  running: "running",
};

const fold = (word: string) =>
  word
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

const ACTOR_WORDS: Readonly<Record<string, ForkActivityActor>> = {
  orchestrator: "orchestrator",
  orquestador: "orchestrator",
  worker: "worker",
  subagent: "worker",
  subagente: "worker",
  timer: "timer",
  cron: "timer",
  dani: "user",
  user: "user",
  usuario: "user",
};

/** A log line's `quien`; anything else is `unknown`, never a reason to drop the line. */
export function wordActor(word: string | null | undefined): ForkActivityActor {
  if (typeof word !== "string") return "unknown";
  return ACTOR_WORDS[fold(word)] ?? "unknown";
}

const STATUS_WORDS: Readonly<Record<string, ForkActivityStatus>> = {
  ok: "ok",
  hecho: "ok",
  done: "ok",
  error: "error",
  fallo: "error",
  fallido: "error",
  failed: "error",
  esperando: "waiting",
  waiting: "waiting",
  decision: "waiting",
  en_curso: "running",
  running: "running",
  pendiente: "running",
};

/** A log line's or an aon event's `estado`; null when it is not one the feed knows. */
export function wordStatus(word: string | null | undefined): ForkActivityStatus | null {
  if (typeof word !== "string") return null;
  return STATUS_WORDS[fold(word)] ?? null;
}
