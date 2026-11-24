import { type EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  FORK_BOTS_INSTRUCTIONS_MAX_LENGTH,
  FORK_BOTS_NAME_MAX_LENGTH,
  FORK_BOTS_ROLE_MAX_LENGTH,
  type ForkBot,
  type ProjectId,
  type ProviderInstanceId,
  type ScheduledTaskUpsertInput,
  type ThreadId,
} from "@t3tools/contracts";

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

export function validateBotDraft(
  draft: BotDraft,
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

export function botThreadState(
  bot: ForkBot,
  threads: ReadonlyArray<EnvironmentThreadShell>,
): "Listo" | "Trabajando" | "Te necesita" | "Error" {
  const thread = threads.find((candidate) => candidate.id === bot.threadId);
  if (thread === undefined) return "Listo";
  const runtime = thread.runtime?.status;
  if (runtime === "failed") return "Error";
  if (
    runtime === "preparing" ||
    runtime === "queued" ||
    runtime === "starting" ||
    runtime === "running" ||
    runtime === "waiting"
  ) {
    return "Trabajando";
  }
  // A thread that needs you is still surfaced through the pending tray; this is only a coarse badge.
  return "Listo";
}

export const NIGHTLY_CONSOLIDATION_PROMPT = [
  "Consolidación nocturna de la memoria del proyecto.",
  "1. Repasa todas las notas con project_memory_search (consulta vacía; si hay más de 50, busca por temas).",
  "2. Fusiona duplicados y notas que dicen lo mismo en una sola con project_memory_save y `replaces`, sin perder información.",
  "3. Si una nota quedó obsoleta porque otra la sustituye, añádela a `replaces`. No quites por tu cuenta notas del usuario que nada sustituye.",
  "4. Termina proponiendo, con su id, qué notas esenciales bajarías a buscables y cuáles borrarías, para que el usuario decida.",
].join("\n");

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
          prompt: routine.prompt.trim(),
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
