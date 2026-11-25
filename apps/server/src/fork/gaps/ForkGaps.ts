// Fork-only: the ladder a bot climbs when it lacks a tool, kept in `<stateDir>/fork/gaps.json`.
// The server records each rung and the user's answer to an install. It never runs a command.
import {
  FORK_GAP_MAX_ATTEMPTS,
  FORK_GAP_MAX_TOKENS,
  FORK_GAPS_DAY_MS,
  FORK_GAPS_HISTORY,
  FORK_GAPS_MAX_FILE_BYTES,
  FORK_GAPS_PER_BOT_AND_DAY,
  FORK_GAPS_PROTOCOL_VERSION,
  type ForkBot,
  ForkBotsError,
  ForkGap,
  ForkGapAnswerInstallInput,
  type ForkGapInstall,
  type ForkGapListResult,
  type ForkGapRung,
  type ForkGapStep,
  ForkGapStepInput,
  type ProjectId,
  type ThreadId,
  projectKeyFromName,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ForkBots from "../bots/ForkBots.ts";
import * as ForkCoordination from "../coordination/ForkCoordination.ts";
import { makeForkJsonFileStore } from "../jsonFileStore.ts";

/** The calling thread as it is now; only a bot's own thread records a gap. */
export interface GapSender {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
}

export class ForkGaps extends Context.Service<
  ForkGaps,
  {
    readonly list: Effect.Effect<ForkGapListResult, ForkBotsError>;
    /** Records one rung. `next` tells the bot what it may do now. */
    readonly step: (
      input: ForkGapStepInput,
      from: GapSender,
    ) => Effect.Effect<{ readonly gap: ForkGap; readonly next: string }, ForkBotsError>;
    /** The user's one answer to one install request; it goes back to the bot's thread. */
    readonly answerInstall: (
      input: ForkGapAnswerInstallInput,
    ) => Effect.Effect<ForkGap, ForkBotsError>;
  }
>()("t3/fork/gaps/ForkGaps") {}

const StoredGaps = Schema.Struct({
  version: Schema.Literal(FORK_GAPS_PROTOCOL_VERSION),
  /** Oldest first. */
  gaps: Schema.Array(ForkGap),
});
type StoredGaps = typeof StoredGaps.Type;

const decodeStoredGaps = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredGaps));
const decodeStepInput = Schema.decodeUnknownEffect(ForkGapStepInput);
const decodeAnswerInput = Schema.decodeUnknownEffect(ForkGapAnswerInstallInput);

const invalidInput = (message: string) => new ForkBotsError({ reason: "invalidInput", message });
const limitExceeded = (message: string) => new ForkBotsError({ reason: "limitExceeded", message });

const RUNGS: ReadonlyArray<ForkGapRung> = ["reuse", "install", "build", "hire"];
const RUNG_TEXT: Record<ForkGapRung, string> = {
  reuse: "1 Reutilizar",
  install: "2 Instalar",
  build: "3 Construir",
  hire: "4 Contratar un bot",
};
const RESULT_TEXT: Record<ForkGapStep["result"], string> = {
  trying: "en curso",
  worked: "funcionó",
  failed: "falló",
};
const ANSWER_TEXT: Record<ForkGapInstall["answer"], string> = {
  pending: "espera tu sí",
  approved: "aprobada",
  rejected: "rechazada",
};
const SCOPE_TEXT: Record<ForkGapInstall["scope"], string> = {
  project: "dentro del proyecto",
  system: "en el sistema",
};

const pendingInstall = (gap: ForkGap) =>
  gap.steps.find((step) => step.install?.answer === "pending")?.install;

/** One line per rung reached, in ladder order; the install line keeps its way back. */
function boardSummary(gap: ForkGap): string {
  const lines = RUNGS.flatMap((rung) => {
    const last = gap.steps.findLast((step) => step.rung === rung);
    if (last === undefined) return [];
    const asked = gap.steps.findLast((step) => step.install !== undefined)?.install;
    const request =
      rung === "install" && asked !== undefined
        ? ` (${SCOPE_TEXT[asked.scope]}, ${ANSWER_TEXT[asked.answer]}): ${asked.command} · Vuelta atrás: ${asked.rollback}`
        : "";
    return [`${RUNG_TEXT[rung]}${request} · ${RESULT_TEXT[last.result]}: ${last.note}`];
  });
  return lines.join("\n").slice(0, 1000);
}

