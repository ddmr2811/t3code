import {
  CommandId,
  FORK_BOTS_MAX_COUNT,
  type ForkBot,
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
import * as ServerSettings from "../../serverSettings.ts";
import { makeBotFileStore } from "./fileStore.ts";
import { listBots } from "./store.ts";

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

function initialBotMessage(bot: ForkBot, text: string): string {
  return [
    `Actúa como el bot «${bot.name}». Rol: ${bot.role}.`,
    "Las instrucciones del operador están delimitadas a continuación; la solicitud del usuario va aparte.",
    "",
    "--- INSTRUCCIONES DEL BOT ---",
    bot.instructions,
    "--- FIN DE INSTRUCCIONES ---",
    "",
    "--- SOLICITUD DEL USUARIO ---",
    text,
    "--- FIN DE SOLICITUD ---",
  ].join("\n");
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
  const fileStore = yield* makeBotFileStore;
  const storeLock = yield* Semaphore.make(1);
  const botLocks = yield* KeyedLock.make<ForkBot["id"]>();
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const instanceRegistry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

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
      Effect.gen(function* () {
        const runtimeMode = parsed.runtimeMode ?? "approval-required";
        yield* validateConfiguration({
          projectId: parsed.projectId,
          runtimeMode,
          instanceId: parsed.modelSelection.instanceId,
          model: parsed.modelSelection.model,
        });
        return yield* storeLock.withPermits(1)(
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
            if (existing === undefined && directory.bots.length >= FORK_BOTS_MAX_COUNT) {
              return yield* new ForkBotsError({
                reason: "limitExceeded",
                message: `Bot directory cannot hold more than ${FORK_BOTS_MAX_COUNT} bots.`,
              });
            }
            const now = yield* nowIso;
            const bot: ForkBot = {
              id,
              handle: parsed.handle,
              name: parsed.name,
              role: parsed.role,
              instructions: parsed.instructions,
              projectId: parsed.projectId,
              threadId:
                existing !== undefined && existing.projectId !== parsed.projectId
                  ? null
                  : (existing?.threadId ?? null),
              runtimeMode: parsed.runtimeMode ?? existing?.runtimeMode ?? "approval-required",
              modelSelection: parsed.modelSelection,
              fallbackChainId: parsed.fallbackChainId ?? null,
              notifyOnNeedsYou: parsed.notifyOnNeedsYou ?? existing?.notifyOnNeedsYou ?? true,
              archived: existing?.archived ?? false,
              createdAt: existing?.createdAt ?? now,
              updatedAt: now,
            };
            if (bot.runtimeMode !== runtimeMode) {
              yield* validateConfiguration({
                projectId: bot.projectId,
                runtimeMode: bot.runtimeMode,
                instanceId: bot.modelSelection.instanceId,
                model: bot.modelSelection.model,
              });
            }
            const bots =
              existing === undefined
                ? [...directory.bots, bot]
                : directory.bots.map((candidate) => (candidate.id === id ? bot : candidate));
            yield* fileStore.write({ ...directory, bots, updatedAt: now });
            return bot;
          }),
        );
      }),
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
          const bots = directory.bots.filter((bot) => bot.id !== parsed.id);
          if (bots.length === directory.bots.length) return { id: parsed.id, removed: false };
          const now = yield* nowIso;
          yield* fileStore.write({ ...directory, bots, updatedAt: now });
          // The T3 thread is deliberately untouched: removing a bot never deletes its history.
          return { id: parsed.id, removed: true };
        }),
      ),
    );
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
        yield* validateConfiguration({
          projectId: bot.projectId,
          runtimeMode: bot.runtimeMode,
          instanceId: bot.modelSelection.instanceId,
          model: bot.modelSelection.model,
        });

        let existingThread: ThreadId | null = null;
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
            }
          } else if (!isThreadNotFoundError(outcome.failure)) {
            return yield* dispatchFailed("Could not load the bot thread.");
          }
        }

        if (existingThread === null) {
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
                text: initialBotMessage(bot, parsed.text),
                attachments: [],
              },
              createdBy: "user",
              creationSource: "web",
            })
            .pipe(Effect.mapError(() => dispatchFailed("Could not create the bot thread.")));
          const now = yield* nowIso;
          const updated = yield* storeLock.withPermits(1)(
            Effect.gen(function* () {
              const directory = yield* fileStore.read();
              const current = directory.bots.find((candidate) => candidate.id === bot.id);
              if (current === undefined) return yield* notFound("Bot was not found.");
              const next = { ...current, threadId: launched.threadId, updatedAt: now };
              yield* fileStore.write({
                ...directory,
                bots: directory.bots.map((candidate) =>
                  candidate.id === bot.id ? next : candidate,
                ),
                updatedAt: now,
              });
              return next;
            }),
          );
          // Native mobile push already follows needs-you on this real thread; no parallel sidecar.
          return { bot: updated, threadId: launched.threadId, queued: false };
        }

        const projection = yield* threads
          .getThreadRecords(existingThread, [])
          .pipe(Effect.mapError(() => dispatchFailed("Could not load the bot thread.")));
        const thread = projection.thread;
        const selection = toModelSelection(bot);
        if (
          thread.modelSelection.instanceId !== selection.instanceId ||
          thread.modelSelection.model !== selection.model
        ) {
          yield* threads
            .dispatch({
              type: "thread.model-selection.set",
              commandId: CommandId.make(`fork-bot-model:${bot.id}:${SecureRandom.uuidV4Unsafe()}`),
              threadId: existingThread,
              modelSelection: selection,
            })
            .pipe(Effect.mapError(() => dispatchFailed("Could not configure the bot model.")));
        }
        if (thread.runtimeMode !== bot.runtimeMode) {
          yield* threads
            .dispatch({
              type: "thread.runtime-mode.set",
              commandId: CommandId.make(`fork-bot-mode:${bot.id}:${SecureRandom.uuidV4Unsafe()}`),
              threadId: existingThread,
              runtimeMode: bot.runtimeMode,
            })
            .pipe(Effect.mapError(() => dispatchFailed("Could not configure bot permissions.")));
        }
        const messageId = MessageId.make(`fork-bot-message:${SecureRandom.uuidV4Unsafe()}`);
        const sent = yield* threads
          .sendToThread({
            projectId: bot.projectId,
            commandId: CommandId.make(messageId),
            threadId: existingThread,
            messageId,
            text: parsed.text,
            attachments: [],
            modelSelection: selection,
            mode: "queue",
            createdBy: "user",
            creationSource: "web",
          })
          .pipe(Effect.mapError(() => dispatchFailed("Could not send the bot message.")));
        return { bot, threadId: existingThread, queued: sent.delivery === "queued" };
      }),
    );
  });

  return ForkBots.of({ list, upsert, setArchived, remove, sendMessage });
});

export const layer = Layer.effect(ForkBots, make);
