import {
  type EnvironmentId,
  FORK_BOTS_INSTRUCTIONS_MAX_LENGTH,
  FORK_BOTS_NAME_MAX_LENGTH,
  FORK_BOTS_ROLE_MAX_LENGTH,
  type ForkBot,
  type ForkBotHandoff,
  type ProjectId,
  type ProviderInstanceId,
  type ScheduledTask,
  type ScheduledTaskUpsertInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";

import { threadState } from "../sidebar/sidebar.logic.ts";

export interface BotDraft {
  readonly handle: string;
  readonly name: string;
  readonly role: string;
  readonly instructions: string;
  readonly projectId: string;
  readonly runtimeMode: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
  readonly instanceId: string;
  readonly model: string;
  readonly coordinator: boolean;
}

export interface ValidatedBotDraft {
  readonly handle: string;
  readonly name: string;
  readonly role: string;
  readonly instructions: string;
  readonly projectId: ProjectId;
  readonly runtimeMode: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  readonly coordinator: boolean;
}

export const RUNTIME_MODES = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
] as const;
/** A bot proposed from a sentence goes at most this far, even when adjusted. */
export const SENTENCE_RUNTIME_MODES = ["approval-required", "auto-accept-edits"] as const;

export function validateBotDraft(
  draft: BotDraft,
  allowedModes: ReadonlyArray<BotDraft["runtimeMode"]> = RUNTIME_MODES,
):
  | { readonly ok: true; readonly value: ValidatedBotDraft }
  | { readonly ok: false; readonly error: string } {
  if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(draft.handle)) {
    return { ok: false, error: "Handle inválido (minúsculas, números, - o _)." };
  }
  if (draft.name.trim() === "" || draft.name.length > FORK_BOTS_NAME_MAX_LENGTH) {
    return {
      ok: false,
      error: `Nombre obligatorio (máx. ${FORK_BOTS_NAME_MAX_LENGTH} caracteres).`,
    };
  }
  if (draft.role.trim() === "" || draft.role.length > FORK_BOTS_ROLE_MAX_LENGTH) {
    return { ok: false, error: `Rol obligatorio (máx. ${FORK_BOTS_ROLE_MAX_LENGTH} caracteres).` };
  }
  if (
    draft.instructions.length === 0 ||
    draft.instructions.length > FORK_BOTS_INSTRUCTIONS_MAX_LENGTH
  ) {
    return {
      ok: false,
      error: `Instrucciones obligatorias (máx. ${FORK_BOTS_INSTRUCTIONS_MAX_LENGTH} caracteres).`,
    };
  }
  if (draft.projectId === "") {
    return { ok: false, error: "Selecciona un proyecto." };
  }
  if (draft.instanceId === "" || draft.model === "") {
    return { ok: false, error: "Selecciona un modelo." };
  }
  if (!allowedModes.includes(draft.runtimeMode)) {
    return {
      ok: false,
      error: "Desde una frase, los permisos llegan como mucho a «Aceptar ediciones».",
    };
  }
  return {
    ok: true,
    value: {
      handle: draft.handle,
      name: draft.name.trim(),
      role: draft.role.trim(),
      instructions: draft.instructions,
      projectId: draft.projectId as ProjectId,
      runtimeMode: draft.runtimeMode,
      instanceId: draft.instanceId as ProviderInstanceId,
      model: draft.model,
      coordinator: draft.coordinator,
    },
  };
}

export type BotStatus = "working" | "needs-you" | "error" | "done" | "asleep";

export interface BotState {
  readonly status: BotStatus;
  /** Spanish label shown beside the avatar, so the state never rests on colour alone. */
  readonly label: string;
}

type BotThread = Parameters<typeof threadState>[0];

/**
 * The single place a bot's state is decided; every surface that paints a bot reads it.
 * `thread` is the bot's listed thread, if any. A finished turn reads «Hecho» until the user
 * opens it, or for as long as a routine is still coming; after that the bot sleeps.
 */
export function botState(
  bot: Pick<ForkBot, "archived">,
  thread: BotThread | undefined,
  routineScheduled: boolean,
): BotState {
  if (bot.archived) return { status: "asleep", label: "Archivado" };
  if (thread === undefined) return { status: "asleep", label: "Dormido" };
  const state = threadState(thread);
  if (state === "needs-you") return { status: "needs-you", label: "Te necesita" };
  if (state === "working") return { status: "working", label: "Trabajando" };
  if (state === "error") return { status: "error", label: "Error" };
  const run = thread.latestRun;
  const unseen = run !== null && endedAfter(run, thread.lastVisitedAt);
  if ((run?.status === "interrupted" || run?.status === "cancelled") && unseen) {
    return { status: "error", label: "Cortado" };
  }
  if (run?.status === "completed" && (unseen || routineScheduled)) {
    return { status: "done", label: "Hecho" };
  }
  return { status: "asleep", label: "Dormido" };
}

