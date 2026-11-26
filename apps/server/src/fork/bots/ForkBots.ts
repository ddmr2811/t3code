// @effect-diagnostics nodeBuiltinImport:off - sha256 of the injected memory has no Effect equivalent.
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  FORK_BOTS_HANDOFF_HISTORY,
  FORK_BOTS_HANDOFF_MAX_HOPS,
  FORK_BOTS_HANDOFF_PREVIEW_LENGTH,
  FORK_BOTS_MAX_COUNT,
  FORK_BOTS_MAX_FILE_BYTES,
  FORK_BOTS_PROPOSAL_INTERVAL_MS,
  type ForkBot,
  type ForkBotIntegrations,
  ForkBotAnswerProposalInput,
  ForkBotProposal,
  ForkBotDismissHandoffInput,
  ForkBotDraft,
  ForkBotDraftInput,
  type ForkBotHandoff,
  ForkBotHandoffInput,
  type ForkBotHandoffResult,
  ForkMemoryCorrectInput,
  type ForkMemoryCorrectResult,
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
  forkBotDraftModel,
  isForkBotDraftModelAllowed,
  MessageId,
  type ModelSelection,
  type OrchestrationV2Run,
  type ProjectId,
  type ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
  ThreadId,
  isProviderNativeSubagentThread,
  integrationAbove,
  isRuntimeModeAbove,
  projectKeyFromName,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  DispatchModeLimit,
  type DispatchModes,
  exceededDispatchModeLimit,
} from "../../orchestration-v2/DispatchModeLimit.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderInstallationGate from "../../provider/ProviderInstallationGate.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ScheduledTasks from "../../scheduledTasks/ScheduledTaskService.ts";
import { forkParked } from "../../serverActivation.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ForkCoordination from "../coordination/ForkCoordination.ts";
import * as ForkProjectMemory from "../memory/ForkProjectMemory.ts";
import { makeForkJsonFileStore } from "../jsonFileStore.ts";
import { DraftReply, draftPrompt, handleFrom, sentenceDraft, uniqueHandle } from "./draft.ts";
import {
  decodeStoredBotDirectory,
  EMPTY_BOT_DIRECTORY,
  FORK_BOTS_PROPOSALS_MAX_BYTES,
  FORK_BOTS_VETOES_PER_PROJECT,
  listBots,
  type StoredBotDirectory,
} from "./store.ts";

export class ForkBots extends Context.Service<
  ForkBots,
  {
    readonly list: (input: ForkBotListInput) => Effect.Effect<ForkBotListResult, ForkBotsError>;
    readonly upsert: (input: ForkBotUpsertInput) => Effect.Effect<ForkBot, ForkBotsError>;
    /** A bot from one sentence, for the user to create with `upsert`; nothing is saved. */
    readonly draft: (input: ForkBotDraftInput) => Effect.Effect<ForkBotDraft, ForkBotsError>;
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
    /** Keeps the project's notes, then hands the user's sentence to its coordinator. */
    readonly correctMemory: (
      input: ForkMemoryCorrectInput,
    ) => Effect.Effect<ForkMemoryCorrectResult, ForkBotsError>;
    /** A coordinator's thread suggests a bot; the user decides with `answerProposal`. */
    readonly propose: (
      draft: BotProposalDraft,
      from: ProposalSender,
    ) => Effect.Effect<ForkBotProposal, ForkBotsError>;
    /** Only an accepted proposal creates a bot, through the same checks as `upsert`. */
    readonly answerProposal: (
      input: ForkBotAnswerProposalInput,
    ) => Effect.Effect<ForkBotProposal, ForkBotsError>;
    /** Whether a thread is a bot's current one; answered from memory. */
    readonly isBotThread: (threadId: ThreadId) => Effect.Effect<boolean>;
    /** A bot's thread now or one a bot has left: a workflow continues neither by id. */
    readonly wasBotThread: (threadId: ThreadId) => Effect.Effect<boolean>;
    /** A bot thread was served a tool list with bot_handoff under this MCP credential. */
    readonly noteHandoffToolsListed: (
      threadId: ThreadId,
      mcpCredentialId: string,
    ) => Effect.Effect<void>;
    /**
     * A workflow step's turn in the bot's thread, in the bot's one queue. The thread's modes may
     * not be above the bot's own: a workflow never borrows what the user raised by hand.
     */
    readonly workflowTurn: (
      input: WorkflowTurnInput,
    ) => Effect.Effect<{ readonly threadId: ThreadId; readonly turnId: string }, ForkBotsError>;
    /** At the end of a bot's turn, marks or clears `handoffToolsMissing`. */
    readonly noteRunUpdated: (
      run: Pick<OrchestrationV2Run, "id" | "threadId" | "status">,
    ) => Effect.Effect<void, ForkBotsError>;
  }
>()("t3/fork/bots/ForkBots") {}

/**
 * Who hands the work over. The user (an @mention in the ADE) already holds the RPC scope; an
 * agent is its bot's own thread, which may not make a bot with broader modes work.
 */
