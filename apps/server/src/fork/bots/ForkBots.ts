// @effect-diagnostics nodeBuiltinImport:off - sha256 of the injected memory has no Effect equivalent.
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  FORK_BOTS_HANDOFF_HISTORY,
  FORK_BOTS_HANDOFF_MAX_HOPS,
  FORK_BOTS_HANDOFF_PREVIEW_LENGTH,
  FORK_BOTS_MAX_COUNT,
  FORK_BOTS_MAX_FILE_BYTES,
  type ForkBot,
  ForkBotDismissHandoffInput,
  type ForkBotHandoff,
  ForkBotHandoffInput,
  type ForkBotHandoffResult,
  type ForkMemoryNote,
  ForkBotListInput,
  type ForkBotListResult,
  ForkBotRemoveInput,
  type ForkBotRemoveResult,
  ForkBotSendMessageInput,
  type ForkBotSendMessageResult,
  ForkBotSetArchivedInput,
  ForkBotsError,
  ForkBotUpsertInput,
  MessageId,
  type ModelSelection,
  type ProjectId,
  type ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
  type ThreadId,
  isProviderNativeSubagentThread,
  isRuntimeModeAbove,
  projectKeyFromName,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  DispatchModeLimit,
  type DispatchModes,
  exceededDispatchModeLimit,
} from "../../orchestration-v2/DispatchModeLimit.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ScheduledTasks from "../../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ForkCoordination from "../coordination/ForkCoordination.ts";
import * as ForkProjectMemory from "../memory/ForkProjectMemory.ts";
import { makeForkJsonFileStore } from "../jsonFileStore.ts";
import {
  decodeStoredBotDirectory,
  EMPTY_BOT_DIRECTORY,
  listBots,
  type StoredBotDirectory,
} from "./store.ts";

export class ForkBots extends Context.Service<
  ForkBots,
  {
    readonly list: (input: ForkBotListInput) => Effect.Effect<ForkBotListResult, ForkBotsError>;
    readonly upsert: (input: ForkBotUpsertInput) => Effect.Effect<ForkBot, ForkBotsError>;
    readonly setArchived: (input: ForkBotSetArchivedInput) => Effect.Effect<ForkBot, ForkBotsError>;
    readonly remove: (
      input: ForkBotRemoveInput,
    ) => Effect.Effect<ForkBotRemoveResult, ForkBotsError>;
    readonly sendMessage: (
      input: ForkBotSendMessageInput,
    ) => Effect.Effect<ForkBotSendMessageResult, ForkBotsError>;
    readonly handoff: (
      input: ForkBotHandoffInput,
      sender: HandoffSender,
    ) => Effect.Effect<ForkBotHandoffResult, ForkBotsError>;
    readonly dismissHandoff: (
      input: ForkBotDismissHandoffInput,
    ) => Effect.Effect<ForkBotHandoff, ForkBotsError>;
    /** Whether a thread is a bot's current one; answered from memory. */
    readonly isBotThread: (threadId: ThreadId) => Effect.Effect<boolean>;
  }
>()("t3/fork/bots/ForkBots") {}

/**
 * Who hands the work over. The user (an @mention in the ADE) already holds the RPC scope; an
 * agent is its bot's own thread, which may not make a bot with broader modes work.
 */
export type HandoffSender =
  | { readonly kind: "user" }
  | { readonly kind: "agent"; readonly limits: DispatchModes };

const decodeListInput = Schema.decodeUnknownEffect(ForkBotListInput);
const decodeUpsertInput = Schema.decodeUnknownEffect(ForkBotUpsertInput);
const decodeSetArchivedInput = Schema.decodeUnknownEffect(ForkBotSetArchivedInput);
const decodeRemoveInput = Schema.decodeUnknownEffect(ForkBotRemoveInput);
const decodeSendMessageInput = Schema.decodeUnknownEffect(ForkBotSendMessageInput);
const decodeHandoffInput = Schema.decodeUnknownEffect(ForkBotHandoffInput);
const decodeDismissHandoffInput = Schema.decodeUnknownEffect(ForkBotDismissHandoffInput);

