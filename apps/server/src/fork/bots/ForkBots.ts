// @effect-diagnostics nodeBuiltinImport:off - sha256 of the injected memory has no Effect equivalent.
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  FORK_BOTS_MAX_COUNT,
  FORK_BOTS_MAX_FILE_BYTES,
  type ForkBot,
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
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ScheduledTasks from "../../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ForkProjectMemory from "../memory/ForkProjectMemory.ts";
import { makeForkJsonFileStore } from "../jsonFileStore.ts";
import { decodeStoredBotDirectory, EMPTY_BOT_DIRECTORY, listBots } from "./store.ts";

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
  }
>()("t3/fork/bots/ForkBots") {}

const decodeListInput = Schema.decodeUnknownEffect(ForkBotListInput);
const decodeUpsertInput = Schema.decodeUnknownEffect(ForkBotUpsertInput);
const decodeSetArchivedInput = Schema.decodeUnknownEffect(ForkBotSetArchivedInput);
const decodeRemoveInput = Schema.decodeUnknownEffect(ForkBotRemoveInput);
const decodeSendMessageInput = Schema.decodeUnknownEffect(ForkBotSendMessageInput);

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
  const fileStore = yield* makeForkJsonFileStore({
    fileName: "bots.json",
    label: "Bot store",
    maxBytes: FORK_BOTS_MAX_FILE_BYTES,
    empty: EMPTY_BOT_DIRECTORY,
    decode: decodeStoredBotDirectory,
    makeError: (reason, message) => new ForkBotsError({ reason, message }),
  });
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
      Effect.catch((error) =>
        Effect.logWarning("fork bots could not pause the routines of a previous thread", {
          botId,
          threadId,
          error,
        }),
      ),
    );
  });
  const memory = yield* ForkProjectMemory.ForkProjectMemory;

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
            archived: existing?.archived ?? false,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
          };
          const bots =
            existing === undefined
              ? [...directory.bots, bot]
              : directory.bots.map((candidate) => (candidate.id === id ? bot : candidate));
          yield* fileStore.write({ ...directory, bots, updatedAt: now });
          if (existing?.threadId != null && kept === undefined) {
            yield* pauseRoutines(id, existing.threadId);
          }
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
          const now = yield* nowIso;
          yield* fileStore.write({ ...directory, bots, updatedAt: now });
          if (removed.threadId !== null) yield* pauseRoutines(removed.id, removed.threadId);
          // The T3 thread is deliberately untouched: removing a bot never deletes its history.
          return { id: parsed.id, removed: true };
        }),
      ),
    );
  });

  /** After a message went out the bot's thread exists, so a failed write is only logged. */
  const recordDelivery = Effect.fn("ForkBots.recordDelivery")(function* (
    bot: ForkBot,
    patch: Partial<Pick<ForkBot, "threadId" | "memoryHash">>,
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

  const sendMessage = Effect.fn("ForkBots.sendMessage")(function* (input: ForkBotSendMessageInput) {
    const parsed = yield* decodeSendMessageInput(input).pipe(
      Effect.mapError(() => invalidInput("Invalid bot message.")),
    );
    return yield* botLocks.withLock(
      parsed.id,
      Effect.gen(function* () {
        const bot = yield* storeLock
          .withPermits(1)(fileStore.read())
          .pipe(
            Effect.flatMap((directory) => {
              const found = directory.bots.find((candidate) => candidate.id === parsed.id);
              return found === undefined
                ? Effect.fail(notFound("Bot was not found."))
                : Effect.succeed(found);
            }),
          );
        if (bot.archived) return yield* invalidInput("Restore the bot before sending a message.");

        let existingThread: ThreadId | null = null;
        let threadModel: Pick<ModelSelection, "instanceId" | "model"> = bot.modelSelection;
        if (bot.threadId !== null) {
          const outcome = yield* threads
            .getThreadRecords(bot.threadId, ["runs"])
            .pipe(Effect.result);
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
            }
          } else if (!isThreadNotFoundError(outcome.failure)) {
            return yield* dispatchFailed("Could not load the bot thread.");
          }
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
        const withMemory = (text: string) =>
          injects ? `${memoryBlock(essentials)}\n\n${text}` : text;

        if (existingThread === null) {
          yield* validateConfiguration({
            projectId: bot.projectId,
            runtimeMode: bot.runtimeMode,
            instanceId: bot.modelSelection.instanceId,
            model: bot.modelSelection.model,
          });
          const commandId = CommandId.make(
            `fork-bot-launch:${bot.id}:${SecureRandom.uuidV4Unsafe()}`,
          );
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
              initialMessage: {
                text: withMemory(initialBotMessage(bot, parsed.text)),
                attachments: [],
              },
              createdBy: "user",
              creationSource: "web",
            })
            .pipe(Effect.mapError(() => dispatchFailed("Could not create the bot thread.")));
          // The thread already exists and holds the message; failing here would make a retry
          // launch a duplicate, so a lost link only means the next message starts another thread.
          const linked = yield* recordDelivery(bot, {
            threadId: launched.threadId,
            memoryHash: hash,
          });
          return { bot: linked, threadId: launched.threadId, queued: false };
        }

        const messageId = MessageId.make(`fork-bot-message:${SecureRandom.uuidV4Unsafe()}`);
        const sent = yield* threads
          .sendToThread({
            projectId: bot.projectId,
            commandId: CommandId.make(messageId),
            threadId: existingThread,
            messageId,
            text: withMemory(parsed.text),
            attachments: [],
            mode: "queue",
            createdBy: "user",
            creationSource: "web",
          })
          .pipe(Effect.mapError(() => dispatchFailed("Could not send the bot message.")));
        // A lost hash only means the next message repeats the same block.
        const delivered = injects ? yield* recordDelivery(bot, { memoryHash: hash }) : bot;
        return { bot: delivered, threadId: existingThread, queued: sent.delivery === "queued" };
      }),
    );
  });

  return ForkBots.of({ list, upsert, setArchived, remove, sendMessage });
});

export const layer = Layer.effect(ForkBots, make);
