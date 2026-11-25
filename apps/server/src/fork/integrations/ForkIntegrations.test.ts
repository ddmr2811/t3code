// @effect-diagnostics nodeBuiltinImport:off - the fake GitHub is a plain HTTP server the real binary calls.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";

import { NodeHttpServer, NodeServices } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  FORK_INTEGRATIONS_REQUEST_HISTORY,
  EnvironmentId,
  type ForkBot,
  type ForkBotIntegrations,
  ProjectId,
  type ProviderInteractionMode,
  ProviderInstanceId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import * as IntegrationsHandlers from "../../mcp/toolkits/integrations/handlers.ts";
import { IntegrationsToolkit } from "../../mcp/toolkits/integrations/tools.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ScheduledTasks from "../../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettingsService from "../../serverSettings.ts";
import * as ForkBots from "../bots/ForkBots.ts";
import * as ForkCoordination from "../coordination/ForkCoordination.ts";
import * as ForkProjectMemory from "../memory/ForkProjectMemory.ts";
import * as ForkIntegrations from "./ForkIntegrations.ts";

// The official github-mcp-server release binary. Without it these tests cannot run: they are
// about what the real process does with the token and the calls. (The runner drops T3CODE_*.)
const binary = process.env.GITHUB_MCP_SERVER_BIN;
const TOKEN = "ghp_fixture_token_that_must_never_leak";
const REJECTED_TOKEN = "ghp_fixture_token_github_rejects";

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly authorization: string;
  readonly body: string;
}

/** GitHub's REST API as far as these tests go, on 127.0.0.1. Every request is recorded. */
const fakeGithub = Effect.acquireRelease(
  Effect.callback<{ readonly host: string; readonly seen: Array<Seen> }>((resume) => {
    const seen: Array<Seen> = [];
    const server = NodeHttp.createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const authorization = request.headers.authorization ?? "";
        const url = request.url ?? "";
        seen.push({ method: request.method ?? "", url, authorization, body });
        const reply = (status: number, value: unknown) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(value));
        };
        if (authorization.includes(REJECTED_TOKEN))
          return reply(401, { message: "Bad credentials" });
        // The bio echoes the credential, as a hostile or careless API could.
        if (url.endsWith("/user")) return reply(200, { login: "octo", id: 1, bio: authorization });
        const pull = /\/pulls\/(\d+)$/.exec(url);
        if (pull !== null && request.method === "GET") {
          return reply(200, {
            number: Number(pull[1]),
            state: "open",
            title: "Cambio",
            html_url: `https://github.test/acme/app/pull/${pull[1]}`,
            user: { login: "octo" },
            head: { ref: "feature", sha: "abc" },
            base: { ref: pull[1] === "5" ? "main" : "release", sha: "def" },
          });
        }
        if (url.endsWith("/merge")) return reply(200, { merged: true, sha: "abc" });
        if (url.endsWith("/comments"))
          return reply(201, { id: 9, html_url: "https://github.test/c/9" });
        return reply(404, { message: "Not Found" });
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resume(Effect.succeed({ host: `http://127.0.0.1:${port}`, seen, server }));
    });
  }),
  (github) =>
    Effect.callback<void>((resume) => {
      (github as unknown as { server: NodeHttp.Server }).server.close(() => resume(Effect.void));
    }),
);

const codex = ProviderInstanceId.make("codex");
const projectA = ProjectId.make("proj-a");
const projectB = ProjectId.make("proj-b");
const fullAccess = { runtimeMode: "full-access", interactionMode: "default" } as const;
const baseBot = {
  handle: "ana",
  name: "Ana",
  role: "Revisa",
  instructions: "Sé breve.",
  projectId: projectA,
  modelSelection: { instanceId: codex, model: "gpt-5.4" },
};

interface Harness {
  readonly service: ForkIntegrations.ForkIntegrations["Service"];
  /** The real bot directory: a test edits the bot through it, as the ADE does. */
  readonly forkBots: ForkBots.ForkBots["Service"];
  readonly github: { readonly seen: Array<Seen> };
  /** A bot with these permissions and a live thread of its own. */
  readonly makeBot: (
    handle: string,
    integrations: ForkBotIntegrations,
  ) => Effect.Effect<ForkBot & { readonly threadId: ThreadId }>;
  /** The bot `withIntegrations` was asked for. */
  readonly bot: ForkBot & { readonly threadId: ThreadId };
  /** Every message queued into a thread after its first one, as the orchestrator received it. */
  readonly told: Array<{ readonly threadId: ThreadId; readonly text: string }>;
  /** Every thread launched, with the message that opened it. */
  readonly launched: Array<{ readonly threadId: ThreadId; readonly text: string }>;
  /** The modes each thread runs in now; its user may change them. */
  readonly threadModes: Map<
    ThreadId,
    { runtimeMode: RuntimeMode; interactionMode: ProviderInteractionMode }
  >;
  readonly logs: Array<string>;
  readonly stateFiles: Effect.Effect<string>;
}

