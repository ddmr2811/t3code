import { ForkExtensionsError, type ForkPastedSource } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

export interface GithubRepoRef {
  readonly owner: string;
  readonly repo: string;
  readonly path: string | null;
  readonly ref: string | null;
}

export type ClassifiedPaste = ForkPastedSource | ({ readonly _tag: "githubRepo" } & GithubRepoRef);

const COMMAND_RUNNERS = new Set([
  "npx",
  "uvx",
  "node",
  "python",
  "python3",
  "bunx",
  "pnpm",
  "deno",
]);
const GENERIC_PACKAGE_NAMES = new Set(["mcp", "server", ""]);

const nameFromUrl = (url: URL): string => {
  const labels = url.hostname
    .replace(/^(mcp|www)\./, "")
    .split(".")
    .filter((label) => label.length > 0);
  if (labels.length <= 1) return labels[0] ?? url.hostname;
  return labels[labels.length - 2] ?? labels[0]!;
};

const nameFromPackage = (spec: string): string => {
  const scoped = spec.startsWith("@");
  const [scope, rest] = scoped
    ? (spec.slice(1).split("/", 2) as [string, string | undefined])
    : [null, spec];
  const unversioned = (rest ?? "").replace(/@.*$/, "");
  const trimmed = unversioned
    .replace(/^(mcp-server-|server-)/, "")
    .replace(/(-mcp-server|-mcp|-server)$/, "");
  if (GENERIC_PACKAGE_NAMES.has(trimmed) && scope) return scope;
  return trimmed || unversioned || spec;
};

const parseGithubUrl = (url: URL): GithubRepoRef | null => {
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return null;
  const parts = url.pathname.split("/").filter((part) => part.length > 0);
  const [owner, repoRaw, kind, ref, ...rest] = parts;
  if (!owner || !repoRaw) return null;
  const repo = repoRaw.replace(/\.git$/, "");
  if ((kind === "tree" || kind === "blob") && ref) {
    return { owner, repo, ref, path: rest.length > 0 ? rest.join("/") : null };
  }
  return { owner, repo, path: null, ref: null };
};

const WINDOWS_EXECUTABLE = /\.(?:exe|cmd|bat|ps1)$/i;
// \x5c is a backslash: the character class accepts both path separators.
const PATH_START = /^(?:[a-zA-Z]:[\x5c/]|\x5c\x5c|\.{1,2}[\x5c/]|~[\x5c/]|\/)/;
const PACKAGE_LIKE = /^@?[a-zA-Z0-9][\w.-]*(?:\/[\w.-]+)?(?:@[\w.^~<>=*-]+)?$/;
const PLAIN_WORD = /^[a-z]+$/;
const SCRIPT_FILE = /\.(?:js|mjs|cjs|ts|py)$/i;

const unknown = { _tag: "unknown" } as const;

const mcpCommand = (
  command: string,
  args: ReadonlyArray<string>,
  suggestedName: string,
): ClassifiedPaste => ({ _tag: "mcpCommand", command, args, suggestedName });

const nameFromScript = (target: string): string => {
  const base = target.split(/[\x5c/]/).pop() ?? target;
  return base.replace(/\.[a-z0-9]+$/i, "") || base;
};

const splitQuotedCommand = (input: string): { command: string; rest: string } | null => {
  const quote = input[0];
  if (quote !== '"' && quote !== "'") return null;
  const end = input.indexOf(quote, 1);
  if (end < 0) return null;
  return { command: input.slice(1, end), rest: input.slice(end + 1).trim() };
};