const invalidInput = (message: string) => new ForkBotsError({ reason: "invalidInput", message });
const notFound = (message: string) => new ForkBotsError({ reason: "notFound", message });
const unavailable = (message: string) => new ForkBotsError({ reason: "unavailable", message });
const dispatchFailed = (message: string) =>
  new ForkBotsError({ reason: "dispatchFailed", message });

function toModelSelection(bot: ForkBot): ModelSelection {
  return {
    instanceId: bot.modelSelection.instanceId,
    model: bot.modelSelection.model,
    ...(bot.modelSelection.options === undefined ? {} : { options: bot.modelSelection.options }),
  };
}

const COORDINATOR_INSTRUCTIONS = [
  "--- PAPEL DE COORDINADOR DEL PROYECTO ---",
  "Coordinas este proyecto. En cada encargo:",
  "1. Al empezar cada tarea, consulta la memoria del proyecto con project_memory_search. Las notas esenciales llegan además en <project_memory> cuando cambian.",
  "2. Reparte el trabajo en hilos hijos con las herramientas de delegación (delegate_task) y no lo hagas tú todo.",
  "3. Recoge sus resultados y comprueba que responden al encargo.",
  "4. Guarda en la memoria con project_memory_save, sin que te lo pidan, solo lo importante y duradero: decisiones, convenciones, datos que costó averiguar.",
  "--- FIN DEL PAPEL DE COORDINADOR ---",
].join("\n");

function initialBotMessage(bot: ForkBot, text: string): string {
  return [
    `Actúa como el bot «${bot.name}». Rol: ${bot.role}.`,
    "Las instrucciones del operador están delimitadas a continuación; la solicitud del usuario va aparte.",
    "",
    ...(bot.coordinator ? [COORDINATOR_INSTRUCTIONS, ""] : []),
    "--- INSTRUCCIONES DEL BOT ---",
    bot.instructions,
    "--- FIN DE INSTRUCCIONES ---",
    "",
    "--- SOLICITUD DEL USUARIO ---",
    text,
    "--- FIN DE SOLICITUD ---",
  ].join("\n");
}

/**
 * Null when there is nothing to inject, so an empty memory never sends an empty block. The
 * thread's model is part of it: after a failover or a model switch the new provider has not seen it.
 */
function memoryHash(
  notes: ReadonlyArray<ForkMemoryNote>,
  model: Pick<ModelSelection, "instanceId" | "model">,
): string | null {
  if (notes.length === 0) return null;
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify([model.instanceId, model.model, notes.map((note) => note.text)]))
    .digest("hex");
}

function memoryBlock(notes: ReadonlyArray<ForkMemoryNote>): string {
  const lines =
    notes.length === 0
      ? ["(sin notas esenciales)"]
      : // A note cannot close the block or open a tag of its own.
        notes.map((note) => `- ${note.text.replaceAll("<", "‹").replaceAll(">", "›")}`);
  return [
    "<project_memory>",
    "Notas esenciales del proyecto (sustituyen a las que recibiste antes):",
    ...lines,
    "</project_memory>",
  ].join("\n");
}

function handoffMessage(handoff: ForkBotHandoff, from: ForkBot, text: string): string {
  return [
    `--- TRASPASO de @${from.handle} (${from.name}) · ${handoff.id} · salto ${handoff.hops} de ${FORK_BOTS_HANDOFF_MAX_HOPS} ---`,
    text,
    "--- FIN DEL TRASPASO ---",
  ].join("\n");
}

function threadConfigChanged(
  existing: ForkBot,
  next: Pick<
    ForkBot,
    | "role"
    | "instructions"
    | "projectId"
    | "runtimeMode"
    | "modelSelection"
    | "name"
    | "coordinator"
  >,
): boolean {
  return (
    existing.name !== next.name ||
    existing.coordinator !== next.coordinator ||
    existing.role !== next.role ||
    existing.instructions !== next.instructions ||
    existing.projectId !== next.projectId ||
    existing.runtimeMode !== next.runtimeMode ||
    JSON.stringify(existing.modelSelection) !== JSON.stringify(next.modelSelection)
  );
}

function isThreadNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    ((error as { _tag?: unknown })._tag === "OrchestratorThreadNotFoundError" ||
      (error as { _tag?: unknown })._tag === "ProjectionStoreThreadNotFoundError" ||
      (error as { _tag?: unknown })._tag === "ThreadManagementThreadNotFoundError")
  );
}

function providerIsSelectable(provider: ServerProvider): boolean {
  return (
    provider.enabled &&
    provider.installed &&
    provider.status !== "disabled" &&
    provider.status !== "error" &&
    provider.availability !== "unavailable" &&
    provider.auth.status !== "unauthenticated"
  );
}

const make = Effect.gen(function* () {
  const rawStore = yield* makeForkJsonFileStore({
    fileName: "bots.json",
    label: "Bot store",
    maxBytes: FORK_BOTS_MAX_FILE_BYTES,
    empty: EMPTY_BOT_DIRECTORY,
    decode: decodeStoredBotDirectory,
    makeError: (reason, message) => new ForkBotsError({ reason, message }),
  });
  // MCP asks on every request whether the caller is a bot's thread, so the answer stays in memory.
  const botThreads = yield* Ref.make<ReadonlySet<ThreadId>>(new Set());
  const remember = (directory: StoredBotDirectory) =>
    Ref.set(
      botThreads,
      new Set(directory.bots.flatMap((bot) => (bot.threadId === null ? [] : [bot.threadId]))),
    );
  const fileStore = {
    read: () => rawStore.read().pipe(Effect.tap(remember)),
    write: (directory: StoredBotDirectory) =>
      rawStore.write(directory).pipe(Effect.andThen(remember(directory))),
  };
  yield* fileStore.read().pipe(Effect.ignore);
  const storeLock = yield* Semaphore.make(1);
  const botLocks = yield* KeyedLock.make<ForkBot["id"]>();
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const instanceRegistry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const scheduledTasks = yield* ScheduledTasks.ScheduledTaskService;

  /**
   * A routine copies the mode and model of the thread it continues. When the bot leaves that
   * thread, its routines would keep running there unseen, so they are paused.
   */
  const pauseRoutines = Effect.fn("ForkBots.pauseRoutines")(function* (
    botId: ForkBot["id"],
    threadId: ThreadId,
  ) {
    yield* Effect.gen(function* () {
      const { tasks } = yield* scheduledTasks.list();
      for (const task of tasks) {
        if (task.threadId !== threadId || !task.enabled) continue;
        yield* scheduledTasks.setEnabled({ id: task.id, enabled: false });
      }
    }).pipe(
      // Failing the change keeps the bot where it was, so no routine is left running unseen.
      Effect.catch((error) =>
        Effect.logWarning("fork bots could not pause the routines of a previous thread", {
          botId,
          threadId,
          error,
        }).pipe(
          Effect.andThen(
            Effect.fail(
              unavailable(
                `Could not pause the routines of bot ${botId} in thread ${threadId}; nothing was changed.`,
              ),
            ),
          ),
        ),
      ),
    );
  });
  const memory = yield* ForkProjectMemory.ForkProjectMemory;
  const coordination = yield* ForkCoordination.ForkCoordination;

  const nowIso = Effect.map(Clock.currentTimeMillis, (now) =>
    DateTime.formatIso(DateTime.makeUnsafe(now)),
  );

  const validateConfiguration = Effect.fn("ForkBots.validateConfiguration")(function* (input: {
    readonly projectId: ProjectId;
    readonly runtimeMode: RuntimeMode;
    readonly instanceId: ProviderInstanceId;
    readonly model: string;
  }) {
    const project = yield* projects
      .getById(input.projectId)
      .pipe(Effect.mapError(() => unavailable("Could not verify the bot project.")));
    if (Option.isNone(project)) return yield* notFound("Bot project was not found.");

    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(() => unavailable("Could not verify bot policy and providers.")),
    );
    const ceiling = serverSettings.managedPolicy?.limits?.maxRuntimeMode;
    if (isRuntimeModeAbove(input.runtimeMode, ceiling)) {
      return yield* invalidInput("Bot permission mode exceeds the environment policy ceiling.");
    }

    const [providers, liveInstances] = yield* Effect.all([
      providerRegistry.getProviders.pipe(
        Effect.mapError(() => unavailable("Could not verify bot providers.")),
      ),
      instanceRegistry.listInstances.pipe(
        Effect.mapError(() => unavailable("Could not verify bot providers.")),
      ),
    ]);
    // An empty catalog is still loading; ThreadLaunch repeats the authoritative enablement check.
    if (providers.length === 0) return;
    const liveIds = new Set(liveInstances.map((instance) => instance.instanceId));
    const provider = providers.find(
      (candidate) => candidate.instanceId === input.instanceId && liveIds.has(candidate.instanceId),
    );
    if (
      provider === undefined ||
      !providerIsSelectable(provider) ||
      !resolveProjectProviderInstanceEnabled(settings, input.projectId, input.instanceId)
    ) {
      return yield* unavailable("The selected provider is not available for this project.");
    }
    if (
      provider.models.length > 0 &&
      !provider.models.some((model) => model.slug === input.model && model.isLegacy !== true)
    ) {
      return yield* invalidInput("The selected model is not available for this provider.");
    }
  });

  const list = Effect.fn("ForkBots.list")(function* (input: ForkBotListInput) {
    yield* decodeListInput(input).pipe(Effect.mapError(() => invalidInput("Invalid bot filter.")));
    return listBots(yield* storeLock.withPermits(1)(fileStore.read()));
  });

  const upsert = Effect.fn("ForkBots.upsert")(function* (input: ForkBotUpsertInput) {
    const parsed = yield* decodeUpsertInput(input).pipe(
      Effect.mapError(() => invalidInput("Invalid bot configuration.")),
    );
    const id = parsed.id ?? `bot:${SecureRandom.uuidV4Unsafe()}`;
    return yield* botLocks.withLock(
      id,
      storeLock.withPermits(1)(
        Effect.gen(function* () {
          const directory = yield* fileStore.read();
          const existing =
            parsed.id === undefined
              ? undefined
              : directory.bots.find((bot) => bot.id === parsed.id);
          if (parsed.id !== undefined && existing === undefined) {
            return yield* notFound("Bot was not found.");
          }
          if (
            directory.bots.some(
              (bot) => bot.id !== id && bot.handle.toLowerCase() === parsed.handle.toLowerCase(),
            )
          ) {
            return yield* new ForkBotsError({
              reason: "conflict",
              message: "Another bot already uses this handle.",
            });
          }
          const coordinator = parsed.coordinator ?? existing?.coordinator ?? false;
          const otherCoordinator = directory.bots.find(
            (bot) => bot.id !== id && bot.coordinator && bot.projectId === parsed.projectId,
          );
          if (coordinator && otherCoordinator !== undefined) {
            return yield* new ForkBotsError({
              reason: "conflict",
              message: `Project ${parsed.projectId} already has a coordinator: ${otherCoordinator.id}.`,
            });
          }
          if (existing === undefined && directory.bots.length >= FORK_BOTS_MAX_COUNT) {
            return yield* new ForkBotsError({
              reason: "limitExceeded",
              message: `Bot directory cannot hold more than ${FORK_BOTS_MAX_COUNT} bots.`,
            });
          }
          const runtimeMode = parsed.runtimeMode ?? existing?.runtimeMode ?? "approval-required";
          yield* validateConfiguration({
            projectId: parsed.projectId,
            runtimeMode,
            instanceId: parsed.modelSelection.instanceId,
            model: parsed.modelSelection.model,
          });
          const now = yield* nowIso;
          const draft = {
            id,
            handle: parsed.handle,
            name: parsed.name,
            role: parsed.role,
            instructions: parsed.instructions,
            projectId: parsed.projectId,
            runtimeMode,
            modelSelection: parsed.modelSelection,
            coordinator,
          };
          // The thread was started with the old prompt, mode, and model; the next message starts
          // a fresh one so the bot never silently overrides what the user set on that thread.
          const kept =
            existing !== undefined && !threadConfigChanged(existing, draft) ? existing : undefined;
          const bot: ForkBot = {
            ...draft,
            threadId: kept?.threadId ?? null,
            memoryHash: kept?.memoryHash ?? null,
            handoffHops: existing?.handoffHops ?? 0,
            archived: existing?.archived ?? false,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
          };
          const bots =
            existing === undefined
              ? [...directory.bots, bot]
              : directory.bots.map((candidate) => (candidate.id === id ? bot : candidate));
          if (existing?.threadId != null && kept === undefined) {
            yield* pauseRoutines(id, existing.threadId);
          }
          yield* fileStore.write({ ...directory, bots, updatedAt: now });
          return bot;
        }),
      ),
    );
  });

  const setArchived = Effect.fn("ForkBots.setArchived")(function* (input: ForkBotSetArchivedInput) {
    const parsed = yield* decodeSetArchivedInput(input).pipe(
      Effect.mapError(() => invalidInput("Invalid bot archive request.")),
    );
    return yield* botLocks.withLock(
      parsed.id,
      storeLock.withPermits(1)(
        Effect.gen(function* () {
          const directory = yield* fileStore.read();
          const existing = directory.bots.find((bot) => bot.id === parsed.id);
          if (existing === undefined) return yield* notFound("Bot was not found.");
          if (existing.archived === parsed.archived) return existing;
          const now = yield* nowIso;
          const bot = { ...existing, archived: parsed.archived, updatedAt: now };
          yield* fileStore.write({
            ...directory,
            bots: directory.bots.map((candidate) => (candidate.id === bot.id ? bot : candidate)),
            updatedAt: now,
          });
          return bot;
        }),
      ),
    );
  });

  const remove = Effect.fn("ForkBots.remove")(function* (input: ForkBotRemoveInput) {
    const parsed = yield* decodeRemoveInput(input).pipe(
      Effect.mapError(() => invalidInput("Invalid bot id.")),
    );
    return yield* botLocks.withLock(
      parsed.id,
      storeLock.withPermits(1)(
        Effect.gen(function* () {
          const directory = yield* fileStore.read();
          const removed = directory.bots.find((bot) => bot.id === parsed.id);
          if (removed === undefined) return { id: parsed.id, removed: false };
          const bots = directory.bots.filter((bot) => bot.id !== parsed.id);
          if (removed.threadId !== null) yield* pauseRoutines(removed.id, removed.threadId);
          const now = yield* nowIso;
          yield* fileStore.write({ ...directory, bots, updatedAt: now });
          // The T3 thread is deliberately untouched: removing a bot never deletes its history.
          return { id: parsed.id, removed: true };
        }),
      ),
    );
  });

  /** After a message went out the bot's thread exists, so a failed write is only logged. */
  const recordDelivery = Effect.fn("ForkBots.recordDelivery")(function* (
    bot: ForkBot,
    patch: Partial<Pick<ForkBot, "threadId" | "memoryHash" | "handoffHops">>,
  ) {
    const now = yield* nowIso;
    const updated: ForkBot = { ...bot, ...patch, updatedAt: now };
    yield* storeLock
      .withPermits(1)(
        Effect.gen(function* () {
          const directory = yield* fileStore.read();
          yield* fileStore.write({
            ...directory,
            bots: directory.bots.map((candidate) =>
              candidate.id === bot.id ? { ...candidate, ...patch, updatedAt: now } : candidate,
            ),
            updatedAt: now,
          });
        }),
      )
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("fork bots could not record the delivered message", {
            botId: bot.id,
            reason: error.reason,
          }),
        ),
      );
    return updated;
  });

  const readBot = (id: ForkBot["id"]) =>
    storeLock
      .withPermits(1)(fileStore.read())
      .pipe(
        Effect.flatMap((directory) => {
          const found = directory.bots.find((candidate) => candidate.id === id);
          return found === undefined
            ? Effect.fail(notFound("Bot was not found."))
            : Effect.succeed(found);
        }),
      );

  /**
   * The one way a message reaches a bot's thread, from the user or from another bot. Callers hold
   * the bot's lock, so each bot has one queue. `limits` are an agent sender's modes.
   */
  const deliver = Effect.fn("ForkBots.deliver")(function* (
    bot: ForkBot,
    text: string,
    patch: Partial<Pick<ForkBot, "handoffHops">>,
    limits: DispatchModes | undefined,
  ) {
    if (bot.archived) return yield* invalidInput("Restore the bot before sending a message.");

    let existingThread: ThreadId | null = null;
    let threadModel: Pick<ModelSelection, "instanceId" | "model"> = bot.modelSelection;
    let modes: DispatchModes = { runtimeMode: bot.runtimeMode, interactionMode: "default" };
    if (bot.threadId !== null) {
      const outcome = yield* threads.getThreadRecords(bot.threadId, ["runs"]).pipe(Effect.result);
      if (outcome._tag === "Success") {
        const thread = outcome.success.thread;
        if (thread.projectId !== bot.projectId) {
          return yield* dispatchFailed("Bot thread belongs to a different project.");
        }
        if (thread.archivedAt === null && thread.deletedAt === null) {
          if (isProviderNativeSubagentThread(thread)) {
            return yield* dispatchFailed("A bot cannot use a provider-native subagent thread.");
          }
          existingThread = bot.threadId;
          threadModel = thread.modelSelection;
          // The user may have raised the thread's modes above the bot's own.
          modes = { runtimeMode: thread.runtimeMode, interactionMode: thread.interactionMode };
        }
      } else if (!isThreadNotFoundError(outcome.failure)) {
        return yield* dispatchFailed("Could not load the bot thread.");
      }
    }
    // Same rule as assertTargetWithinLimits: a sender never makes broader modes work for it.
    if (limits !== undefined && exceededDispatchModeLimit(limits, modes) !== undefined) {
      return yield* new ForkBotsError({
        reason: "permissionDenied",
        message: `Bot @${bot.handle} runs in ${modes.runtimeMode}/${modes.interactionMode}, above this sender's ${limits.runtimeMode}/${limits.interactionMode}. Ask the user to send it the work.`,
      });
    }

    const essentials = bot.coordinator
      ? yield* memory
          .essentials(bot.projectId)
          .pipe(
            Effect.mapError((error) =>
              unavailable(`Could not read the memory for bot ${bot.id}: ${error.message}`),
            ),
          )
      : [];
    const hash = memoryHash(essentials, threadModel);
    // A new thread has seen nothing yet; an existing one gets the block only when it changed.
    const injects = existingThread === null ? hash !== null : hash !== bot.memoryHash;
    const withMemory = (message: string) =>
      injects ? `${memoryBlock(essentials)}\n\n${message}` : message;

    if (existingThread === null) {
      yield* validateConfiguration({
        projectId: bot.projectId,
        runtimeMode: bot.runtimeMode,
        instanceId: bot.modelSelection.instanceId,
        model: bot.modelSelection.model,
      });
      const commandId = CommandId.make(`fork-bot-launch:${bot.id}:${SecureRandom.uuidV4Unsafe()}`);
      const launched = yield* launches
        .launch({
          commandId,
          projectId: bot.projectId,
          title: bot.name,
          generateTitle: false,
          modelSelection: toModelSelection(bot),
          runtimeMode: bot.runtimeMode,
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          initialMessage: { text: withMemory(initialBotMessage(bot, text)), attachments: [] },
          createdBy: "user",
          creationSource: "web",
        })
        .pipe(Effect.mapError(() => dispatchFailed("Could not create the bot thread.")));
      // The thread already exists and holds the message; failing here would make a retry
      // launch a duplicate, so a lost link only means the next message starts another thread.
      const linked = yield* recordDelivery(bot, {
        threadId: launched.threadId,
        memoryHash: hash,
        ...patch,
      });
      return { bot: linked, threadId: launched.threadId, queued: false };
    }

    const messageId = MessageId.make(`fork-bot-message:${SecureRandom.uuidV4Unsafe()}`);
    const send = threads
      .sendToThread({
        projectId: bot.projectId,
        commandId: CommandId.make(messageId),
        threadId: existingThread,
        messageId,
        text: withMemory(text),
        attachments: [],
        mode: "queue",
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(Effect.mapError(() => dispatchFailed("Could not send the bot message.")));
    // The orchestrator rechecks the modes under its lock, in case they rose after the check above.
    const sent = yield* limits === undefined
      ? send
      : send.pipe(Effect.provideService(DispatchModeLimit, limits));
    const changes = {
      ...(injects ? { memoryHash: hash } : {}),
      ...(patch.handoffHops === undefined || patch.handoffHops === bot.handoffHops ? {} : patch),
    };
    // A lost hash only means the next message repeats the same block.
    const delivered = Object.keys(changes).length > 0 ? yield* recordDelivery(bot, changes) : bot;
    return { bot: delivered, threadId: existingThread, queued: sent.delivery === "queued" };
  });

  const sendMessage = Effect.fn("ForkBots.sendMessage")(function* (input: ForkBotSendMessageInput) {
    const parsed = yield* decodeSendMessageInput(input).pipe(
      Effect.mapError(() => invalidInput("Invalid bot message.")),
    );
    return yield* botLocks.withLock(
      parsed.id,
      Effect.gen(function* () {
        const bot = yield* readBot(parsed.id);
        // The user stepping in starts any later handoff chain from zero.
        return yield* deliver(bot, parsed.text, { handoffHops: 0 }, undefined);
      }),
    );
  });

  /** The board is a trace; the handoff itself is already on disk, so a failed write is logged. */
  const traceHandoff = Effect.fn("ForkBots.traceHandoff")(function* (
    handoff: ForkBotHandoff,
    from: ForkBot,
    to: ForkBot,
    threadId: ThreadId | null,
  ) {
    yield* Effect.gen(function* () {
      const project = yield* projects.getById(to.projectId);
      const projectName = Option.match(project, {
        onNone: () => to.projectId,
        onSome: (found) => found.title,
      });
      const summary = `Traspaso de @${from.handle} a @${to.handle}: ${handoff.preview}`;
      yield* coordination.upsert({
        id: handoff.id,
        projectKey: projectKeyFromName(projectName, to.projectId),
        projectName: projectName.slice(0, 160),
        ...(threadId === null ? {} : { threadId }),
        agentName: to.name,
        status: handoff.status === "cut" ? "blocked" : "done",
        workingOn: "",
        completedSummary:
          handoff.status === "dismissed" ? `Descartado por el usuario. ${summary}` : summary,
        waitingFor:
          handoff.status === "cut"
            ? `Cortado: más de ${FORK_BOTS_HANDOFF_MAX_HOPS} saltos seguidos entre bots. Decide en la bandeja.`
            : "",
      });
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("fork bots could not trace a handoff on the board", {
          handoffId: handoff.id,
          error,
        }),
      ),
    );
  });

  /** Callers hold the store lock. */
  const saveHandoff = Effect.fn("ForkBots.saveHandoff")(function* (handoff: ForkBotHandoff) {
    const directory = yield* fileStore.read();
    const now = yield* nowIso;
    yield* fileStore.write({
      ...directory,
      handoffs: [
        ...directory.handoffs.filter((candidate) => candidate.id !== handoff.id),
        handoff,
      ].slice(-FORK_BOTS_HANDOFF_HISTORY),
      updatedAt: now,
    });
  });

  const handoff = Effect.fn("ForkBots.handoff")(function* (
    input: ForkBotHandoffInput,
    sender: HandoffSender,
  ) {
    const parsed = yield* decodeHandoffInput(input).pipe(
      Effect.mapError(() => invalidInput("Invalid handoff.")),
    );
    const target = (yield* storeLock.withPermits(1)(fileStore.read())).bots.find(
      (bot) => bot.handle.toLowerCase() === parsed.toHandle.toLowerCase(),
    );
    if (target === undefined) return yield* notFound(`No bot uses the handle @${parsed.toHandle}.`);

    // The receiving bot's lock: a handoff waits in the same one queue as the user's messages.
    return yield* botLocks.withLock(
      target.id,
      Effect.gen(function* () {
        const now = yield* nowIso;
        // Checking the id and saving the handoff in one write is what makes a repeat a no-op.
        const reserved = yield* storeLock.withPermits(1)(
          Effect.gen(function* () {
            const directory = yield* fileStore.read();
            const from = directory.bots.find((bot) => bot.id === parsed.fromId);
            const to = directory.bots.find((bot) => bot.id === target.id);
            if (from === undefined || to === undefined) {
              return yield* notFound("Bot was not found.");
            }
            const seen = directory.handoffs.find((candidate) => candidate.id === parsed.id);
            if (seen !== undefined && seen.status !== "failed") {
              return { from, to, handoff: seen, duplicate: true };
            }
            if (from.id === to.id) {
              return yield* invalidInput(`@${to.handle} cannot hand work to itself.`);
            }
            const hops = sender.kind === "user" ? 1 : from.handoffHops + 1;
            const record: ForkBotHandoff = {
              id: parsed.id,
              fromBotId: from.id,
              toBotId: to.id,
              origin: sender.kind,
              hops,
              status: hops > FORK_BOTS_HANDOFF_MAX_HOPS ? "cut" : "delivered",
              preview: parsed.text
                .replaceAll(/\s+/g, " ")
                .slice(0, FORK_BOTS_HANDOFF_PREVIEW_LENGTH),
              createdAt: now,
            };
            yield* saveHandoff(record);
            return { from, to, handoff: record, duplicate: false };
          }),
        );
        const { from, to, handoff: record } = reserved;
        if (reserved.duplicate) {
          return {
            handoff: record,
            threadId: record.status === "delivered" ? to.threadId : null,
            duplicate: true,
          };
        }
        if (record.status === "cut") {
          yield* traceHandoff(record, from, to, null);
          return { handoff: record, threadId: null, duplicate: false };
        }
        const sent = yield* deliver(
          to,
          handoffMessage(record, from, parsed.text),
          { handoffHops: record.hops },
          sender.kind === "agent" ? sender.limits : undefined,
        ).pipe(
          // A failed handoff may be sent again with the same id.
          Effect.tapError(() =>
            storeLock
              .withPermits(1)(saveHandoff({ ...record, status: "failed" }))
              .pipe(Effect.ignore),
          ),
        );
        yield* traceHandoff(record, from, to, sent.threadId);
        return { handoff: record, threadId: sent.threadId, duplicate: false };
      }),
    );
  });

  const dismissHandoff = Effect.fn("ForkBots.dismissHandoff")(function* (
    input: ForkBotDismissHandoffInput,
  ) {
    const parsed = yield* decodeDismissHandoffInput(input).pipe(
      Effect.mapError(() => invalidInput("Invalid handoff id.")),
    );
    const { record, from, to } = yield* storeLock.withPermits(1)(
      Effect.gen(function* () {
        const directory = yield* fileStore.read();
        const found = directory.handoffs.find((candidate) => candidate.id === parsed.id);
        if (found === undefined) return yield* notFound("Handoff was not found.");
        if (found.status === "dismissed") return { record: found, from: undefined, to: undefined };
        if (found.status !== "cut") {
          return yield* invalidInput("Only a cut handoff can be dismissed.");
        }
        const dismissed: ForkBotHandoff = { ...found, status: "dismissed" };
        yield* saveHandoff(dismissed);
        return {
          record: dismissed,
          from: directory.bots.find((bot) => bot.id === found.fromBotId),
          to: directory.bots.find((bot) => bot.id === found.toBotId),
        };
      }),
    );
    if (from !== undefined && to !== undefined) yield* traceHandoff(record, from, to, null);
    return record;
  });

  return ForkBots.of({
    list,
    upsert,
    setArchived,
    remove,
    sendMessage,
    handoff,
    dismissHandoff,
    // Untraced: /mcp asks on every request, inside the request's own span.
    isBotThread: Effect.fnUntraced(function* (threadId: ThreadId) {
      return (yield* Ref.get(botThreads)).has(threadId);
    }),
  });
});

export const layer = Layer.effect(ForkBots, make);
