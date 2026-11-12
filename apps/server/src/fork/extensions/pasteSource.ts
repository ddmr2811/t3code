import { ForkExtensionsError, type ForkPastedSource } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
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

const nameFromCommand = (command: string, args: ReadonlyArray<string>): string => {
  const target = args.find((arg) => !arg.startsWith("-")) ?? command;
  if (
    command === "node" ||
    command === "python" ||
    command === "python3" ||
    !COMMAND_RUNNERS.has(command)
  ) {
    const base = target.split(/[\\/]/).pop() ?? target;
    return base.replace(/\.[a-z]+$/i, "") || base;
  }
  return nameFromPackage(target);
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

export const classifyPastedText = (text: string): ClassifiedPaste => {
  const input = text.trim();
  if (input.length === 0) return { _tag: "unknown" };

  if (/^(https?:\/\/)?(www\.)?claude\.ai(\/|$)/i.test(input)) return { _tag: "claudeAiConnector" };

  if (/^https?:\/\//i.test(input)) {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      return { _tag: "unknown" };
    }
    const github = parseGithubUrl(url);
    if (github) return { _tag: "githubRepo", ...github };
    return {
      _tag: "mcpRemote",
      url: input,
      transport: url.pathname.replace(/\/+$/, "").endsWith("/sse") ? "sse" : "http",
      suggestedName: nameFromUrl(url),
    };
  }

  const tokens = input.split(/\s+/);
  const [first = "", ...args] = tokens;
  if (COMMAND_RUNNERS.has(first) || /^(?:[a-zA-Z]:[\\/]|[\\/]|\.\.?[\\/]|~[\\/])/.test(first)) {
    return {
      _tag: "mcpCommand",
      command: first,
      args,
      suggestedName: nameFromCommand(first, args),
    };
  }

  if (tokens.length === 1 && /^[^@\s/]+@[^@\s/]+$/.test(input)) {
    return { _tag: "plugin", pluginRef: input };
  }

  const repoMatch = /^([\w.-]+)\/([\w.-]+)$/.exec(input);
  if (repoMatch) {
    return { _tag: "githubRepo", owner: repoMatch[1]!, repo: repoMatch[2]!, path: null, ref: null };
  }

  return { _tag: "unknown" };
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
  const response = yield* client
    .execute(request)
    .pipe(Effect.mapError((cause) => githubUnreachable("Couldn't reach GitHub.", String(cause))));
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
  );
  const content = (body as { content?: unknown }).content;
  if (typeof content !== "string") return "";
  return Buffer.from(content, "base64").toString("utf8");
});

const ManifestJson = Schema.fromJsonString(
  Schema.Struct({
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
      Effect.orElseSucceed(() => ({ plugins: [] as ReadonlyArray<{ name?: unknown }> })),
    );
    const plugins = (manifest.plugins ?? []).flatMap((p) =>
      typeof p.name === "string" ? [p.name] : [],
    );
    return { _tag: "marketplace", source: repoSource(repo), plugins } as const;
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