const classifyCommandTokens = (command: string, args: ReadonlyArray<string>): ClassifiedPaste => {
  const nonFlags = args.filter((arg) => !arg.startsWith("-"));
  switch (command) {
    case "npx":
    case "bunx":
    case "uvx": {
      const [target, ...more] = nonFlags;
      if (!target || !PACKAGE_LIKE.test(target)) return unknown;
      // "npx is great" reads as prose, not as a package followed by words.
      if (PLAIN_WORD.test(target) && more.some((word) => PLAIN_WORD.test(word))) return unknown;
      return mcpCommand(command, args, nameFromPackage(target));
    }
    case "pnpm": {
      if (args[0] !== "dlx") return unknown;
      const target = args.slice(1).find((arg) => !arg.startsWith("-"));
      if (!target || !PACKAGE_LIKE.test(target)) return unknown;
      return mcpCommand(command, args, nameFromPackage(target));
    }
    case "node":
    case "python":
    case "python3": {
      const moduleFlag = args.findIndex((arg) => arg === "-m" || arg === "-c");
      if (moduleFlag >= 0 && args[moduleFlag + 1]) {
        return mcpCommand(command, args, nameFromScript(args[moduleFlag + 1]!));
      }
      const script = args.find((arg) => SCRIPT_FILE.test(arg));
      if (!script) return unknown;
      return mcpCommand(command, args, nameFromScript(script));
    }
    case "deno": {
      const script = args.find((arg) => SCRIPT_FILE.test(arg) || /^https?:\/\//.test(arg));
      if (args[0] !== "run" || !script) return unknown;
      return mcpCommand(command, args, nameFromScript(script));
    }
    default:
      return unknown;
  }
};

export const classifyPastedText = (text: string): ClassifiedPaste => {
  const input = text.trim();
  if (input.length === 0) return unknown;

  if (/^(?:https?:\/\/)?(?:www\.)?claude\.ai(?:\/|$)/i.test(input)) {
    return { _tag: "claudeAiConnector" };
  }

  if (/^https?:\/\//i.test(input)) {
    // A URL followed by flags, prose or another line is not something we can install as-is.
    if (/\s/.test(input)) return unknown;
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      return unknown;
    }
    if (url.hostname === "github.com" || url.hostname === "www.github.com") {
      const github = parseGithubUrl(url);
      return github ? { _tag: "githubRepo", ...github } : unknown;
    }
    return {
      _tag: "mcpRemote",
      url: input,
      transport: url.pathname.replace(/\/+$/, "").endsWith("/sse") ? "sse" : "http",
      suggestedName: nameFromUrl(url),
    };
  }

  // A quoted executable keeps its spaces: "C:\Program Files\x.exe" --flag
  const quoted = splitQuotedCommand(input);
  if (quoted) {
    if (!PATH_START.test(quoted.command)) return unknown;
    const args = quoted.rest.length > 0 ? quoted.rest.split(/\s+/) : [];
    return mcpCommand(quoted.command, args, nameFromScript(quoted.command));
  }

  // An unquoted path with spaces is only trusted when the whole input is the executable.
  if (PATH_START.test(input) && WINDOWS_EXECUTABLE.test(input)) {
    return mcpCommand(input, [], nameFromScript(input));
  }

  const tokens = input.split(/\s+/);
  const [first = "", ...args] = tokens;
  if (PATH_START.test(first)) return mcpCommand(first, args, nameFromScript(first));
  if (COMMAND_RUNNERS.has(first)) return classifyCommandTokens(first, args);

  if (tokens.length === 1 && /^[^@\s/]+@[^@\s/]+$/.test(input)) {
    return { _tag: "plugin", pluginRef: input };
  }

  const repoMatch = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(input);
  if (repoMatch) {
    return { _tag: "githubRepo", owner: repoMatch[1]!, repo: repoMatch[2]!, path: null, ref: null };
  }

  return unknown;
};

const githubUnreachable = (summary: string, rawOutput: string | null) =>
  new ForkExtensionsError({
    problem: {
      reason: "commandFailed",
      summary,
      nextStep: "GitHub didn't answer; check the link or try again later.",
      rawOutput,
    },
  });

const GITHUB_TIMEOUT = "10 seconds";

