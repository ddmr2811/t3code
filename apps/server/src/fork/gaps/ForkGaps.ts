// Fork-only: the ladder a bot climbs when it lacks a tool, kept in `<stateDir>/fork/gaps.json`.
// The server records each rung and the user's answer to an install. It never runs a command.
import {
  CommandId,
  FORK_GAP_MAX_ATTEMPTS,
  FORK_GAP_MAX_TOKENS,
  FORK_GAPS_DAY_MS,
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
  MessageId,
  type ModelSelection,
  type ProjectId,
  type RuntimeMode,
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

import { DispatchModeLimit } from "../../orchestration-v2/DispatchModeLimit.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ForkBots from "../bots/ForkBots.ts";
import * as ForkCoordination from "../coordination/ForkCoordination.ts";
import { makeForkJsonFileStore } from "../jsonFileStore.ts";

/** The calling thread as it is now; only a bot's own thread records a gap. */
export interface GapSender {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly runtimeMode: RuntimeMode;
  readonly modelSelection: Pick<ModelSelection, "instanceId" | "model">;
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
    /** The user's one answer to one install request; it goes back to the thread that asked. */
    readonly answerInstall: (
      input: ForkGapAnswerInstallInput,
    ) => Effect.Effect<ForkGap, ForkBotsError>;
    /** The gap a thread is climbing now, which narrows what it may delegate and propose. */
    readonly openGap: (threadId: ThreadId) => Effect.Effect<ForkGap | null, ForkBotsError>;
  }
>()("t3/fork/gaps/ForkGaps") {}

const StoredGaps = Schema.Struct({
  version: Schema.Literal(FORK_GAPS_PROTOCOL_VERSION),
  /** Least recently changed first. */
  gaps: Schema.Array(ForkGap),
});
type StoredGaps = typeof StoredGaps.Type;

const decodeStoredGaps = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredGaps));
const decodeStepInput = Schema.decodeUnknownEffect(ForkGapStepInput);
const decodeAnswerInput = Schema.decodeUnknownEffect(ForkGapAnswerInstallInput);

const invalidInput = (message: string) => new ForkBotsError({ reason: "invalidInput", message });
const limitExceeded = (message: string) => new ForkBotsError({ reason: "limitExceeded", message });

/** Solved gaps go, oldest first, once the file passes this; it leaves room under the file limit. */
const GAPS_BUDGET_BYTES = FORK_GAPS_MAX_FILE_BYTES - 64 * 1024;
/** UTF-8 bytes as the store saves them, indented. */
const savedBytes = (stored: StoredGaps) =>
  new TextEncoder().encode(`${JSON.stringify(stored, null, 2)}\n`).byteLength;

const RUNG_TEXT: Record<ForkGapRung, string> = {
  reuse: "Reutilizar",
  install: "Instalar",
  build: "Construir",
  hire: "Contratar un bot",
};
const RESULT_TEXT: Record<ForkGapStep["result"], string> = {
  trying: "empieza",
  worked: "funcionó",
  failed: "falló",
};
const ANSWER_TEXT: Record<ForkGapInstall["answer"], string> = {
  pending: "espera tu sí",
  approved: "aprobada",
  rejected: "rechazada",
  cancelled: "cancelada",
};
const SCOPE_TEXT: Record<ForkGapInstall["scope"], string> = {
  project: "en el proyecto",
  system: "en el sistema",
};
/** A rung opens only after this one failed. Install may be skipped: it needs a way back. */
const OPENS_AFTER: Record<ForkGapRung, ForkGapRung | null> = {
  reuse: null,
  install: "reuse",
  build: "reuse",
  hire: "build",
};

const pendingInstall = (gap: ForkGap) =>
  gap.steps.find((step) => step.install?.answer === "pending")?.install;

/**
 * Why this step is out of order, or null. Only the gap's last step counts: a result closes the
 * attempt right before it, and a new attempt starts only once that one is closed.
 */
