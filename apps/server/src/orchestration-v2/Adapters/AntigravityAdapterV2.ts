import {
  ANTIGRAVITY_DEFAULT_MODEL,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationV2ProviderCapabilities,
  type ProviderSetupError,
  type ThreadId,
} from "@t3tools/contracts";
import type { SelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Exit from "effect/Exit";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as EffectAcpErrors from "effect-acp/errors";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { PULL_REQUEST_LINKING_INSTRUCTIONS } from "@t3tools/provider-core/server/runtimeInstructions";
import type { AntigravityAuth } from "../../provider/AntigravityAuth.ts";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  antigravityAppendsSystemPrompt,
  antigravityPermissionDisposition,
  antigravityPermissionMode,
  antigravityRuntimeModeForSessionMode,
  antigravitySteersWithPrompt,
  applyAntigravityAcpModelSelection,
  buildAntigravityPrompt,
  type AntigravityAcpRuntimeInput,
} from "../../provider/acp/AntigravityAcpSupport.ts";
import {
  ANTIGRAVITY_SUBAGENT_BATCH_TITLE,
  antigravitySubagentLaunches,
  describeAntigravitySubagentLaunches,
  readAntigravityChildrenAtWork,
  readAntigravityPendingReply,
} from "../../provider/acp/AntigravityChildWork.ts";
import { readAntigravityClientTextFile } from "../../provider/acp/AntigravityClientFiles.ts";
import {
  ensureThreadAttachmentsDir,
  threadAttachmentsDir,
  threadAttachmentsDirIdentity,
  threadAttachmentsDirIfUnchanged,
} from "../../threadAttachments.ts";
import { watchAntigravityPromptOutcome } from "../../provider/acp/AntigravityTurnOutcome.ts";
import {
  antigravityApprovalOptions,
  antigravitySwarmAddChildSessionId,
  antigravitySwarmAddModel,
  antigravityToolOutlivesPrompt,
  antigravityCommandOutlivesPrompt,
  antigravitySubagentOutput,
  classifyAntigravitySubagentToolCall,
  extractAntigravityUserInputQuestion,
  makeAntigravityReadRepair,
  makeAntigravityUpdateStepsPlans,
  makeAntigravityUserInputResponse,
  normalizeAntigravityToolCall,
} from "../../provider/acp/AntigravityProtocol.ts";
import { isAntigravitySignInRequiredError } from "../../provider/antigravityAuthSupport.ts";
import {
  antigravityViewShows,
  antigravityWorkspaceView,
  type AntigravitySandboxArea,
} from "../../provider/antigravitySandbox.ts";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@t3tools/provider-acp/server/adapter";

const ANTIGRAVITY_PROVIDER = ProviderDriverKind.make("antigravity");

const AntigravityProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
    supportsRuntimeModeSwitchInSession: true,
  },
  tools: {
    ...AcpProviderCapabilitiesV2.tools,
    supportsMcpTools: false,
  },
  subagents: {
    ...AcpProviderCapabilitiesV2.subagents,
    supportsSubagents: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

export type AntigravityAdapterV2RuntimeInput = Omit<
  AntigravityAcpRuntimeInput,
  "spawn" | "childProcessSpawner"
> & {
  /** Present for a thread's session; setup and helper processes serve no thread. */
  readonly thread?: {
    readonly id: ThreadId;
    readonly extraRoots: ReadonlyArray<string>;
    /** The thread's own attachment folder, the only part of the store its agent may see. */
    readonly attachmentsFolder: string | null;
  };
};

export interface AntigravityAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly selfInvocation: SelfInvocation;
  readonly makeRuntime: (
    input: AntigravityAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError | ProviderSetupError,
    Scope.Scope
  >;
  readonly withProcess: AntigravityAuth["withProcess"];
  readonly defaultModel: Effect.Effect<string | undefined>;
  readonly supportsNativeGoals?: Effect.Effect<boolean>;
  readonly onSessionStarted?: (
    started: AcpSessionRuntime.AcpSessionRuntimeStartResult,
    cwd: string,
    session?: { readonly resumed: boolean },
  ) => Effect.Effect<void>;
  readonly onSessionEvent?: AcpAdapterV2Flavor["onSessionEvent"];
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly continuationRequests?: Parameters<typeof makeAcpAdapterV2>[0]["continuationRequests"];
  /** The agent's GEMINI_HOME. Its session logs show turns that ended on an upstream error. */
  readonly profileDirectory?: string;
  /** Present when sessions run in the sandbox, which this adapter's own file reads then follow. */
  readonly sandbox?: {
    /** The GEMINI_HOME of one thread's sessions. */
    readonly threadProfileDirectory: (threadId: ThreadId) => string;
    readonly area: AntigravitySandboxArea;
  };
}

/**
 * Native subagent tools report no child session ids, so children stay read-only.
 * Only permission prompts carry the launch; NativeChildWorkQuery matches their ids by this text.
 */
const extractAntigravitySubagentUpdate: NonNullable<AcpAdapterV2Flavor["extractSubagentUpdate"]> = (
  toolCall,
) => {
  if (classifyAntigravitySubagentToolCall(toolCall) !== "subagent") {
    return undefined;
  }
  const status =
    toolCall.status === "failed" ? "failed" : toolCall.status === "pending" ? "pending" : "running";
  const launches = antigravitySubagentLaunches(toolCall.data.rawInput);
  const launch = launches === undefined ? undefined : describeAntigravitySubagentLaunches(launches);
  return {
    nativeTaskId: toolCall.toolCallId,
    prompt:
      launch?.prompt ??
      antigravitySubagentOutput(toolCall) ??
      toolCall.detail ??
      toolCall.title ??
      ANTIGRAVITY_SUBAGENT_BATCH_TITLE,
    title: launch?.title ?? ANTIGRAVITY_SUBAGENT_BATCH_TITLE,
    model: antigravitySwarmAddModel(toolCall),
    status,
    childSessionId: antigravitySwarmAddChildSessionId(toolCall),
    result: status === "failed" ? (antigravitySubagentOutput(toolCall) ?? null) : null,
  };
};

interface AntigravityFlavorServices {
  readonly random: SecureRandom.SecureRandom["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly host: ProviderHost.ProviderHost["Service"];
}

export function makeAntigravityAcpAdapterFlavor(
  options: AntigravityAdapterV2Options & AntigravityFlavorServices,
): AcpAdapterV2Flavor {
  const { profileDirectory } = options;
  // The agent reads its own thread's attachment folder, never the store every thread shares.
  // Roots are compared after resolving links, so the folder must still be the directory this
  // session opened: one swapped for a link elsewhere is no longer a root.
  const openedFolders = new Map<string, { readonly dev: number; readonly ino: number }>();
  // The folders each thread's process was launched with, which its file reads are served from too.
  const launchedRoots = new Map<string, ReadonlyArray<string>>();
  // The server reads a session's native files in its thread's profile, where the process wrote
  // them. The thread decides, never the session id: the agent chooses that.
  const profileOf = (threadId: ThreadId) => options.sandbox?.threadProfileDirectory(threadId);
  const antigravityClientFileRoots = Effect.fn("AntigravityAdapterV2.clientFileRoots")(function* (
    cwd: string | null,
    threadId: string,
  ) {
    const opened = openedFolders.get(threadId);
    const current = yield* threadAttachmentsDirIdentity({
      attachmentsDir: options.host.paths.attachmentsDir,
      threadId,
    });
    const folder =
      opened !== undefined &&
      current !== null &&
      current.dev === opened.dev &&
      current.ino === opened.ino
        ? threadAttachmentsDir({ attachmentsDir: options.host.paths.attachmentsDir, threadId })
        : null;
    const own = folder === null ? [] : [folder];
    if (options.sandbox === undefined) {
      return { roots: [...(cwd === null ? [] : [cwd]), ...own], masks: [] };
    }
    // The same rule as the sandbox's mounts: a file the agent's process cannot see is not read
    // for it here either. Its own attachment folder is the one thing inside T3's state.
    const area = options.sandbox.area;
    const view =
      cwd === null
        ? undefined
        : yield* Effect.promise(() =>
            // A folder the sandbox refuses as a workspace is not one to read from either.
            antigravityWorkspaceView({
              area,
              cwd,
              extraRoots: launchedRoots.get(threadId) ?? [],
            }).catch(() => undefined),
          );
    return { roots: [...(view?.roots ?? []), ...own], masks: view?.masks ?? [] };
  });
  const makeRuntime = Effect.fn("AntigravityAdapterV2.makeRuntime")(
    function* (input: AcpAdapterV2RuntimeInput) {
      const scope = yield* Scope.fork(yield* Effect.scope);
      // Attachments reach agy only through client reads of this folder, never as a workspace root.
      yield* ensureThreadAttachmentsDir({
        attachmentsDir: options.host.paths.attachmentsDir,
        threadId: input.threadId,
      });
      const identity = yield* threadAttachmentsDirIdentity({
        attachmentsDir: options.host.paths.attachmentsDir,
        threadId: input.threadId,
      });
      if (identity === null) openedFolders.delete(input.threadId);
      else openedFolders.set(input.threadId, identity);
      const extraRoots = [
        ...(input.extraRoots ?? []),
        ...(input.runtimePolicy.workspace?.extraRoots ?? []),
      ];
      launchedRoots.set(input.threadId, extraRoots);
      const runtime = yield* options
        .withProcess(
          Scope.close(scope, Exit.void),
          options.makeRuntime({
            ...input,
            thread: {
              id: input.threadId,
              extraRoots,
              attachmentsFolder:
                identity === null
                  ? null
                  : threadAttachmentsDir({
                      attachmentsDir: options.host.paths.attachmentsDir,
                      threadId: input.threadId,
                    }),
            },
            clientFileReads: true,
            sessionSystemPromptAppend: PULL_REQUEST_LINKING_INSTRUCTIONS,
          }),
        )
        .pipe(Effect.provideService(Scope.Scope, scope));
      // Repair keeps state across updates, so each runtime must have one session-update handler.
      const reads = makeAntigravityReadRepair();
      const plans = makeAntigravityUpdateStepsPlans();
      // Served reads are reported from the read handler, so they take turns with agent updates.
      const updates = yield* Semaphore.make(1);
      let projectUpdate: Parameters<typeof runtime.handleSessionUpdate>[0] | undefined;
      return {
        ...runtime,
        handleReadTextFile: (handler) =>
          runtime.handleReadTextFile((request, context) =>
            handler(request, context).pipe(
              Effect.onExit((exit) => {
                const served = reads.attempted(request.path, Exit.isSuccess(exit));
                if (served === undefined || projectUpdate === undefined) return Effect.void;
                return updates
                  .withPermit(
                    projectUpdate({
                      sessionId: served.sessionId,
                      update: {
                        sessionUpdate: "tool_call_update",
                        toolCallId: served.toolCallId,
                        status: "completed",
                      },
                    }),
                  )
                  .pipe(Effect.ignore);
              }),
            ),
          ),
        prompt: (payload, promptOptions) =>
          Effect.sync(reads.reset).pipe(Effect.andThen(runtime.prompt(payload, promptOptions))),
        handleSessionUpdate: (handler) => {
          projectUpdate = handler;
          return runtime.handleSessionUpdate((notification) => {
            const update = plans(reads.repair(notification));
            return update === undefined ? Effect.void : updates.withPermit(handler(update));
          });
        },
        start: () =>
          runtime.start().pipe(
            Effect.tap(
              (started) =>
                options.onSessionStarted?.(started, input.cwd, {
                  resumed:
                    input.resumeSessionId !== undefined &&
                    started.sessionId === input.resumeSessionId,
                }) ?? Effect.void,
            ),
          ),
      } satisfies typeof runtime;
    },
    Effect.provideService(SecureRandom.SecureRandom, options.random),
    Effect.mapError((cause): EffectAcpErrors.AcpError =>
      cause._tag === "ProviderSetupError"
        ? new EffectAcpErrors.AcpTransportError({ detail: cause.detail, cause })
        : cause,
    ),
  );

  return {
    driver: ANTIGRAVITY_PROVIDER,
    runtimeHarness: "Antigravity",
    capabilities: AntigravityProviderCapabilitiesV2,
    supportsNativeGoals: options.supportsNativeGoals ?? Effect.succeed(false),
    // On purpose: T3's MCP reads other threads and delegates work to agents outside the sandbox.
    withoutT3Mcp: true,
    sessionCarriesPullRequestLinking: antigravityAppendsSystemPrompt,
    makeRuntime,
    buildAttachmentPrompt: ({ text, attachments, resolveAttachmentPath, promptCapabilities }) =>
      buildAntigravityPrompt({
        input: text,
        attachments,
        resolveAttachmentPath,
        promptCapabilities,
      }).pipe(
        Effect.map((blocks) => (text.trim() ? blocks.slice(1) : blocks)),
        Effect.provideService(FileSystem.FileSystem, options.fileSystem),
        Effect.provideService(Path.Path, options.path),
      ),
    // Loading history replays tool calls; resume avoids replay.
    subagentsIdleOnTurnCompletion: true,
    // A finished background command or timer wakes the agent with no prompt open: it streams a
    // reply and asks for permissions, and no prompt response ever ends that reply.
    enablePostSettleContinuation: true,
    deferFinalizeForBackgroundWork: true,
    wakeOnDetachedRequest: true,
    replyEndsWithUsageUpdate: true,
    toolOutlivesPrompt: antigravityToolOutlivesPrompt,
    // agy sometimes loses the terminal update or wake for a background command, which would
    // hold the turn in Working forever. 30 minutes still leaves long commands room.
    postSettleCommandHold: {
      timeout: "30 minutes",
      isCommand: antigravityCommandOutlivesPrompt,
    },
    // session/cancel ends the agent's running commands, so only Stop sends it once the prompt
    // has ended. A message sent while a command runs leaves the command alone.
    preserveRuntimeOnSettledInterrupt: true,
    // `agy acp` reads a prompt sent mid-turn as a steer; cancel-and-restart killed its subagents.
    steersWithPrompt: antigravitySteersWithPrompt,
    ...(options.onSessionEvent === undefined ? {} : { onSessionEvent: options.onSessionEvent }),
    applyModelSelection: Effect.fn("AntigravityAdapterV2.applyModelSelection")(function* ({
      runtime,
      modelSelection,
    }) {
      const defaultModel = yield* options.defaultModel;
      return yield* applyAntigravityAcpModelSelection({
        runtime,
        model:
          modelSelection.model === ANTIGRAVITY_DEFAULT_MODEL ? undefined : modelSelection.model,
        defaultModel,
        mapError: (cause) => cause,
      });
    }),
    sessionModeForPolicy: (policy) => antigravityPermissionMode(policy.runtimeMode),
    runtimeModeForSessionMode: antigravityRuntimeModeForSessionMode,
    clientFileSystem: {
      readTextFile: (request, cwd, threadId) =>
        antigravityClientFileRoots(cwd, threadId).pipe(
          Effect.flatMap(({ roots, masks }) =>
            readAntigravityClientTextFile({
              fileSystem: options.fileSystem,
              path: options.path,
              allowedRoots: roots,
              shows: (candidate) => antigravityViewShows({ roots, masks }, candidate),
              request,
            }),
          ),
        ),
    },
    permissionDisposition: (policy, request, threadId) => {
      const opened = openedFolders.get(threadId);
      const folder =
        opened === undefined
          ? null
          : threadAttachmentsDirIfUnchanged(
              { attachmentsDir: options.host.paths.attachmentsDir, threadId },
              opened,
            );
      return antigravityPermissionDisposition(policy, request, folder === null ? [] : [folder]);
    },
    approvalOptions: antigravityApprovalOptions,
    extractPermissionQuestion: (request) => {
      const question = extractAntigravityUserInputQuestion(request);
      if (question === undefined) return undefined;
      return {
        question,
        respond: (answers) => makeAntigravityUserInputResponse(request, answers),
      };
    },
    normalizeToolCall: normalizeAntigravityToolCall,
    extractSubagentUpdate: extractAntigravitySubagentUpdate,
    supportsImagePrompts: true,
    compactViaAdvertisedCommand: true,
    requiresSignIn: isAntigravitySignInRequiredError,
    checksVersionAtHandshake: true,
    // Antigravity can leave a prompt open without updates; long tools and approvals pause this.
    promptInactivityTimeout: "15 minutes",
    reportsPerTurnPromptUsage: true,
    geminiPromptUsage: true,
    ...(profileDirectory === undefined
      ? {}
      : {
          watchPromptOutcome: (sessionId: string, threadId: ThreadId) =>
            watchAntigravityPromptOutcome(profileOf(threadId) ?? profileDirectory, sessionId),
          subagentsOutlivingPrompt: ({ threadId, sessionId, nativeTaskIds }) =>
            readAntigravityChildrenAtWork({
              profileDirectory: profileOf(threadId) ?? profileDirectory,
              rootSessionId: sessionId,
              toolCallIds: nativeTaskIds,
            }),
          hasPendingReply: (sessionId: string, threadId: ThreadId) =>
            readAntigravityPendingReply({
              profileDirectory: profileOf(threadId) ?? profileDirectory,
              sessionId,
            }),
        }),
  };
}

export const makeAntigravityAdapterV2 = Effect.fn("makeAntigravityAdapterV2")(function* (
  options: AntigravityAdapterV2Options,
) {
  const services: AntigravityFlavorServices = {
    random: yield* SecureRandom.SecureRandom,
    fileSystem: yield* FileSystem.FileSystem,
    path: yield* Path.Path,
    host: yield* ProviderHost.ProviderHost,
  };
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeAntigravityAcpAdapterFlavor({ ...options, ...services }),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.continuationRequests === undefined
      ? {}
      : { continuationRequests: options.continuationRequests }),
  });
});