/**
 * The real integrations service, bot directory, secret store and github-mcp-server. Only the
 * orchestrator behind the bots is stood in for: threads it launches and messages it queues.
 */
const withIntegrations = <A, E, R>(
  integrations: ForkBotIntegrations,
  use: (harness: Harness) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const github = yield* fakeGithub;
      const told: Harness["told"] = [];
      const launched: Harness["launched"] = [];
      const logs: Array<string> = [];
      const threadModes: Harness["threadModes"] = new Map();
      const threadProjects = new Map<ThreadId, ProjectId>();
      const shellOf = (threadId: ThreadId) => ({
        ...liveThreadShell(threadId, threadModes.get(threadId)),
        projectId: threadProjects.get(threadId) ?? projectA,
      });
      const orchestrator = Layer.mergeAll(
        Layer.mock(ProjectService.ProjectService)({
          getById: (projectId) => Effect.succeedSome({ id: projectId, title: "P" } as never),
        }),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({
          launch: (input) =>
            Effect.sync(() => {
              const threadId = ThreadId.make(`thread-bot-${launched.length + 1}`);
              launched.push({ threadId, text: input.initialMessage?.text ?? "" });
              threadProjects.set(threadId, input.projectId);
              threadModes.set(threadId, {
                runtimeMode: input.runtimeMode,
                interactionMode: input.interactionMode ?? "default",
              });
              return { threadId } as never;
            }),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (threadId) =>
            Effect.succeed(threadProjects.has(threadId) ? shellOf(threadId) : null),
          sendToThread: ((input: { threadId: ThreadId; text: string }) =>
            Effect.sync(() => {
              told.push({ threadId: input.threadId, text: input.text });
              return { delivery: "queued" } as never;
            })) as ThreadManagement.ThreadManagementServiceShape["sendToThread"],
        }),
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          listInstances: Effect.succeed([{ instanceId: codex }] as never),
        }),
        // An empty catalog is one still loading, which the bot directory accepts.
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ServerSettingsService.ServerSettingsService)({
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        }),
        Layer.mock(ScheduledTasks.ScheduledTaskService)({
          list: () => Effect.succeed({ tasks: [] } as never),
        }),
      );
      const layer = ForkIntegrations.layerWith({
        githubCommand: binary ?? "",
        githubHost: github.host,
      }).pipe(
        Layer.provide(ServerSecretStore.layer),
        Layer.provideMerge(ForkBots.layer),
        Layer.provideMerge(Layer.merge(ForkProjectMemory.layer, ForkCoordination.layer)),
        Layer.provideMerge(orchestrator),
        Layer.provideMerge(
          ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-fork-integrations-" }),
        ),
        Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
        Layer.provide(
          Logger.layer([Logger.make(({ message }) => void logs.push(JSON.stringify(message)))], {
            mergeWithExisting: false,
          }),
        ),
      );
      return yield* Effect.gen(function* () {
        const service = yield* ForkIntegrations.ForkIntegrations;
        const forkBots = yield* ForkBots.ForkBots;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* service.connect({ app: "github", token: TOKEN });
        github.seen.length = 0;
        const makeBot: Harness["makeBot"] = (handle, granted) =>
          Effect.gen(function* () {
            const created = yield* forkBots.upsert({
              ...baseBot,
              handle,
              runtimeMode: "full-access",
              integrations: granted,
            });
            const { bot, threadId } = yield* forkBots.sendMessage({ id: created.id, text: "hola" });
            return { ...bot, threadId };
          }).pipe(Effect.orDie);
        // Everything the server wrote outside its secret store.
        const stateFiles = fs.readDirectory(path.join(config.stateDir, "fork")).pipe(
          Effect.flatMap(
            Effect.forEach((name) => fs.readFileString(path.join(config.stateDir, "fork", name))),
          ),
          Effect.map((files) => files.join("\n")),
          Effect.orDie,
        );
        return yield* use({
          service,
          forkBots,
          github,
          makeBot,
          bot: yield* makeBot("ana", integrations),
          told,
          launched,
          threadModes,
          logs,
          stateFiles,
        });
      }).pipe(Effect.provide(layer));
    }),
  );

