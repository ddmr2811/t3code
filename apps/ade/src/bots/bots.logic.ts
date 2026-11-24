import { type EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  FORK_BOTS_INSTRUCTIONS_MAX_LENGTH,
  FORK_BOTS_NAME_MAX_LENGTH,
  FORK_BOTS_ROLE_MAX_LENGTH,
  type ForkBot,
  type ProjectId,
  type ProviderInstanceId,
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