function endedAfter(
  run: NonNullable<BotThread["latestRun"]>,
  visitedAt: string | null | undefined,
): boolean {
  if (!visitedAt) return true;
  const endedMs = Date.parse(run.completedAt ?? run.startedAt ?? run.requestedAt ?? "");
  const visitedMs = Date.parse(visitedAt);
  return Number.isNaN(endedMs) || Number.isNaN(visitedMs) || endedMs > visitedMs;
}

/** Threads with a routine still to come: enabled, not blocked, and dated or waiting on a webhook. */
export function routineThreadIds(tasks: ReadonlyArray<ScheduledTask>): ReadonlySet<string> {
  return new Set(
    tasks
      .filter(
        (task) =>
          task.enabled &&
          task.blockedByPolicy === undefined &&
          task.threadId !== null &&
          (task.nextRunAt !== null || task.schedule.type === "webhook"),
      )
      .map((task) => task.threadId!),
  );
}

export const NIGHTLY_CONSOLIDATION_PROMPT = [
  "Consolidación nocturna de la memoria del proyecto.",
  "1. Repasa todas las notas con project_memory_search (consulta vacía; si hay más de 50, busca por temas).",
  "2. Fusiona duplicados entre notas de agentes en una sola con project_memory_save y `replaces`, sin perder información. Las notas del usuario y las esenciales no se pueden sustituir: si sobran o se repiten, propónlo.",
  "3. Si una nota de agente quedó obsoleta porque otra la sustituye, añádela a `replaces`.",
  "4. Termina proponiendo, con su id, qué notas esenciales bajarías a buscables y cuáles borrarías, para que el usuario decida.",
  "5. Repasa las peticiones del usuario de los últimos 30 días en este hilo y en la memoria. Si pidió al menos 3 veces algo parecido que ningún bot cubre, propón un bot con bot_propose (nombre, rol, instrucciones, rutina y el porqué con fechas). Antes, busca «dijo que no» con project_memory_search y no propongas nada parecido a lo rechazado. Si no hay un caso claro, no propongas nada.",
].join("\n");

/** The nightly prompt before F8, still saved in coordinators' tasks until they are updated. */
const NIGHTLY_PROMPT_BEFORE_F8 = NIGHTLY_CONSOLIDATION_PROMPT.split("\n").slice(0, 5).join("\n");

/** Recognised by its exact prompt, so another task with a similar title is never touched. */
export function isNightlyTask(task: Pick<ScheduledTask, "prompt">): boolean {
  return task.prompt === NIGHTLY_CONSOLIDATION_PROMPT || task.prompt === NIGHTLY_PROMPT_BEFORE_F8;
}

/** Titled as the nightly task but with a prompt the user wrote: the ADE leaves it alone. */
export function isCustomNightly(task: Pick<ScheduledTask, "title" | "prompt">): boolean {
  return task.title.startsWith("Consolidación nocturna · ") && !isNightlyTask(task);
}

/** Brings an older nightly task to the current prompt; schedule, pause and the rest stay. */
export function nightlyPromptUpdate(task: ScheduledTask): ScheduledTaskUpsertInput {
  return {
    id: task.id,
    requireExisting: true,
    title: task.title,
    prompt: NIGHTLY_CONSOLIDATION_PROMPT,
    enabled: task.enabled,
    schedule: task.schedule,
    projectId: task.projectId,
    threadId: task.threadId,
    ...(task.threadMode === undefined ? {} : { threadMode: task.threadMode }),
    workspaceStrategy: task.workspaceStrategy,
    modelSelection: task.modelSelection,
    runtimeMode: task.runtimeMode,
    interactionMode: task.interactionMode,
  };
}

export type CoordinatorRoutine =
  | {
      readonly kind: "daily";
      readonly title: string;
      readonly prompt: string;
      readonly timeOfDay: string;
    }
  | { readonly kind: "webhook"; readonly title: string; readonly prompt: string }
  | { readonly kind: "nightly" };