/** What the bot may do after this step. Each rung names the next one, so none is skipped. */
function nextText(step: ForkGapStep, attemptsLeft: number): string {
  const left = `Te quedan ${attemptsLeft} pasos en este hueco.`;
  if (step.result === "worked")
    return "Hueco resuelto y apuntado en el tablero. Sigue con tu tarea.";
  if (step.install !== undefined) {
    return `Petición ${step.install.id} en la bandeja del usuario. NO ejecutes el comando: termina el turno y espera su respuesta, que llegará a este hilo. ${left}`;
  }
  if (step.result === "trying") {
    const how: Record<ForkGapRung, string> = {
      reuse:
        "Busca un bot (bot_handoff), una herramienta MCP o una skill que ya lo haga, y apunta si funcionó o falló.",
      install: "Apunta si la instalación funcionó o falló.",
      build:
        "Delega en un hilo hijo con delegate_task, en un worktree nuevo (isolation: worktree) y con runtimeMode approval-required, nunca full-access ni por encima del tuyo. Debe dejar el script o la herramienta con su prueba; no lo uses hasta que el usuario lo revise.",
      hire: "Propón el bot con bot_propose si coordinas el proyecto; si no, pásaselo al coordinador con bot_handoff.",
    };
    return `${how[step.rung]} ${left}`;
  }
  const after: Record<ForkGapRung, string> = {
    reuse:
      "Siguiente peldaño, instalar: llama otra vez con rung install, result trying e install (scope, command, rollback). Si no hay vuelta atrás clara, no lo pidas y pasa a build.",
    install: "Siguiente peldaño, construir: llama otra vez con rung build y result trying.",
    build: "Último peldaño, contratar un bot: llama otra vez con rung hire y result trying.",
    hire: "No quedan peldaños. Para y dile al usuario qué falta.",
  };
  return `${after[step.rung]} ${left}`;
}

function answerText(gap: ForkGap, install: ForkGapInstall): string {
  const head = `--- RESPUESTA DEL USUARIO · instalación ${install.id} · hueco «${gap.name}» ---`;
  const body =
    install.answer === "approved"
      ? [
          "SÍ, una sola vez, en esta máquina y solo para este comando exacto:",
          install.command,
          "No lo cambies, no le añadas otros comandos y no lo repitas. Otra instalación necesita otra petición.",
          `Vuelta atrás si algo sale mal: ${install.rollback}`,
          "Al terminar, apunta el resultado con bot_gap_step (rung install, result worked o failed).",
        ]
      : [
          "NO. No ejecutes este comando ni pidas lo mismo otra vez:",
          install.command,
          "Apunta el resultado con bot_gap_step (rung install, result failed) y sigue con el peldaño de construir, o dile al usuario qué falta.",
        ];
  return [head, ...body, "--- FIN DE LA RESPUESTA ---"].join("\n");
}