const withGithubTimeout = <A, R>(effect: Effect.Effect<A, ForkExtensionsError, R>) =>
  effect.pipe(
    Effect.timeoutOption(GITHUB_TIMEOUT),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new ForkExtensionsError({
              problem: {
                reason: "timeout",
                summary: "GitHub didn't answer in time.",
                nextStep: "Check your connection and try again.",
                rawOutput: null,
              },
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );

/** Fetches one file via the GitHub contents API. Returns null when it does not exist. */
const fetchGithubFile = Effect.fn("ForkExtensions.fetchGithubFile")(function* (
  client: HttpClient.HttpClient,
  repo: GithubRepoRef,
  file: string,
) {
  const full = [repo.path, file].filter((part) => part !== null && part !== "").join("/");
  const query = repo.ref ? `?ref=${encodeURIComponent(repo.ref)}` : "";
  const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/contents/${full}${query}`;
  const request = HttpClientRequest.get(url).pipe(
    HttpClientRequest.setHeaders({
      "User-Agent": "t3code-extensions",
      Accept: "application/vnd.github+json",
    }),
  );
  const response = yield* client.execute(request).pipe(
    Effect.mapError((cause) => githubUnreachable("Couldn't reach GitHub.", String(cause))),
    withGithubTimeout,
  );
  if (response.status === 404) return null;
  if (response.status >= 400) {
    return yield* githubUnreachable(
      response.status === 403 || response.status === 429
        ? "GitHub is rate limiting requests."
        : `GitHub answered with status ${response.status}.`,
      null,
    );
  }
  const body = yield* response.json.pipe(
    Effect.mapError((cause) =>
      githubUnreachable("GitHub sent an unreadable answer.", String(cause)),
    ),
    withGithubTimeout,
  );
  const content = (body as { content?: unknown }).content;
  if (typeof content !== "string") return "";
  return Buffer.from(content, "base64").toString("utf8");
});

const ManifestJson = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.optional(Schema.Unknown),
    plugins: Schema.optional(
      Schema.Array(Schema.Struct({ name: Schema.optional(Schema.Unknown) })),
    ),
  }),
);

const decodeManifest = Schema.decodeUnknownEffect(ManifestJson);

const repoSource = (repo: GithubRepoRef) =>
  [`${repo.owner}/${repo.repo}`, repo.path]
    .filter((part) => part !== null && part !== "")
    .join("/");

export const resolveGithubRepo = Effect.fn("ForkExtensions.resolveGithubRepo")(function* (
  repo: GithubRepoRef,
) {
  const client = yield* HttpClient.HttpClient;

  const marketplace = yield* fetchGithubFile(client, repo, ".claude-plugin/marketplace.json");
  if (marketplace !== null) {
    const manifest = yield* decodeManifest(marketplace).pipe(
      Effect.orElseSucceed(() => ({
        name: undefined,
        plugins: [] as ReadonlyArray<{ name?: unknown }>,
      })),
    );
    const plugins = (manifest.plugins ?? []).flatMap((p) =>
      typeof p.name === "string" ? [p.name] : [],
    );
    // `claude plugin install` addresses a plugin as `plugin@<marketplace name>`. A manifest
    // without a usable name is a guess: Claude Code names such a marketplace after its repo.
    const name =
      typeof manifest.name === "string" && manifest.name.trim() !== ""
        ? manifest.name.trim()
        : repo.repo;
    return { _tag: "marketplace", source: repoSource(repo), name, plugins } as const;
  }

  if ((yield* fetchGithubFile(client, repo, ".claude-plugin/plugin.json")) !== null) {
    return { _tag: "plugin", pluginRef: repoSource(repo) } as const;
  }

  if ((yield* fetchGithubFile(client, repo, "SKILL.md")) !== null) {
    const last = repo.path?.split("/").filter(Boolean).pop() ?? repo.repo;
    return { _tag: "skill", source: repoSource(repo), suggestedName: last } as const;
  }

  return { _tag: "unknown" } as const;
}) satisfies (
  repo: GithubRepoRef,
) => Effect.Effect<ForkPastedSource, ForkExtensionsError, HttpClient.HttpClient>;

/** What a pasted text installs; only a GitHub repo needs a look at its files. */
export const inspectPastedSource = Effect.fn("ForkExtensions.inspectSource")(function* (
  text: string,
) {
  const classified = classifyPastedText(text);
  if (classified._tag !== "githubRepo") return classified;
  return yield* resolveGithubRepo(classified);
}) satisfies (
  text: string,
) => Effect.Effect<ForkPastedSource, ForkExtensionsError, HttpClient.HttpClient>;
