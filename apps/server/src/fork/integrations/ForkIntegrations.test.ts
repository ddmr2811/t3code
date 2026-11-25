// @effect-diagnostics nodeBuiltinImport:off - the fake GitHub is a plain HTTP server the real binary calls.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";

import { NodeServices } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import { type ForkBot, type ForkBotIntegrations, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ForkBots from "../bots/ForkBots.ts";
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

const botThread = ThreadId.make("thread:bot");

const bot = (integrations: ForkBotIntegrations, patch: Partial<ForkBot> = {}) =>
  ({
    id: "bot:ana",
    handle: "ana",
    threadId: botThread,
    archived: false,
    integrations,
    ...patch,
  }) as ForkBot;

const withIntegrations = <A, E>(
  integrations: ForkBotIntegrations,
  use: (harness: {
    readonly service: ForkIntegrations.ForkIntegrations["Service"];
    readonly github: { readonly seen: Array<Seen> };
    /** What the bot's thread was told, as the server queued it. */
    readonly told: Array<string>;
    readonly logs: Array<string>;
    readonly stateFiles: Effect.Effect<string>;
    /** The bot as the directory holds it; a test changes it to change its permissions. */
    readonly bots: Array<ForkBot>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const github = yield* fakeGithub;
      const told: Array<string> = [];
      const logs: Array<string> = [];
      const bots = [bot(integrations)];
      const layer = ForkIntegrations.layerWith({
        githubCommand: binary ?? "",
        githubHost: github.host,
      }).pipe(
        Layer.provide(ServerSecretStore.layer),
        Layer.provide(
          Layer.mock(ForkBots.ForkBots)({
            list: () => Effect.succeed({ bots, handoffs: [], proposals: [], updatedAt: null }),
            sendMessage: (input) =>
              Effect.sync(() => {
                told.push(input.text);
                return { bot: bots[0]!, threadId: botThread, queued: true };
              }),
          }),
        ),
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
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* service.connect({ app: "github", token: TOKEN });
        github.seen.length = 0;
        // Everything the server wrote outside its secret store.
        const stateFiles = fs.readDirectory(path.join(config.stateDir, "fork")).pipe(
          Effect.flatMap(
            Effect.forEach((name) => fs.readFileString(path.join(config.stateDir, "fork", name))),
          ),
          Effect.map((files) => files.join("\n")),
          Effect.orDie,
        );
        return yield* use({ service, github, told, logs, stateFiles, bots });
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
    withIntegrations({ github: { read: "allow" } }, ({ service, github, logs, stateFiles }) =>
      Effect.gen(function* () {
        const result = yield* service.call(botThread, {
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
    withIntegrations({ github: { read: "allow" } }, ({ service, github }) =>
      Effect.gen(function* () {
        // A group left out of the card, and a real github-mcp-server tool nobody classified.
        for (const action of ["add_issue_comment", "create_repository"]) {
          const result = yield* service.call(botThread, { ...comment, action });
          expect(result.status).toBe("denied");
        }
        const stranger = yield* service
          .call(ThreadId.make("thread:not-a-bot"), comment)
          .pipe(Effect.flip);
        expect(stranger.reason).toBe("permissionDenied");
        expect(github.seen.filter((request) => request.method !== "HEAD")).toEqual([]);
        expect((yield* service.list).requests).toEqual([]);

        // Search offers only what the card grants.
        const found = yield* service.search(botThread, "issue comment pull request merge");
        expect(found.length).toBeGreaterThan(0);
        expect(found.every((action) => action.group === "read")).toBe(true);
      }),
    ),
  );

  it.live("asks the user, then the server runs an approved request once with its arguments", () =>
    withIntegrations({ github: { comment: "ask" } }, ({ service, github, told }) =>
      Effect.gen(function* () {
        expect((yield* service.call(botThread, comment)).status).toBe("pending");
        // Asking again while it waits adds no second card.
        expect((yield* service.call(botThread, comment)).status).toBe("pending");
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
        expect(told).toHaveLength(1);
      }),
    ),
  );

  it.live("a yes does not run a request whose permission was removed meanwhile", () =>
    withIntegrations({ github: { comment: "ask" } }, ({ service, github, bots }) =>
      Effect.gen(function* () {
        yield* service.call(botThread, comment);
        bots[0] = bot({});
        const [request] = (yield* service.list).requests;
        const answered = yield* service.answer({ id: request!.id, answer: "approve" });
        expect(answered.status).toBe("failed");
        expect(writes(github.seen)).toEqual([]);
      }),
    ),
  );

  it.live("a no is final: nothing runs and the same request is refused without a new card", () =>
    withIntegrations({ github: { comment: "ask" } }, ({ service, github, told }) =>
      Effect.gen(function* () {
        yield* service.call(botThread, comment);
        const [request] = (yield* service.list).requests;
        yield* service.answer({ id: request!.id, answer: "deny" });
        expect(told).toHaveLength(1);

        expect((yield* service.call(botThread, comment)).status).toBe("denied");
        expect((yield* service.list).requests.map((entry) => entry.status)).toEqual(["denied"]);
        expect(writes(github.seen)).toEqual([]);
      }),
    ),
  );

  it.live("never writes main, and merging elsewhere still waits for the user", () =>
    withIntegrations(
      { github: { "branch-pr": "allow", "merge-delete": "allow" } },
      ({ service, github }) =>
        Effect.gen(function* () {
          const push = yield* service.call(botThread, {
            app: "github",
            action: "push_files",
            arguments: { owner: "acme", repo: "app", branch: "main", message: "m", files: [] },
          });
          const merge = (pullNumber: number) =>
            service.call(botThread, {
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