const comment = {
  app: "github" as const,
  action: "add_issue_comment",
  arguments: { owner: "acme", repo: "app", issue_number: 7, body: "hola" },
};
// The binary also probes the API root with HEAD when it starts.
const writes = (seen: ReadonlyArray<Seen>) =>
  seen.filter((request) => request.method !== "GET" && request.method !== "HEAD");

describe.skipIf(binary === undefined || !NodeFS.existsSync(binary))("ForkIntegrations", () => {
  it.live("runs an allowed read, and the token reaches GitHub's process and nothing else", () =>
    withIntegrations({ github: { read: "allow" } }, ({ service, bot, github, logs, stateFiles }) =>
      Effect.gen(function* () {
        const result = yield* service.call(bot.threadId, fullAccess, {
          app: "github",
          action: "get_me",
          arguments: {},
        });
        expect(result.status).toBe("done");
        expect(result.text).toContain("octo");
        // The process did receive it: GitHub saw the call authenticated.
        expect(new Set(github.seen.map((request) => request.authorization))).toEqual(
          new Set([`Bearer ${TOKEN}`]),
        );
        // GitHub echoed it back, and it still did not reach the bot.
        expect(result.text).not.toContain(TOKEN);
        expect(logs.join("\n")).not.toContain(TOKEN);
        expect(yield* stateFiles).not.toContain(TOKEN);
        // An agent's process inherits the server's environment.
        expect(Object.values(process.env).join("\n")).not.toContain(TOKEN);
      }),
    ),
  );

  it.live("stores no token GitHub rejects", () =>
    withIntegrations({}, ({ service }) =>
      Effect.gen(function* () {
        yield* service.connect({ app: "github", token: null });
        const refused = yield* service
          .connect({ app: "github", token: REJECTED_TOKEN })
          .pipe(Effect.flip);
        expect(refused.reason).toBe("invalidInput");
        expect((yield* service.list).apps).toEqual([
          { app: "github", connected: false, account: null },
        ]);
      }),
    ),
  );

  it.live("refuses what the bot's card does not grant, without calling GitHub", () =>
    withIntegrations({ github: { read: "allow" } }, ({ service, bot, github }) =>
      Effect.gen(function* () {
        // A group left out of the card, and a real github-mcp-server tool nobody classified.
        for (const action of ["add_issue_comment", "create_repository"]) {
          const result = yield* service.call(bot.threadId, fullAccess, { ...comment, action });
          expect(result.status).toBe("denied");
        }
        const stranger = yield* service
          .call(ThreadId.make("thread:not-a-bot"), fullAccess, comment)
          .pipe(Effect.flip);
        expect(stranger.reason).toBe("permissionDenied");
        expect(github.seen.filter((request) => request.method !== "HEAD")).toEqual([]);
        expect((yield* service.list).requests).toEqual([]);

        // Search offers only what the card grants.
        const found = yield* service.search(bot.threadId, "issue comment pull request merge");
        expect(found.length).toBeGreaterThan(0);
        expect(found.every((action) => action.group === "read")).toBe(true);
      }),
    ),
  );

  // Through /mcp with the credential the server issues a provider, so the thread's modes are
  // the ones the real handler reads, not ones this test hands the service.
  it.live(
    "a thread in plan mode, or one that asks before shell changes, writes nothing unasked",
    () =>
      withIntegrations({ github: { read: "allow", comment: "allow" } }, (harness) =>
        Effect.gen(function* () {
          const { bot, github, service, threadModes } = harness;
          const registry = yield* McpSessionRegistry.McpSessionRegistry;
          const issued = yield* registry.issue({
            threadId: bot.threadId,
            providerInstanceId: codex,
          });
          yield* HttpRouter.serve(
            McpHttpServer.layerMcpTransport(
              McpHttpServer.toolkitRegistration(IntegrationsToolkit, IntegrationsHandlers.layer),
            ).pipe(Layer.provide(ServerSettingsService.layerTest())),
            { disableListenLog: true, disableLogger: true },
          ).pipe(Layer.build);
          const httpClient = yield* HttpClient.HttpClient;
          const headers = {
            accept: "application/json, text/event-stream",
            authorization: issued.config.authorizationHeader,
          };
          const initialize = yield* httpClient.post("/mcp", {
            headers,
            body: HttpBody.text(
              `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"bot","version":"1.0.0"}}}`,
              "application/json",
            ),
          });
          const call = (input: object) =>
            httpClient
              .post("/mcp", {
                headers: {
                  ...headers,
                  "mcp-session-id": initialize.headers["mcp-session-id"]!,
                  "mcp-protocol-version": "2025-06-18",
                },
                body: HttpBody.text(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id: 2,
                    method: "tools/call",
                    params: { name: "integration_call", arguments: input },
                  }),
                  "application/json",
                ),
              })
              .pipe(
                Effect.flatMap((response) => response.text),
                Effect.map((text) => {
                  const line = text
                    .split("\n")
                    .find(
                      (candidate) => candidate.startsWith("data: ") || candidate.startsWith("{"),
                    );
                  const message = JSON.parse((line ?? "{}").replace(/^data: /u, "")) as {
                    result?: { structuredContent?: { status?: string } };
                  };
                  return message.result?.structuredContent?.status;
                }),
              );
          const body = (text: string) => ({
            ...comment,
            arguments: { ...comment.arguments, body: text },
          });

          // The card says «allow», and the thread's own modes still decide.
          threadModes.set(bot.threadId, { runtimeMode: "full-access", interactionMode: "plan" });
          expect(yield* call(body("desde plan"))).toBe("pending");
          threadModes.set(bot.threadId, {
            runtimeMode: "approval-required",
            interactionMode: "default",
          });
          expect(yield* call(body("pidiendo aprobación"))).toBe("pending");
          expect(writes(github.seen)).toEqual([]);
          expect((yield* service.list).requests.map((request) => request.status)).toEqual([
            "pending",
            "pending",
          ]);
          // Reading changes nothing, so plan mode does not hold it back.
          threadModes.set(bot.threadId, { runtimeMode: "full-access", interactionMode: "plan" });
          expect(yield* call({ app: "github", action: "get_me", arguments: {} })).toBe("done");

          // Where the thread may change the outside world unasked, «allow» is honoured.
          threadModes.set(bot.threadId, fullAccess);
          expect(yield* call(body("sin preguntar"))).toBe("done");
          expect(writes(github.seen).map((request) => JSON.parse(request.body))).toEqual([
            { body: "sin preguntar" },
          ]);
        }).pipe(
          Effect.provide(
            McpSessionRegistry.layer.pipe(
              Layer.provide(
                Layer.mock(ServerEnvironment.ServerEnvironment)({
                  getEnvironmentId: Effect.succeed(EnvironmentId.make("environment:integrations")),
                }),
              ),
              Layer.provideMerge(NodeHttpServer.layerTest),
              Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
            ),
          ),
        ),
      ),
  );

  it.live("asks the user, then the server runs an approved request once with its arguments", () =>
    withIntegrations({ github: { comment: "ask" } }, ({ service, bot, github, told }) =>
      Effect.gen(function* () {
        expect((yield* service.call(bot.threadId, fullAccess, comment)).status).toBe("pending");
        // Asking again while it waits adds no second card.
        expect((yield* service.call(bot.threadId, fullAccess, comment)).status).toBe("pending");
        const [request, ...others] = (yield* service.list).requests;
        expect(others).toEqual([]);
        expect(JSON.parse(request!.arguments)).toEqual(comment.arguments);
        expect(writes(github.seen)).toEqual([]);

        const done = yield* service.answer({ id: request!.id, answer: "approve" });
        expect(done.status).toBe("done");
        const again = yield* service
          .answer({ id: request!.id, answer: "approve" })
          .pipe(Effect.flip);
        expect(again.reason).toBe("invalidInput");
        expect(writes(github.seen).map(({ method, url }) => [method, url])).toEqual([
          ["POST", expect.stringContaining("/repos/acme/app/issues/7/comments")],
        ]);
        expect(JSON.parse(writes(github.seen)[0]!.body)).toEqual({ body: "hola" });
        expect(told.map((message) => message.threadId)).toEqual([bot.threadId]);
      }),
    ),
  );

  it.live("a yes does not run a request whose permission was removed meanwhile", () =>
    withIntegrations({ github: { comment: "ask" } }, ({ service, forkBots, bot, github }) =>
      Effect.gen(function* () {
        yield* service.call(bot.threadId, fullAccess, comment);
        // Permissions are read live, so changing them keeps the bot in its thread.
        const edited = yield* forkBots.upsert({
          ...baseBot,
          id: bot.id,
          runtimeMode: "full-access",
          integrations: {},
        });
        expect(edited.threadId).toBe(bot.threadId);
        const [request] = (yield* service.list).requests;
        const answered = yield* service.answer({ id: request!.id, answer: "approve" });
        expect(answered.status).toBe("failed");
        expect(writes(github.seen)).toEqual([]);
      }),
    ),
  );

  it.live("a bot moved to another project gets its old request neither run nor answered", () =>
    withIntegrations({ github: { comment: "ask" } }, (harness) =>
      Effect.gen(function* () {
        const { service, forkBots, bot, github, told, launched } = harness;
        yield* service.call(bot.threadId, fullAccess, comment);
        // The user moves the bot: it keeps its permissions and leaves the thread it asked from.
        const moved = yield* forkBots.upsert({
          ...baseBot,
          id: bot.id,
          runtimeMode: "full-access",
          projectId: projectB,
          integrations: { github: { comment: "ask" } },
        });
        expect(moved.threadId).toBeNull();
        const opened = launched.length;

        const [request] = (yield* service.list).requests;
        const answered = yield* service.answer({ id: request!.id, answer: "approve" });
        expect(answered.status).toBe("failed");
        expect(writes(github.seen)).toEqual([]);
        // Nothing about it reaches the bot's new project: no thread opened there, none told.
        expect(launched).toHaveLength(opened);
        expect(told).toEqual([]);
      }),
    ),
  );

  it.live("a no is final: nothing runs and the same request is refused without a new card", () =>
    withIntegrations({ github: { comment: "ask" } }, ({ service, bot, github, told }) =>
      Effect.gen(function* () {
        yield* service.call(bot.threadId, fullAccess, comment);
        const [request] = (yield* service.list).requests;
        yield* service.answer({ id: request!.id, answer: "deny" });
        expect(told).toHaveLength(1);

        expect((yield* service.call(bot.threadId, fullAccess, comment)).status).toBe("denied");
        expect((yield* service.list).requests.map((entry) => entry.status)).toEqual(["denied"]);
        expect(writes(github.seen)).toEqual([]);
      }),
    ),
  );

  it.live("a no still refuses its repeat after other bots fill the request history", () =>
    withIntegrations({ github: { comment: "ask" } }, ({ service, makeBot, bot }) =>
      Effect.gen(function* () {
        yield* service.call(bot.threadId, fullAccess, comment);
        const [refused] = (yield* service.list).requests;
        yield* service.answer({ id: refused!.id, answer: "deny" });

        // More answered requests than the history keeps, all from another bot.
        const busy = yield* makeBot("otra", { github: { read: "ask" } });
        for (let issue = 0; issue <= FORK_INTEGRATIONS_REQUEST_HISTORY; issue++) {
          yield* service.call(busy.threadId, fullAccess, {
            app: "github",
            action: "issue_read",
            arguments: { owner: "acme", repo: "app", issue_number: issue, method: "get" },
          });
          const pending = (yield* service.list).requests.find(
            (request) => request.status === "pending",
          );
          yield* service.answer({ id: pending!.id, answer: "approve" });
        }

        expect((yield* service.call(bot.threadId, fullAccess, comment)).status).toBe("denied");
        expect(
          (yield* service.list).requests.filter((request) => request.status === "pending"),
        ).toEqual([]);
      }),
    ),
  );

  it.live("never writes main, and merging elsewhere still waits for the user", () =>
    withIntegrations(
      { github: { "branch-pr": "allow", "merge-delete": "allow" } },
      ({ service, bot, github }) =>
        Effect.gen(function* () {
          const push = yield* service.call(bot.threadId, fullAccess, {
            app: "github",
            action: "push_files",
            arguments: { owner: "acme", repo: "app", branch: "main", message: "m", files: [] },
          });
          const merge = (pullNumber: number) =>
            service.call(bot.threadId, fullAccess, {
              app: "github",
              action: "merge_pull_request",
              arguments: { owner: "acme", repo: "app", pullNumber },
            });
          // Pull request 5 targets main; 6 targets another branch.
          expect([push.status, (yield* merge(5)).status]).toEqual(["denied", "denied"]);
          expect((yield* service.list).requests).toEqual([]);

          expect((yield* merge(6)).status).toBe("pending");
          expect(writes(github.seen)).toEqual([]);
          const [request] = (yield* service.list).requests;
          yield* service.answer({ id: request!.id, answer: "approve" });
          expect(writes(github.seen).map(({ method, url }) => [method, url])).toEqual([
            ["PUT", expect.stringContaining("/repos/acme/app/pulls/6/merge")],
          ]);
        }),
    ),
  );
});