function outOfOrder(gap: ForkGap, input: ForkGapStepInput): string | null {
  const last = gap.steps.at(-1);
  if (last?.install?.answer === "pending") return "Wait for the user's answer to the install.";
  if (input.result !== "trying") {
    if (last?.rung !== input.rung || last.result !== "trying") {
      return `Record ${input.rung}/trying right before its result.`;
    }
    if (
      input.result === "worked" &&
      last.install !== undefined &&
      last.install.answer !== "approved"
    ) {
      return "An install the user did not approve cannot have worked.";
    }
    return null;
  }
  if (last?.result === "trying") return `Record how ${last.rung} ended before another attempt.`;
  const before = OPENS_AFTER[input.rung];
  if (
    before !== null &&
    !gap.steps.some((step) => step.rung === before && step.result === "failed")
  ) {
    return `The ${input.rung} rung opens only after ${before} was tried and failed.`;
  }
  if (input.rung === "install" && gap.steps.some((step) => step.install !== undefined)) {
    return "A gap asks for one install. Go on to the build rung.";
  }
  return null;
}

/** Every step in order, so the board shows how the bot got here; an install keeps its way back. */
function boardSummary(gap: ForkGap): string {
  const lines = gap.steps.map((step, index) => {
    const asked = step.install;
    const request =
      asked === undefined
        ? ""
        : ` · ${SCOPE_TEXT[asked.scope]}, ${ANSWER_TEXT[asked.answer]} · ${asked.command} · Vuelta atrás: ${asked.rollback}`;
    return `${index + 1} ${RUNG_TEXT[step.rung]}, ${RESULT_TEXT[step.result]}: ${step.note}${request}`;
  });
  return lines.join("\n").slice(0, 1000);
}