/** @public */
export const make = Effect.gen(function* () {
  const lock = yield* Semaphore.make(1);
  const store = yield* makeForkJsonFileStore({
    fileName: "gaps.json",
    label: "Gap store",
    maxBytes: FORK_GAPS_MAX_FILE_BYTES,
    empty: { version: FORK_GAPS_PROTOCOL_VERSION, gaps: [] } satisfies StoredGaps,
    decode: decodeStoredGaps,
    makeError: (reason, message) => new ForkBotsError({ reason, message }),
  });
  const forkBots = yield* ForkBots.ForkBots;
  const coordination = yield* ForkCoordination.ForkCoordination;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagement.ThreadManagementService;

  /**
   * New tokens (input not read from cache, plus output) of the thread's turns that finished since
   * the gap opened. A thread that cannot be read counts 0: the attempt limit still closes the gap.
   */
  const tokensSpent = Effect.fn("ForkGaps.tokensSpent")(function* (gap: ForkGap) {
    const outcome = yield* threads
      .getThreadRecords(gap.threadId, ["providerTurns"])
      .pipe(Effect.result);
    if (outcome._tag === "Failure") return 0;
    const since = Date.parse(gap.createdAt);
    let total = 0;
    for (const turn of outcome.success.providerTurns) {
      const usage = turn.turnTokenUsage;
      if (usage === undefined || turn.completedAt === null) continue;
      if (DateTime.toEpochMillis(turn.completedAt) < since) continue;
      total +=
        Math.max(0, (usage.inputTokens ?? 0) - (usage.cachedInputTokens ?? 0)) +
        (usage.outputTokens ?? 0);
    }
    return total;
  });

  /** The board is the trace; the gap itself is already on disk, so a failed write is logged. */
  const trace = Effect.fn("ForkGaps.trace")(function* (gap: ForkGap, bot: ForkBot | undefined) {
    yield* Effect.gen(function* () {
      const project = yield* projects.getById(gap.projectId);
      const projectName = Option.match(project, {
        onNone: () => gap.projectId,
        onSome: (found) => found.title,
      });
      const pending = pendingInstall(gap);
      yield* coordination.upsert({
        id: gap.id,
        projectKey: projectKeyFromName(projectName, gap.projectId),
        projectName: projectName.slice(0, 160),
        threadId: gap.threadId,
        agentName: bot?.name ?? "Bot",
        status:
          gap.status === "exhausted"
            ? "blocked"
            : gap.status === "solved"
              ? "done"
              : pending === undefined
                ? "working"
                : "waiting",
        workingOn: `Le falta: ${gap.name}`,
        completedSummary: boardSummary(gap),
        waitingFor:
          gap.status === "exhausted"
            ? "Tope de intentos o de tokens de este hueco. Decide tú cómo seguir."
            : pending === undefined
              ? ""
              : "Tu sí o tu no en la bandeja para instalar.",
      });
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("fork gaps could not trace a gap on the board", { gapId: gap.id, error }),
      ),
    );
  });

  /** Holding the lock. Past the history, the oldest gaps without a pending install go. */
  const save = Effect.fn("ForkGaps.save")(function* (stored: StoredGaps, gap: ForkGap) {
    const all = [...stored.gaps.filter((candidate) => candidate.id !== gap.id), gap];
    let extra = all.length - FORK_GAPS_HISTORY;
    const kept = all.filter((candidate) => {
      if (extra <= 0 || candidate.id === gap.id || pendingInstall(candidate) !== undefined) {
        return true;
      }
      extra -= 1;
      return false;
    });
    yield* store.write({ version: FORK_GAPS_PROTOCOL_VERSION, gaps: kept });
    for (const dropped of all.filter((candidate) => !kept.includes(candidate))) {
      yield* coordination.remove({ id: dropped.id }).pipe(Effect.ignore);
    }
  });

  const step = Effect.fn("ForkGaps.step")(function* (input: ForkGapStepInput, from: GapSender) {
    const parsed = yield* decodeStepInput(input).pipe(
      Effect.mapError(() =>
        invalidInput(
          "Invalid gap step. Each text is one short line, and an install needs scope, command and rollback: without a way back it is not proposed.",
        ),
      ),
    );
    const bot = (yield* forkBots.list({})).bots.find(
      (candidate) => candidate.threadId === from.threadId,
    );
    if (bot === undefined || bot.archived || bot.projectId !== from.projectId) {
      return yield* new ForkBotsError({
        reason: "permissionDenied",
        message: "Only a bot's own thread can record a gap or ask for an install.",
      });
    }
    const asksInstall = parsed.rung === "install" && parsed.result === "trying";
    if (asksInstall !== (parsed.install !== undefined)) {
      return yield* invalidInput(
        "`install` goes with rung install and result trying, and only with them.",
      );
    }
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const stored = yield* store.read();
        const nowMs = yield* Clock.currentTimeMillis;
        const now = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
        const own = stored.gaps.filter((candidate) => candidate.botId === bot.id);
        const known = own.findLast(
          (candidate) =>
            candidate.status !== "solved" &&
            candidate.threadId === from.threadId &&
            candidate.name.toLowerCase() === parsed.gap.toLowerCase(),
        );
        const closed = `Gap «${parsed.gap}» is closed: it reached its limit of attempts or tokens. Stop, and tell the user what is missing.`;
        if (known?.status === "exhausted") return yield* limitExceeded(closed);
        if (
          known === undefined &&
          own.filter((candidate) => nowMs - Date.parse(candidate.createdAt) < FORK_GAPS_DAY_MS)
            .length >= FORK_GAPS_PER_BOT_AND_DAY
        ) {
          return yield* limitExceeded(
            `A bot opens at most ${FORK_GAPS_PER_BOT_AND_DAY} gaps a day. Stop, and tell the user what is missing.`,
          );
        }
        const gap: ForkGap = known ?? {
          id: `gap:${SecureRandom.uuidV4Unsafe()}`,
          botId: bot.id,
          projectId: bot.projectId,
          threadId: from.threadId,
          name: parsed.gap,
          status: "open",
          steps: [],
          createdAt: now,
          updatedAt: now,
        };
        if (
          gap.steps.length >= FORK_GAP_MAX_ATTEMPTS ||
          (yield* tokensSpent(gap)) > FORK_GAP_MAX_TOKENS
        ) {
          const exhausted: ForkGap = { ...gap, status: "exhausted", updatedAt: now };
          yield* save(stored, exhausted);
          yield* trace(exhausted, bot);
          return yield* limitExceeded(closed);
        }
        if (
          parsed.rung === "hire" &&
          !gap.steps.some((done) => done.rung === "build" && done.result === "failed")
        ) {
          return yield* invalidInput("A bot is proposed only after the build rung failed.");
        }
        if (asksInstall && own.some((candidate) => pendingInstall(candidate) !== undefined)) {
          return yield* limitExceeded(
            "An install of yours already waits for the user. They are approved one by one: wait for the answer.",
          );
        }
        const recorded: ForkGapStep = {
          rung: parsed.rung,
          result: parsed.result,
          note: parsed.note,
          ...(parsed.install === undefined
            ? {}
            : {
                install: {
                  ...parsed.install,
                  id: `install:${SecureRandom.uuidV4Unsafe()}`,
                  answer: "pending" as const,
                  decidedAt: null,
                },
              }),
          at: now,
        };
        const next: ForkGap = {
          ...gap,
          steps: [...gap.steps, recorded],
          status: parsed.result === "worked" ? "solved" : "open",
          updatedAt: now,
        };
        yield* save(stored, next);
        yield* trace(next, bot);
        return { gap: next, next: nextText(recorded, FORK_GAP_MAX_ATTEMPTS - next.steps.length) };
      }),
    );
  });

  /** Whether the bot is still in the live thread that asked; an approval goes nowhere else. */
  const stillAsking = Effect.fn("ForkGaps.stillAsking")(function* (
    gap: ForkGap,
    bot: ForkBot | undefined,
  ) {
    if (bot === undefined || bot.archived || bot.threadId !== gap.threadId) return false;
    const outcome = yield* threads.getThreadRecords(gap.threadId, []).pipe(Effect.result);
    return (
      outcome._tag === "Success" &&
      outcome.success.thread.archivedAt === null &&
      outcome.success.thread.deletedAt === null
    );
  });

  const answerInstall = Effect.fn("ForkGaps.answerInstall")(function* (
    input: ForkGapAnswerInstallInput,
  ) {
    const parsed = yield* decodeAnswerInput(input).pipe(
      Effect.mapError(() => invalidInput("Invalid install answer.")),
    );
    const { bots } = yield* forkBots.list({});
    // Checking it is pending and saving the answer under one lock: a second answer is refused.
    const decided = yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const stored = yield* store.read();
        const gap = stored.gaps.find((candidate) =>
          candidate.steps.some((done) => done.install?.id === parsed.id),
        );
        const asked = gap?.steps.find((done) => done.install?.id === parsed.id)?.install;
        if (gap === undefined || asked === undefined) {
          return yield* new ForkBotsError({
            reason: "notFound",
            message: "Install request was not found.",
          });
        }
        if (asked.answer !== "pending") {
          return yield* invalidInput("This install was already answered.");
        }
        const bot = bots.find((candidate) => candidate.id === gap.botId);
        const reachable = yield* stillAsking(gap, bot);
        const now = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
        const install: ForkGapInstall = {
          ...asked,
          answer: parsed.answer === "approve" && reachable ? "approved" : "rejected",
          decidedAt: now,
        };
        const next: ForkGap = {
          ...gap,
          steps: gap.steps.map((done) =>
            done.install?.id === parsed.id ? { ...done, install } : done,
          ),
          updatedAt: now,
        };
        yield* save(stored, next);
        return { gap: next, install, bot, reachable };
      }),
    );
    yield* trace(decided.gap, decided.bot);
    if (decided.bot === undefined || !decided.reachable) {
      return parsed.answer === "reject"
        ? decided.gap
        : yield* new ForkBotsError({
            reason: "conflict",
            message:
              "The bot is no longer in the thread that asked, so nothing was approved and the request is closed.",
          });
    }
    yield* forkBots
      .sendMessage({ id: decided.bot.id, text: answerText(decided.gap, decided.install) })
      .pipe(
        Effect.mapError(
          (error) =>
            new ForkBotsError({
              reason: "dispatchFailed",
              message: `The answer is saved, but the bot could not be told (${error.message}). Tell it in its chat.`,
            }),
        ),
      );
    return decided.gap;
  });

  return ForkGaps.of({
    list: lock
      .withPermits(1)(store.read())
      .pipe(Effect.map((stored) => ({ gaps: stored.gaps }))),
    step,
    answerInstall,
  });
});

export const layer = Layer.effect(ForkGaps, make);
