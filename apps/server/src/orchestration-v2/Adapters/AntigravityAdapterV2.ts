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
  antigravityToolOutlivesPrompt,
  antigravitySubagentOutput,
  classifyAntigravitySubagentToolCall,
  extractAntigravityUserInputQuestion,
  makeAntigravityReadRepair,
  makeAntigravityUserInputResponse,
  normalizeAntigravityToolCall,
} from "../../provider/acp/AntigravityProtocol.ts";
import { isAntigravitySignInRequiredError } from "../../provider/antigravityAuthSupport.ts";
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
    supportsMcpTools: true,
  },
  subagents: {
    ...AcpProviderCapabilitiesV2.subagents,
    supportsSubagents: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

/** Thread variables reach the driver here; `makeAntigravityAcpRuntime` never reads them. */
export type AntigravityAdapterV2RuntimeInput = Omit<
  AntigravityAcpRuntimeInput,
  "spawn" | "childProcessSpawner"
> & {
  readonly processEnvironment?: NodeJS.ProcessEnv;
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
  ) => Effect.Effect<void>;
  readonly onSessionEvent?: AcpAdapterV2Flavor["onSessionEvent"];
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly continuationRequests?: Parameters<typeof makeAcpAdapterV2>[0]["continuationRequests"];
  /** The agent's GEMINI_HOME. Its session logs show turns that ended on an upstream error. */
  readonly profileDirectory?: string;
  /** The GEMINI_HOME of one thread's sessions, when each thread keeps its own. */
  readonly threadProfileDirectory?: (threadId: ThreadId) => string;
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
    model: null,
    status,
    childSessionId: null,
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
  // The server reads a session's native files where that session's process wrote them.
  const sessionProfiles = new Map<string, string>();
  const profileOf = (sessionId: string) => sessionProfiles.get(sessionId);
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
    return [...(cwd === null ? [] : [cwd]), ...(folder === null ? [] : [folder])];
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
      const sessionProfile = options.threadProfileDirectory?.(input.threadId);
      // Every session this process opens keeps its files in this process's profile.
      const ownSession = (sessionId: string) => {
        if (sessionProfile !== undefined) sessionProfiles.set(sessionId, sessionProfile);
      };
      const runtime = yield* options
        .withProcess(
          Scope.close(scope, Exit.void),
          options.makeRuntime({
            ...input,
            thread: {
              id: input.threadId,
              extraRoots: [
                ...(input.extraRoots ?? []),
                ...(input.runtimePolicy.workspace?.extraRoots ?? []),
              ],
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
          return runtime.handleSessionUpdate((notification) =>
            updates.withPermit(handler(reads.repair(notification))),
          );
        },
        start: () =>
          runtime.start().pipe(
            Effect.tap((started) => {
              ownSession(started.sessionId);
              return options.onSessionStarted?.(started, input.cwd) ?? Effect.void;
            }),
          ),
        loadSession: (sessionId, loadOptions) => {
          ownSession(sessionId);
          return runtime.loadSession(sessionId, loadOptions);
        },
        resumeSession: (sessionId, resumeOptions) => {
          ownSession(sessionId);
          return runtime.resumeSession(sessionId, resumeOptions);
        },
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
    // Agents that advertise HTTP MCP skip the stdio bridge process; others keep stdio.
    mcpOverHttp: true,
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
          Effect.flatMap((allowedRoots) =>
            readAntigravityClientTextFile({
              fileSystem: options.fileSystem,
              path: options.path,
              allowedRoots,
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
          watchPromptOutcome: (sessionId: string) =>
            watchAntigravityPromptOutcome(profileOf(sessionId) ?? profileDirectory, sessionId),
          subagentsOutlivingPrompt: ({ sessionId, nativeTaskIds }) =>
            readAntigravityChildrenAtWork({
              profileDirectory: profileOf(sessionId) ?? profileDirectory,
              rootSessionId: sessionId,
              toolCallIds: nativeTaskIds,
            }),
          hasPendingReply: (sessionId: string) =>
            readAntigravityPendingReply({
              profileDirectory: profileOf(sessionId) ?? profileDirectory,
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