/** What the bot may do after this step. Each rung names the next one, so none is skipped. */
function nextText(step: ForkGapStep, attemptsLeft: number): string {
  const left = `Te quedan ${attemptsLeft} pasos en este hueco.`;
  if (step.result === "worked") return "Hueco resuelto. Sigue con tu tarea.";
  if (step.install !== undefined) {
    return `Petición ${step.install.id} en la bandeja del usuario. NO ejecutes el comando: termina el turno y espera su respuesta, que llegará a este hilo. ${left}`;
  }
  if (step.result === "trying") {
    const how: Record<ForkGapRung, string> = {
      reuse:
        "Busca un bot (bot_handoff), una herramienta MCP o una skill que ya lo haga, y apunta si funcionó o falló.",
      install: "Apunta si la instalación funcionó o falló.",
      build:
        "Delega con delegate_task en esta máquina: hasta que apuntes cómo acabó, el hijo va siempre en un worktree nuevo y con approval-required, y una delegación a otra máquina se rechaza. Debe dejar el script o la herramienta con su prueba; no lo uses hasta que el usuario lo revise.",
      hire: "Propón el bot con bot_propose si coordinas el proyecto; si no, pásaselo al coordinador con bot_handoff.",
    };
    return `${how[step.rung]} ${left}`;
  }
  const after: Record<ForkGapRung, string> = {
    reuse:
      "Siguiente peldaño, instalar: rung install, result trying e install (scope, command, rollback), un solo comando cada uno. Sin vuelta atrás clara no lo pidas: pasa a rung build, result trying.",
    install: "Siguiente peldaño, construir: rung build, result trying.",
    build: "Último peldaño, contratar un bot: rung hire, result trying.",
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

  const nowIso = Effect.map(Clock.currentTimeMillis, (now) =>
    DateTime.formatIso(DateTime.makeUnsafe(now)),
  );

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

  /**
   * The board is the trace; the gap itself is already on disk, so a failed write is logged.
   * Returns whether the entry was written, so the bot is not told of a trace that is not there.
   */
  const trace = Effect.fn("ForkGaps.trace")(function* (gap: ForkGap, bot: ForkBot | undefined) {
    return yield* Effect.gen(function* () {
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
      return true;
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("fork gaps could not trace a gap on the board", {
          gapId: gap.id,
          error,
        }).pipe(Effect.as(false)),
      ),
    );
  });

  /**
   * Holding the lock: the gap and its board entry change together, in order. Only gaps solved
   * more than a day ago are ever dropped: today's count toward the daily quota, and an open or
   * exhausted one keeps its limits for as long as the file exists.
   */
  const save = Effect.fn("ForkGaps.save")(function* (
    stored: StoredGaps,
    gap: ForkGap,
    bot: ForkBot | undefined,
  ) {
    let gaps = [...stored.gaps.filter((candidate) => candidate.id !== gap.id), gap];
    const dayAgo = (yield* Clock.currentTimeMillis) - FORK_GAPS_DAY_MS;
    const dropped: Array<ForkGap> = [];
    while (savedBytes({ version: FORK_GAPS_PROTOCOL_VERSION, gaps }) > GAPS_BUDGET_BYTES) {
      const oldest = gaps.find(
        (candidate) =>
          candidate.status === "solved" &&
          candidate !== gap &&
          Date.parse(candidate.createdAt) <= dayAgo,
      );
      if (oldest === undefined) {
        return yield* limitExceeded(
          "The gap file is full, and nothing in it may be dropped yet. Stop, and tell the user that no more gaps can be recorded on this machine.",
        );
      }
      dropped.push(oldest);
      gaps = gaps.filter((candidate) => candidate !== oldest);
    }
    yield* store.write({ version: FORK_GAPS_PROTOCOL_VERSION, gaps });
    for (const old of dropped) yield* coordination.remove({ id: old.id }).pipe(Effect.ignore);
    return yield* trace(gap, bot);
  });

  /** The one place that says a gap has used up its steps or its tokens. */
  const isSpent = Effect.fn("ForkGaps.isSpent")(function* (gap: ForkGap) {
    return (
      gap.steps.length >= FORK_GAP_MAX_ATTEMPTS || (yield* tokensSpent(gap)) > FORK_GAP_MAX_TOKENS
    );
  });

  /** Holding the lock. A closed gap approves nothing: its pending install goes with it. */
  const close = Effect.fn("ForkGaps.close")(function* (
    stored: StoredGaps,
    gap: ForkGap,
    bot: ForkBot | undefined,
  ) {
    const now = yield* nowIso;
    yield* save(
      stored,
      {
        ...gap,
        status: "exhausted",
        steps: gap.steps.map((done) =>
          done.install?.answer === "pending"
            ? { ...done, install: { ...done.install, answer: "cancelled", decidedAt: now } }
            : done,
        ),
        updatedAt: now,
      },
      bot,
    );
  });

  const step = Effect.fn("ForkGaps.step")(function* (input: ForkGapStepInput, from: GapSender) {
    const parsed = yield* decodeStepInput(input).pipe(
      Effect.mapError(() =>
        invalidInput(
          "Invalid gap step. Each text is one short line. An install needs scope, command and rollback, each a single command with no ; & | ` < > or $(: without a way back it is not proposed.",
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
    // The provider then asks the user again for the exact command when the bot runs it.
    if (parsed.install?.scope === "system" && from.runtimeMode !== "approval-required") {
      return yield* new ForkBotsError({
        reason: "permissionDenied",
        message: `A system install is asked only from a thread in approval-required; this one runs in ${from.runtimeMode}. Tell the user what is missing.`,
      });
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
        if (yield* isSpent(gap)) {
          yield* close(stored, gap, bot);
          return yield* limitExceeded(closed);
        }
        const problem = outOfOrder(gap, parsed);
        if (problem !== null) return yield* invalidInput(problem);
        // An install needs a second step for how it ended.
        if (asksInstall && gap.steps.length + 2 > FORK_GAP_MAX_ATTEMPTS) {
          return yield* limitExceeded(
            "This gap has no steps left for an install and its result. Stop, and tell the user what is missing.",
          );
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
                  runtimeMode: from.runtimeMode,
                  instanceId: from.modelSelection.instanceId,
                  model: from.modelSelection.model,
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
        const onBoard = yield* save(stored, next, bot);
        const text = nextText(recorded, FORK_GAP_MAX_ATTEMPTS - next.steps.length);
        return {
          gap: next,
          next: onBoard
            ? text
            : `${text} Aviso: el tablero del proyecto no admitió este paso; díselo al usuario.`,
        };
      }),
    );
  });

  /**
   * The thread that asked, while the answer may still go to it: the gap is open, the bot still
   * lives in that thread and project, and the thread kept the mode, provider and model it asked
   * with (a failover changes them). Null otherwise.
   */
  const askingThread = Effect.fn("ForkGaps.askingThread")(function* (
    gap: ForkGap,
    install: ForkGapInstall,
    bot: ForkBot | undefined,
  ) {
    if (gap.status !== "open" || bot === undefined || bot.archived) return null;
    if (bot.threadId !== gap.threadId || bot.projectId !== gap.projectId) return null;
    const thread = yield* threads
      .getThreadShell(gap.threadId)
      .pipe(Effect.orElseSucceed(() => null));
    return thread !== null &&
      thread.archivedAt === null &&
      thread.deletedAt === null &&
      thread.projectId === gap.projectId &&
      thread.runtimeMode === install.runtimeMode &&
      thread.modelSelection.instanceId === install.instanceId &&
      thread.modelSelection.model === install.model
      ? thread
      : null;
  });

  const answerInstall = Effect.fn("ForkGaps.answerInstall")(function* (
    input: ForkGapAnswerInstallInput,
  ) {
    const parsed = yield* decodeAnswerInput(input).pipe(
      Effect.mapError(() => invalidInput("Invalid install answer.")),
    );
    // One lock from the check to the board: a second answer, or a step in between, waits.
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const stored = yield* store.read();
        // Read under the lock, so a bot edited while this waited is seen as it is now.
        const { bots } = yield* forkBots.list({});
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
        const approves = parsed.answer === "approve";
        if (approves && (yield* isSpent(gap))) {
          yield* close(stored, gap, bot);
          return yield* new ForkBotsError({
            reason: "conflict",
            message: "Cancelada: el hueco agotó su tope de pasos o de tokens. No se aprobó nada.",
          });
        }
        const thread = yield* askingThread(gap, asked, bot);
        const reachable = thread !== null;
        const withAnswer = (
          answer: ForkGapInstall["answer"],
          decidedAt: ForkGapInstall["decidedAt"],
        ): ForkGap => ({
          ...gap,
          steps: gap.steps.map((done) =>
            done.install?.id === parsed.id
              ? { ...done, install: { ...asked, answer, decidedAt } }
              : done,
          ),
        });
        const now = yield* nowIso;
        if (!reachable) {
          const answer = approves ? "cancelled" : "rejected";
          const closed = withAnswer(answer, now);
          yield* save(stored, closed, bot);
          return !approves
            ? closed
            : yield* new ForkBotsError({
                reason: "conflict",
                message:
                  "Cancelada: el hueco se cerró, o el bot o su hilo cambiaron desde que lo pidió. No se aprobó nada.",
              });
        }
        // A yes never waits in a queue, where the thread's mode could change before it starts.
        if (approves && thread.activeRunId !== null) {
          return yield* new ForkBotsError({
            reason: "conflict",
            message: "Espera a que el bot termine su turno; la petición sigue pendiente.",
          });
        }
        const decided = withAnswer(approves ? "approved" : "rejected", now);
        const install = decided.steps.find((done) => done.install?.id === parsed.id)!.install!;
        yield* save(stored, decided, bot);
        // Straight to the thread that asked, never to wherever the bot is now. The orchestrator
        // rechecks the mode under its own lock, in case it rose after the check above. The id
        // comes from the request, so a retry after a lost reply is not delivered twice.
        const messageId = MessageId.make(`fork-gap-answer:${asked.id}:${parsed.answer}`);
        const sent = yield* threads
          .sendToThread({
            projectId: gap.projectId,
            commandId: CommandId.make(messageId),
            threadId: gap.threadId,
            messageId,
            text: answerText(decided, install),
            attachments: [],
            mode: "queue",
            createdBy: "user",
            creationSource: "web",
          })
          .pipe(
            Effect.provideService(DispatchModeLimit, {
              runtimeMode: asked.runtimeMode,
              interactionMode: "default",
            }),
            Effect.result,
          );
        if (sent._tag === "Failure") {
          // The answer is not spent on a message that never left: it waits again.
          yield* save(stored, withAnswer("pending", null), bot);
          return yield* new ForkBotsError({
            reason: "dispatchFailed",
            message:
              "No se pudo entregar tu respuesta al hilo del bot; la petición sigue pendiente. Vuelve a intentarlo.",
          });
        }
        return decided;
      }),
    );
  });

  const openGap = Effect.fn("ForkGaps.openGap")(function* (threadId: ThreadId) {
    const stored = yield* lock.withPermits(1)(store.read());
    return (
      stored.gaps.findLast(
        (candidate) => candidate.status === "open" && candidate.threadId === threadId,
      ) ?? null
    );
  });

  return ForkGaps.of({
    list: lock
      .withPermits(1)(store.read())
      .pipe(Effect.map((stored) => ({ gaps: stored.gaps }))),
    step,
    answerInstall,
    openGap,
  });
});

export const layer = Layer.effect(ForkGaps, make);