/** Routines continue the coordinator's own thread, so they run as it, with its memory tools. */
export function coordinatorRoutineInput(
  bot: ForkBot,
  threadId: ThreadId,
  routine: CoordinatorRoutine,
): ScheduledTaskUpsertInput {
  const content =
    routine.kind === "nightly"
      ? {
          title: `Consolidación nocturna · ${bot.name}`,
          prompt: NIGHTLY_CONSOLIDATION_PROMPT,
          schedule: { type: "fixed_time", timeOfDay: "03:00" } as const,
        }
      : {
          title: routine.title.trim(),
          // Routines skip the bot's own messages, so they never get the injected essentials.
          prompt: `Antes de empezar, consulta la memoria del proyecto con project_memory_search.\n\n${routine.prompt.trim()}`,
          schedule:
            routine.kind === "daily"
              ? ({ type: "fixed_time", timeOfDay: routine.timeOfDay } as const)
              : ({ type: "webhook" } as const),
        };
  return {
    ...content,
    enabled: true,
    projectId: bot.projectId,
    threadId,
    threadMode: "continue",
    workspaceStrategy: { type: "root" },
    modelSelection: {
      instanceId: bot.modelSelection.instanceId,
      model: bot.modelSelection.model,
      ...(bot.modelSelection.options === undefined ? {} : { options: bot.modelSelection.options }),
    },
    runtimeMode: bot.runtimeMode,
    interactionMode: "default",
  };
}

/** `@handle rest` hands `rest` to another bot; anything else is a message to this bot. */
export function parseMention(
  text: string,
  otherHandles: ReadonlyArray<string>,
): { readonly handle: string; readonly text: string } | null {
  const match = /^@([a-z0-9][a-z0-9_-]{1,31})\s+([\s\S]*\S)/i.exec(text.trim());
  if (match === null) return null;
  const handle = otherHandles.find((other) => other.toLowerCase() === match[1]!.toLowerCase());
  return handle === undefined ? null : { handle, text: match[2]! };
}

export interface RecentHandoff {
  readonly handoff: ForkBotHandoff;
  readonly direction: "in" | "out";
  /** The other bot's handle, or its id when that bot was removed. */
  readonly peer: string;
}

export function recentHandoffs(
  handoffs: ReadonlyArray<ForkBotHandoff>,
  bots: ReadonlyArray<ForkBot>,
  botId: string,
  limit: number,
): ReadonlyArray<RecentHandoff> {
  const handleOf = (id: string) => {
    const bot = bots.find((candidate) => candidate.id === id);
    return bot === undefined ? id : `@${bot.handle}`;
  };
  return handoffs
    .filter((handoff) => handoff.fromBotId === botId || handoff.toBotId === botId)
    .toReversed()
    .slice(0, limit)
    .map((handoff) =>
      handoff.toBotId === botId
        ? { handoff, direction: "in", peer: handleOf(handoff.fromBotId) }
        : { handoff, direction: "out", peer: handleOf(handoff.toBotId) },
    );
}

/** A server older than a method answers it with this defect: the feature is absent, not broken. */
export function lacksMethod(cause: Cause.Cause<unknown>, tag: string): boolean {
  const defect = Cause.squash(cause);
  const message = defect instanceof Error ? defect.message : defect;
  return message === `Unknown request tag: ${tag}`;
}

export interface BotProjectChoice {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

export interface BotMachine {
  readonly environmentId: EnvironmentId;
  /** Empty while its projects load. */
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
}

const words = (text: string) =>
  ` ${text
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `;

/** Within one machine: the project the sentence names as whole words, longest first, else its first. */
export function suggestBotProject(
  text: string,
  projects: BotMachine["projects"],
): ProjectId | null {
  const sentence = words(text);
  const named = projects
    .filter(
      (project) => words(project.title).trim() !== "" && sentence.includes(words(project.title)),
    )
    .toSorted((left, right) => words(right.title).length - words(left.title).length)[0];
  return (named ?? projects[0])?.id ?? null;
}

/**
 * Where a sentence goes. With several machines the user always picks machine and project for
 * this very send: nothing in the sentence, the open thread or Bots' machine picks it. With one,
 * its suggested project. A machine with no projects loaded waits and never sends.
 */
export function botDestination(
  text: string,
  machines: ReadonlyArray<BotMachine>,
  picked: BotProjectChoice | null,
):
  | { readonly kind: "send"; readonly target: BotProjectChoice }
  | { readonly kind: "ask" }
  | { readonly kind: "wait" } {
  if (picked !== null) {
    const machine = machines.find((candidate) => candidate.environmentId === picked.environmentId);
    return machine?.projects.some((project) => project.id === picked.projectId)
      ? { kind: "send", target: picked }
      : { kind: "wait" };
  }
  if (machines.length !== 1) return machines.length > 1 ? { kind: "ask" } : { kind: "wait" };
  const only = machines[0]!;
  const projectId = suggestBotProject(text, only.projects);
  return projectId === null
    ? { kind: "wait" }
    : { kind: "send", target: { environmentId: only.environmentId, projectId } };
}