export type HandoffSender =
  | { readonly kind: "user" }
  | { readonly kind: "agent"; readonly limits: DispatchModes };

export interface WorkflowTurnInput {
  readonly handle: string;
  /** Ids derived from the step, so a start asked for again after a crash finds its turn. */
  readonly commandId: CommandId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly outputSchema: Readonly<Record<string, Schema.Json>> | undefined;
}

/** What a workflow turn adds to a delivery: its own ids and the result it asks for. */
interface DeliveryRequest {
  readonly commandId: CommandId;
  readonly messageId: MessageId;
  readonly outputSchema: Readonly<Record<string, Schema.Json>> | undefined;
}

/** The calling thread as it is now: a thread moved to another project proposes nothing there. */
export interface ProposalSender {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly limits: DispatchModes | undefined;
}

export interface BotProposalDraft {
  readonly handle: string;
  readonly name: string;
  readonly role: string;
  readonly instructions: string;
  readonly routine: string;
  readonly reason: string;
  /** Defaults to approval-required; never above the coordinator's. */
  readonly runtimeMode?: RuntimeMode | undefined;
  /** A model of the coordinator's provider; defaults to the coordinator's own. */
  readonly model?: string | undefined;
}

const decodeProposal = Schema.decodeUnknownEffect(ForkBotProposal);
/** UTF-8 bytes as the bot file saves them, indented. Decoded data always serialises. */
const savedBytes = (value: unknown) =>
  new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`).byteLength;
const decodeAnswerProposalInput = Schema.decodeUnknownEffect(ForkBotAnswerProposalInput);
const decodeListInput = Schema.decodeUnknownEffect(ForkBotListInput);
const decodeUpsertInput = Schema.decodeUnknownEffect(ForkBotUpsertInput);
const decodeDraftInput = Schema.decodeUnknownEffect(ForkBotDraftInput);
const decodeDraft = Schema.decodeUnknownEffect(ForkBotDraft);
const decodeDraftReply = Schema.decodeUnknownEffect(Schema.fromJsonString(DraftReply));
const decodeSetArchivedInput = Schema.decodeUnknownEffect(ForkBotSetArchivedInput);
const decodeRemoveInput = Schema.decodeUnknownEffect(ForkBotRemoveInput);
const decodeSendMessageInput = Schema.decodeUnknownEffect(ForkBotSendMessageInput);
const decodeMemoryCorrectInput = Schema.decodeUnknownEffect(ForkMemoryCorrectInput);
const decodeHandoffInput = Schema.decodeUnknownEffect(ForkBotHandoffInput);
const decodeDismissHandoffInput = Schema.decodeUnknownEffect(ForkBotDismissHandoffInput);

const invalidInput = (message: string) => new ForkBotsError({ reason: "invalidInput", message });
const notFound = (message: string) => new ForkBotsError({ reason: "notFound", message });
const limitExceeded = (message: string) => new ForkBotsError({ reason: "limitExceeded", message });
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

/** The user's sentence is one line, so it cannot close the block it sits in. */
function memoryCorrectionMessage(correction: string): string {
  return [
    "--- CORRECCIÓN DE LA MEMORIA DEL PROYECTO ---",
    "El usuario corrige la memoria del proyecto con esta frase. La versión anterior ya está guardada y puede volver a ella.",
    `«${correction}»`,
    "1. Busca con project_memory_search las notas a las que afecta.",
    "2. Guarda con project_memory_save lo corregido, un hecho por nota, y pon en `replaces` las notas que sustituye.",
    "3. Una nota del usuario o esencial no la puedes sustituir: guarda la corregida y di cuál debe quitar el usuario.",
    "4. Contesta en una o dos frases qué cambiaste. No hagas nada más en este turno.",
    "--- FIN DE LA CORRECCIÓN ---",
  ].join("\n");
}

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

function handoffMessage(
  handoff: ForkBotHandoff,
  from: ForkBot,
  text: string,
  context: string | undefined,
): string {
  return [
    `--- TRASPASO de @${from.handle} (${from.name}) · ${handoff.id} · salto ${handoff.hops} de ${FORK_BOTS_HANDOFF_MAX_HOPS} ---`,
    text,
    // Quoted line by line, so the excerpt cannot imitate the block's own delimiters.
    ...(context === undefined
      ? []
      : [
          `--- CONTEXTO de @${from.handle} (extracto) ---`,
          ...context.split("\n").map((line) => `> ${line}`),
        ]),
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

const TERMINAL_RUN_STATUSES = new Set<OrchestrationV2Run["status"]>([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

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

/** A bot's thread says so in its id, which it keeps when the bot leaves it. */
const BOT_THREAD_PREFIX = "fork-bot-thread:";
/** Known without the bots' services, which a workflow may run before or after. */
export const isBotThreadId = (threadId: string) => threadId.startsWith(BOT_THREAD_PREFIX);

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
  // The MCP credential (one per provider session) that last listed bot_handoff, per bot thread.
  const handoffListedBy = new Map<ThreadId, string>();
  const remember = (directory: StoredBotDirectory) =>
    Effect.suspend(() => {
      const threads = new Set(
        directory.bots.flatMap((bot) => (bot.threadId === null ? [] : [bot.threadId])),
      );
      for (const threadId of handoffListedBy.keys()) {
        if (!threads.has(threadId)) handoffListedBy.delete(threadId);
      }
      return Ref.set(botThreads, threads);
    });
  const fileStore = {
    read: () => rawStore.read().pipe(Effect.tap(remember)),
    write: (directory: StoredBotDirectory) =>
      rawStore.write(directory).pipe(Effect.andThen(remember(directory))),
  };
  // A handoff still `pending` at start was cut short by a stop; it may be sent again.
  yield* fileStore.read().pipe(
    Effect.flatMap((directory) =>
      directory.handoffs.some((handoff) => handoff.status === "pending")
        ? fileStore.write({
            ...directory,
            handoffs: directory.handoffs.map((handoff) =>
              handoff.status === "pending" ? { ...handoff, status: "failed" as const } : handoff,
            ),
          })
        : Effect.void,
    ),
    Effect.ignore,
  );
  const storeLock = yield* Semaphore.make(1);
  const botLocks = yield* KeyedLock.make<ForkBot["id"]>();
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const instanceRegistry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const scheduledTasks = yield* ScheduledTasks.ScheduledTaskService;
  const installationGate = yield* ProviderInstallationGate.ProviderInstallationGate;
  const fileSystem = yield* FileSystem.FileSystem;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;

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
    return yield* botLocks.withLock(id, storeLock.withPermits(1)(saveBot(parsed, id)));
  });

  const draft = Effect.fn("ForkBots.draft")(function* (input: ForkBotDraftInput) {
    const parsed = yield* decodeDraftInput(input).pipe(
      Effect.mapError(() => invalidInput("Invalid bot sentence.")),
    );
    const project = yield* projects
      .getById(parsed.projectId)
      .pipe(Effect.mapError(() => unavailable("Could not verify the bot project.")));
    if (Option.isNone(project)) return yield* notFound("Bot project was not found.");
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(() => unavailable("Could not read the drafting model setting.")),
    );
    const allProviders = yield* providerRegistry.getProviders.pipe(Effect.orElseSucceed(() => []));
    const providers = allProviders.filter(
      (provider) =>
        providerIsSelectable(provider) &&
        resolveProjectProviderInstanceEnabled(settings, parsed.projectId, provider.instanceId),
    );
    const usableModels = providers.flatMap((provider) =>
      provider.models
        .filter((model) => model.isLegacy !== true)
        .map((model) => ({ instanceId: provider.instanceId, model: model.slug })),
    );
    // A default whose provider or model went away would only make «Crear» fail.
    const selection = [
      project.value.defaultModelSelection,
      settings.defaultModelSelection,
      usableModels[0],
    ].find(
      (candidate) =>
        candidate != null &&
        usableModels.some(
          (usable) =>
            usable.instanceId === candidate.instanceId && usable.model === candidate.model,
        ),
    );
    if (selection == null) {
      return yield* unavailable("No provider is available for a bot in this project.");
    }
    // Only the chosen or default allowed model: no fallback to another provider's model.
    const chosen = settings.forkBotDraftModelSelection;
    const drafter = forkBotDraftModel(chosen, providers);
    const chosenDriver = allProviders.find(
      (provider) => provider.instanceId === chosen?.instanceId,
    )?.driver;
    const notAllowed =
      chosen !== null &&
      chosenDriver !== undefined &&
      !isForkBotDraftModelAllowed(String(chosenDriver), chosen.model);
    const reply =
      drafter === null
        ? undefined
        : yield* Effect.gen(function* () {
            const instance = yield* instanceRegistry.getInstance(drafter.instanceId);
            if (instance === undefined) return yield* Effect.fail("unregistered" as const);
            // A provider runs in a folder; drafting must not read a checkout.
            const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-bot-draft-" });
            // The one free-prompt operation every provider implements; its answer is our JSON.
            return yield* installationGate.execute(
              drafter.instanceId,
              instance.textGeneration.generateTranscriptionPostProcessing({
                cwd,
                prompt: draftPrompt(parsed.text),
                modelSelection: drafter,
              }),
            );
          }).pipe(
            Effect.scoped,
            Effect.map((generated) => generated.transcription),
            Effect.tapError((error) =>
              Effect.logWarning("fork bots could not draft a bot with its model", {
                instanceId: drafter.instanceId,
                error,
              }),
            ),
            Effect.option,
          );
    const takenHandles = new Set(
      (yield* storeLock.withPermits(1)(fileStore.read())).bots.map((bot) =>
        bot.handle.toLowerCase(),
      ),
    );
    // Built from named fields only, so a reply cannot add a mode, a project or a coordinator.
    const build = (fields: DraftReply, fallbackReason: ForkBotDraft["fallbackReason"]) =>
      decodeDraft({
        handle: uniqueHandle(handleFrom(fields.handle || fields.name), takenHandles),
        name: fields.name,
        role: fields.role,
        instructions: fields.instructions,
        routine: fields.routine,
        projectId: parsed.projectId,
        runtimeMode: "approval-required",
        modelSelection: { instanceId: selection.instanceId, model: selection.model },
        draftedBy: fallbackReason === null ? drafter : null,
        fallbackReason,
      });
    const fromSentence = (reason: NonNullable<ForkBotDraft["fallbackReason"]>) =>
      build(sentenceDraft(parsed.text), reason).pipe(
        Effect.mapError(() => invalidInput("Could not draft a bot from this sentence.")),
      );
    if (reply === undefined) return yield* fromSentence(notAllowed ? "modelNotAllowed" : "noModel");
    if (Option.isNone(reply)) return yield* fromSentence("modelFailed");
    return yield* decodeDraftReply(extractJsonObject(reply.value)).pipe(
      Effect.flatMap((fields) => build(fields, null)),
      Effect.catch(() => fromSentence("invalidReply")),
    );
  });

  /**
   * Holding `storeLock`. `finish` adds to the same write, so a bot and what created it are saved
   * together or not at all.
   */
  const saveBot = Effect.fn("ForkBots.saveBot")(function* (
    parsed: ForkBotUpsertInput,
    id: ForkBot["id"],
    finish: (
      directory: StoredBotDirectory,
      bot: ForkBot,
    ) => Effect.Effect<StoredBotDirectory> = Effect.succeed,
  ) {
    const directory = yield* fileStore.read();
    const existing =
      parsed.id === undefined ? undefined : directory.bots.find((bot) => bot.id === parsed.id);
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
      integrations: parsed.integrations ?? existing?.integrations ?? {},
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
      handoffToolsMissing: kept?.handoffToolsMissing ?? false,
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
    yield* fileStore.write(yield* finish({ ...directory, bots, updatedAt: now }, bot));
    return bot;
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
   * the bot's lock, so each bot has one queue. `limits` are an agent sender's modes, and
   * `senderIntegrations` what the sending bot may do in outside apps.
   */
  const deliver = Effect.fn("ForkBots.deliver")(function* (
    bot: ForkBot,
    text: string,
    patch: Partial<Pick<ForkBot, "handoffHops">>,
    limits: DispatchModes | undefined,
    senderIntegrations?: ForkBotIntegrations,
    request?: DeliveryRequest,
  ) {
    if (bot.archived) return yield* invalidInput("Restore the bot before sending a message.");
    // A bot never gets done through another what it may not do itself in an outside app.
    const broader =
      senderIntegrations === undefined
        ? undefined
        : integrationAbove(bot.integrations, senderIntegrations);
    if (broader !== undefined) {
      return yield* new ForkBotsError({
        reason: "permissionDenied",
        message: `Bot @${bot.handle} may use ${broader}, which this sender may not. Ask the user to send it the work.`,
      });
    }

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

    const by =
      request === undefined
        ? ({ createdBy: "user", creationSource: "web" } as const)
        : ({ createdBy: "system", creationSource: "server" } as const);
    const outputSchema =
      request?.outputSchema === undefined ? {} : { outputSchema: request.outputSchema };
    if (existingThread === null) {
      yield* validateConfiguration({
        projectId: bot.projectId,
        runtimeMode: bot.runtimeMode,
        instanceId: bot.modelSelection.instanceId,
        model: bot.modelSelection.model,
      });
      const commandId =
        request?.commandId ??
        CommandId.make(`fork-bot-launch:${bot.id}:${SecureRandom.uuidV4Unsafe()}`);
      const launched = yield* launches
        .launch({
          commandId,
          threadId: ThreadId.make(`${BOT_THREAD_PREFIX}${commandId}`),
          projectId: bot.projectId,
          title: bot.name,
          generateTitle: false,
          modelSelection: toModelSelection(bot),
          runtimeMode: bot.runtimeMode,
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          initialMessage: {
            ...(request === undefined ? {} : { messageId: request.messageId }),
            text: withMemory(initialBotMessage(bot, text)),
            attachments: [],
            ...outputSchema,
          },
          ...by,
        })
        .pipe(Effect.mapError(() => dispatchFailed("Could not create the bot thread.")));
      const firstRun =
        request === undefined
          ? undefined
          : launched.projection.runs.find((run) => run.userMessageId === request.messageId);
      // The thread already exists and holds the message; failing here would make a retry
      // launch a duplicate, so a lost link only means the next message starts another thread.
      const linked = yield* recordDelivery(bot, {
        threadId: launched.threadId,
        memoryHash: hash,
        ...patch,
      });
      return {
        bot: linked,
        threadId: launched.threadId,
        queued: false,
        turnId: firstRun?.id ?? null,
      };
    }

    const messageId =
      request?.messageId ?? MessageId.make(`fork-bot-message:${SecureRandom.uuidV4Unsafe()}`);
    const send = threads
      .sendToThread({
        projectId: bot.projectId,
        commandId: request?.commandId ?? CommandId.make(messageId),
        threadId: existingThread,
        messageId,
        text: withMemory(text),
        attachments: [],
        mode: "queue",
        ...outputSchema,
        ...by,
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
    return {
      bot: delivered,
      threadId: existingThread,
      queued: sent.delivery === "queued",
      turnId: request === undefined ? null : (sent.run.id as string),
    };
  });

  const workflowTurn = Effect.fn("ForkBots.workflowTurn")(function* (input: WorkflowTurnInput) {
    const target = (yield* storeLock.withPermits(1)(fileStore.read())).bots.find(
      (bot) => bot.handle.toLowerCase() === input.handle.replace(/^@/, "").toLowerCase(),
    );
    if (target === undefined) return yield* notFound(`No bot uses the handle @${input.handle}.`);
    return yield* botLocks.withLock(
      target.id,
      Effect.gen(function* () {
        const bot = yield* readBot(target.id);
        const sent = yield* deliver(
          bot,
          input.text,
          {},
          { runtimeMode: bot.runtimeMode, interactionMode: "default" },
          undefined,
          input,
        );
        if (sent.turnId === null) {
          return yield* dispatchFailed("The bot thread started without a turn for the step.");
        }
        return { threadId: sent.threadId, turnId: sent.turnId };
      }),
    );
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

  const correctMemory = Effect.fn("ForkBots.correctMemory")(function* (
    input: ForkMemoryCorrectInput,
  ) {
    const parsed = yield* decodeMemoryCorrectInput(input).pipe(
      Effect.mapError(() => invalidInput("Invalid memory correction.")),
    );
    const directory = yield* storeLock.withPermits(1)(fileStore.read());
    const coordinator = directory.bots.find(
      (bot) => bot.coordinator && !bot.archived && bot.projectId === parsed.projectId,
    );
    if (coordinator === undefined) {
      return yield* notFound(`Project ${parsed.projectId} has no coordinator to apply it.`);
    }
    return yield* botLocks.withLock(
      coordinator.id,
      Effect.gen(function* () {
        const bot = yield* readBot(coordinator.id);
        // Kept before the coordinator can touch a note, so going back undoes all of it.
        const previous = yield* memory
          .checkpoint(parsed.projectId, parsed.text)
          .pipe(Effect.mapError((error) => unavailable(error.message)));
        const sent = yield* deliver(
          bot,
          memoryCorrectionMessage(parsed.text),
          { handoffHops: 0 },
          undefined,
        );
        return { threadId: sent.threadId, queued: sent.queued, handle: bot.handle, previous };
      }),
    );
  });

  /**
   * The board is a trace; the handoff itself is already on disk, so a failed write is logged.
   * Delivered handoffs share one entry per pair of bots, so they never fill the board. A cut one
   * keeps its own entry until the user dismisses it.
   */
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
      if (handoff.status === "dismissed") {
        yield* coordination.remove({ id: handoff.id });
        return;
      }
      yield* coordination.upsert({
        id: handoff.status === "cut" ? handoff.id : `handoff:${from.id}:${to.id}`,
        projectKey: projectKeyFromName(projectName, to.projectId),
        projectName: projectName.slice(0, 160),
        ...(threadId === null ? {} : { threadId }),
        agentName: to.name,
        status: handoff.status === "cut" ? "blocked" : "done",
        workingOn: "",
        completedSummary: summary,
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

  /** Callers hold the store lock. `resetHopsOf` is a bot the user just acted through. */
  const saveHandoff = Effect.fn("ForkBots.saveHandoff")(function* (
    handoff: ForkBotHandoff,
    resetHopsOf?: ForkBot["id"],
  ) {
    const directory = yield* fileStore.read();
    const now = yield* nowIso;
    const all = [...directory.handoffs.filter((candidate) => candidate.id !== handoff.id), handoff];
    // Trimming drops the oldest, but never a cut handoff the user has not dismissed yet.
    let extra = all.length - FORK_BOTS_HANDOFF_HISTORY;
    const handoffs = all
      .filter((candidate) => {
        if (extra <= 0 || candidate.status === "cut" || candidate.id === handoff.id) return true;
        extra -= 1;
        return false;
      })
      .slice(-FORK_BOTS_HANDOFF_HISTORY); // Only a history of nothing but cuts loses one.
    yield* fileStore.write({
      ...directory,
      bots: directory.bots.map((bot) =>
        bot.id === resetHopsOf ? { ...bot, handoffHops: 0 } : bot,
      ),
      handoffs,
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
            // `pending` was cut short by a crash or a restart, so it is tried again too.
            if (seen !== undefined && seen.status !== "failed" && seen.status !== "pending") {
              return { from, to, handoff: seen, duplicate: true };
            }
            if (from.id === to.id) {
              return yield* invalidInput(`@${to.handle} cannot hand work to itself.`);
            }
            if (from.archived) {
              return yield* invalidInput(`Restore @${from.handle} before it hands work over.`);
            }
            const hops = sender.kind === "user" ? 1 : from.handoffHops + 1;
            const record: ForkBotHandoff = {
              id: parsed.id,
              fromBotId: from.id,
              toBotId: to.id,
              origin: sender.kind,
              hops,
              status: hops > FORK_BOTS_HANDOFF_MAX_HOPS ? "cut" : "pending",
              preview: parsed.text
                .replaceAll(/\s+/g, " ")
                .slice(0, FORK_BOTS_HANDOFF_PREVIEW_LENGTH),
              createdAt: now,
            };
            // The user stepping in through this bot starts its chain again, as a message would.
            yield* saveHandoff(record, sender.kind === "user" ? from.id : undefined);
            return { from, to, handoff: record, duplicate: false };
          }),
        );
        const { from, to } = reserved;
        if (reserved.duplicate) {
          const record = reserved.handoff;
          return {
            handoff: record,
            threadId: record.status === "delivered" ? to.threadId : null,
            duplicate: true,
          };
        }
        if (reserved.handoff.status === "cut") {
          yield* traceHandoff(reserved.handoff, from, to, null);
          return { handoff: reserved.handoff, threadId: null, duplicate: false };
        }
        const sent = yield* deliver(
          to,
          handoffMessage(reserved.handoff, from, parsed.text, parsed.context),
          { handoffHops: reserved.handoff.hops },
          sender.kind === "agent" ? sender.limits : undefined,
          sender.kind === "agent" ? from.integrations : undefined,
        ).pipe(
          // Failed or interrupted: the same id may be sent again.
          // By design at least once: an interruption after the message was queued sends it again.
          Effect.onError(() =>
            storeLock
              .withPermits(1)(saveHandoff({ ...reserved.handoff, status: "failed" }))
              .pipe(Effect.ignore),
          ),
        );
        const record: ForkBotHandoff = { ...reserved.handoff, status: "delivered" };
        // A lost write leaves it `pending`, so a retry would send it again; that is logged.
        yield* storeLock
          .withPermits(1)(saveHandoff(record))
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("fork bots could not mark a handoff delivered", {
                handoffId: record.id,
                reason: error.reason,
              }),
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

  const propose = Effect.fn("ForkBots.propose")(function* (
    draft: BotProposalDraft,
    from: ProposalSender,
  ) {
    // Checked again under the lock that saves it: the bot may change in between.
    const proposerOf = Effect.fn("ForkBots.proposerOf")(function* (directory: StoredBotDirectory) {
      const bot = directory.bots.find((candidate) => candidate.threadId === from.threadId);
      if (
        bot === undefined ||
        !bot.coordinator ||
        bot.archived ||
        bot.projectId !== from.projectId
      ) {
        return yield* new ForkBotsError({
          reason: "permissionDenied",
          message: "Only the project's coordinator can propose a bot.",
        });
      }
      return bot;
    });
    const coordinator = yield* proposerOf(yield* storeLock.withPermits(1)(fileStore.read()));
    const runtimeMode = draft.runtimeMode ?? "approval-required";
    if (runtimeMode === "full-access") {
      return yield* new ForkBotsError({
        reason: "permissionDenied",
        message: "A proposed bot never runs in full-access.",
      });
    }
    if (
      isRuntimeModeAbove(runtimeMode, coordinator.runtimeMode) ||
      (from.limits !== undefined && isRuntimeModeAbove(runtimeMode, from.limits.runtimeMode))
    ) {
      return yield* new ForkBotsError({
        reason: "permissionDenied",
        message: `A proposed bot cannot run in ${runtimeMode}, above its coordinator.`,
      });
    }
    const modelSelection = {
      instanceId: coordinator.modelSelection.instanceId,
      model: draft.model ?? coordinator.modelSelection.model,
    };
    yield* validateConfiguration({
      projectId: coordinator.projectId,
      runtimeMode,
      instanceId: modelSelection.instanceId,
      model: modelSelection.model,
    });
    const nowMs = yield* Clock.currentTimeMillis;
    const proposal = yield* decodeProposal({
      id: `proposal:${SecureRandom.uuidV4Unsafe()}`,
      projectId: coordinator.projectId,
      proposedBy: coordinator.id,
      handle: draft.handle,
      name: draft.name,
      role: draft.role,
      instructions: draft.instructions,
      routine: draft.routine,
      reason: draft.reason,
      runtimeMode,
      modelSelection,
      status: "pending",
      botId: null,
      createdAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
      decidedAt: null,
    }).pipe(Effect.mapError(() => invalidInput("Invalid bot proposal.")));
    return yield* storeLock.withPermits(1)(
      Effect.gen(function* () {
        const directory = yield* fileStore.read();
        const current = yield* proposerOf(directory);
        if (current.id !== coordinator.id) {
          return yield* invalidInput("The project's coordinator changed; propose again.");
        }
        const project = directory.proposals.filter(
          (candidate) => candidate.projectId === proposal.projectId,
        );
        if (project.some((candidate) => candidate.status === "pending")) {
          return yield* limitExceeded("A bot proposal is already waiting for the user.");
        }
        if (
          project.some(
            (candidate) => nowMs - Date.parse(candidate.createdAt) < FORK_BOTS_PROPOSAL_INTERVAL_MS,
          )
        ) {
          return yield* limitExceeded("This project already had a bot proposal this week.");
        }
        const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
        if (
          directory.vetoes.some(
            (veto) =>
              veto.projectId === proposal.projectId &&
              (same(veto.handle, proposal.handle) || same(veto.name, proposal.name)),
          )
        ) {
          return yield* new ForkBotsError({
            reason: "conflict",
            message: `The user already said no to @${proposal.handle} or ${proposal.name}.`,
          });
        }
        if (directory.bots.some((bot) => same(bot.handle, proposal.handle))) {
          return yield* new ForkBotsError({
            reason: "conflict",
            message: "Another bot already uses this handle.",
          });
        }
        const proposals = [...directory.proposals, proposal];
        // Only pending ones count: refusals and answered ones are already few per project.
        const pending = proposals.filter((candidate) => candidate.status === "pending");
        if (savedBytes({ proposals: pending }) > FORK_BOTS_PROPOSALS_MAX_BYTES) {
          return yield* limitExceeded(
            "Bot proposals have no room left; the user must answer the pending ones first.",
          );
        }
        const next = { ...directory, proposals, updatedAt: proposal.createdAt };
        // Leave room to answer it: accepting adds a bot with the proposal's text plus fixed fields
        // (id, dates, indentation; under 1 KiB measured), a «No» less.
        if (savedBytes(next) + savedBytes(proposal) + 4096 > FORK_BOTS_MAX_FILE_BYTES) {
          return yield* limitExceeded(
            "The bot file has no room left to answer a proposal; remove bots or answer pending ones.",
          );
        }
        yield* fileStore.write(next);
        return proposal;
      }),
    );
  });

  /**
   * The answer replaces the project's previous answered proposal (kept for the weekly wait); a
   * «No» adds a veto. Deleted projects go; a failed lookup keeps them.
   */
  const markDecided = Effect.fn("ForkBots.markDecided")(function* (
    directory: StoredBotDirectory,
    proposal: ForkBotProposal,
  ) {
    const { projectId, handle, name } = proposal;
    const refusals = directory.vetoes.filter((veto) => veto.projectId === projectId);
    const full = refusals.length >= FORK_BOTS_VETOES_PER_PROJECT;
    const vetoes =
      proposal.status === "rejected"
        ? [
            ...directory.vetoes.filter((veto) => !full || veto !== refusals[0]),
            { projectId, handle, name },
          ]
        : directory.vetoes;
    const deleted = new Set<ProjectId>();
    for (const id of new Set([...directory.proposals, ...vetoes].map((entry) => entry.projectId))) {
      const found = yield* projects.getById(id).pipe(Effect.option);
      if (Option.isSome(found) && Option.isNone(found.value)) deleted.add(id);
    }
    return {
      ...directory,
      proposals: directory.proposals.flatMap((candidate) =>
        deleted.has(candidate.projectId) ||
        (candidate.projectId === projectId && candidate.status !== "pending")
          ? []
          : [candidate.id === proposal.id ? { ...proposal, instructions: "" } : candidate],
      ),
      vetoes: vetoes.filter((veto) => !deleted.has(veto.projectId)),
      updatedAt: proposal.decidedAt,
    };
  });

  /**
   * The mode the coordinator's thread runs in now. A thread that cannot be read, or is archived,
   * deleted or in another project, gives no ceiling to trust, so the new bot asks for everything.
   */
  const threadCeiling = Effect.fn("ForkBots.threadCeiling")(function* (bot: ForkBot | undefined) {
    if (bot?.threadId == null) return "approval-required" as const;
    const outcome = yield* threads.getThreadRecords(bot.threadId, ["runs"]).pipe(Effect.result);
    if (outcome._tag === "Failure") return "approval-required" as const;
    const thread = outcome.success.thread;
    return thread.archivedAt === null &&
      thread.deletedAt === null &&
      thread.projectId === bot.projectId
      ? thread.runtimeMode
      : ("approval-required" as const);
  });

  const answerProposal = Effect.fn("ForkBots.answerProposal")(function* (
    input: ForkBotAnswerProposalInput,
  ) {
    const parsed = yield* decodeAnswerProposalInput(input).pipe(
      Effect.mapError(() => invalidInput("Invalid proposal answer.")),
    );
    const decidedAt = yield* nowIso;
    // Checking it is pending and saving the answer under one lock: a second answer is refused.
    const answered = yield* storeLock.withPermits(1)(
      Effect.gen(function* () {
        const directory = yield* fileStore.read();
        const proposal = directory.proposals.find((candidate) => candidate.id === parsed.id);
        if (proposal === undefined) return yield* notFound("Bot proposal was not found.");
        if (proposal.status !== "pending") {
          return yield* invalidInput("This proposal was already answered.");
        }
        if (parsed.answer === "reject") {
          const rejected: ForkBotProposal = { ...proposal, status: "rejected", decidedAt };
          yield* fileStore.write(yield* markDecided(directory, rejected));
          return rejected;
        }
        // What was proposed counts, not what a lowered coordinator would leave of it: a proposal
        // saved before this rule is refused, since only the user gives a bot full access.
        if (proposal.runtimeMode === "full-access") {
          return yield* new ForkBotsError({
            reason: "permissionDenied",
            message:
              "A proposed bot never runs in full-access. Say no to it; you can create the bot yourself.",
          });
        }
        // The coordinator may have lost permissions since it proposed; the bot never gets more.
        // Only the active coordinator of the proposal's project lends its ceiling.
        const coordinator = directory.bots.find(
          (bot) =>
            bot.id === proposal.proposedBy &&
            bot.coordinator &&
            !bot.archived &&
            bot.projectId === proposal.projectId,
        );
        let runtimeMode: RuntimeMode = proposal.runtimeMode;
        for (const ceiling of [
          coordinator?.runtimeMode ?? "approval-required",
          yield* threadCeiling(coordinator),
        ]) {
          if (isRuntimeModeAbove(runtimeMode, ceiling)) runtimeMode = ceiling;
        }
        const id = `bot:${SecureRandom.uuidV4Unsafe()}`;
        const accepted: ForkBotProposal = { ...proposal, status: "accepted", botId: id, decidedAt };
        const { handle, name, role, instructions, projectId, modelSelection } = proposal;
        yield* saveBot(
          { handle, name, role, instructions, projectId, runtimeMode, modelSelection },
          id,
          (next) => markDecided(next, accepted),
        );
        return accepted;
      }),
    );
    if (answered.status === "rejected") {
      // The store already refuses the same handle; the note lets the coordinator skip similar
      // ones. Only the validated handle goes in: the agent's other text is not the user's.
      yield* memory
        .upsert(
          {
            projectId: answered.projectId,
            text: `El usuario dijo que no al bot propuesto @${answered.handle}. No vuelvas a proponer ese bot ni uno parecido.`,
            inclusion: "searchable",
          },
          "user",
        )
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("fork bots could not remember a rejected proposal", {
              proposalId: answered.id,
              reason: error.reason,
            }),
          ),
        );
    }
    return answered;
  });

  // Each running turn's MCP credential, only for turns this process saw start: one recovered
  // after a restart is not judged. A turn's entry goes when it ends.
  const runCredentials = new Map<OrchestrationV2Run["id"], string | undefined>();
  const noteRunUpdated = Effect.fn("ForkBots.noteRunUpdated")(function* (
    run: Pick<OrchestrationV2Run, "id" | "threadId" | "status">,
  ) {
    if (run.status === "running") {
      runCredentials.set(run.id, (yield* mcpSessions.read(run.threadId))?.providerSessionId);
      return;
    }
    if (!TERMINAL_RUN_STATUSES.has(run.status) || !runCredentials.has(run.id)) return;
    const credential = runCredentials.get(run.id);
    runCredentials.delete(run.id);
    // Only a completed turn: one that failed early may have stopped before the MCP connected.
    if (run.status !== "completed" || !(yield* Ref.get(botThreads)).has(run.threadId)) return;
    const missing = credential === undefined || handoffListedBy.get(run.threadId) !== credential;
    yield* storeLock.withPermits(1)(
      Effect.gen(function* () {
        const directory = yield* fileStore.read();
        const bot = directory.bots.find((candidate) => candidate.threadId === run.threadId);
        if (bot === undefined || bot.handoffToolsMissing === missing) return;
        const now = yield* nowIso;
        yield* fileStore.write({
          ...directory,
          bots: directory.bots.map((candidate) =>
            candidate.id === bot.id
              ? { ...candidate, handoffToolsMissing: missing, updatedAt: now }
              : candidate,
          ),
          updatedAt: now,
        });
      }),
    );
  });
  yield* forkParked(
    orchestrator.streamDomainEvents.pipe(
      Stream.mapEffect((event) =>
        event.type === "run.updated"
          ? noteRunUpdated(event.payload).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("fork bots could not check a turn for its handoff tools", {
                  threadId: event.threadId,
                  cause,
                }),
              ),
            )
          : Effect.void,
      ),
      Stream.retry(Schedule.spaced("30 seconds")),
      Stream.runDrain,
    ),
  );

  return ForkBots.of({
    list,
    propose,
    answerProposal,
    upsert,
    draft,
    setArchived,
    remove,
    sendMessage,
    handoff,
    dismissHandoff,
    workflowTurn,
    correctMemory,
    // Untraced: /mcp asks on every request, inside the request's own span.
    isBotThread: Effect.fnUntraced(function* (threadId: ThreadId) {
      return (yield* Ref.get(botThreads)).has(threadId);
    }),
    wasBotThread: Effect.fnUntraced(function* (threadId: ThreadId) {
      return isBotThreadId(threadId) || (yield* Ref.get(botThreads)).has(threadId);
    }),
    // Untraced: /mcp calls it on every tool list a bot's thread asks for.
    noteHandoffToolsListed: Effect.fnUntraced(function* (
      threadId: ThreadId,
      mcpCredentialId: string,
    ) {
      if ((yield* Ref.get(botThreads)).has(threadId))
        handoffListedBy.set(threadId, mcpCredentialId);
    }),
    noteRunUpdated,
  });
});

export const layer = Layer.effect(ForkBots, make);
