import { FORK_INTEGRATION_GROUPS } from "@t3tools/contracts";

type Group = (typeof FORK_INTEGRATION_GROUPS.github)[number];
type Args = Readonly<Record<string, unknown>>;

/**
 * Our own list of what each github-mcp-server tool is. The server's `readOnlyHint` is never
 * consulted, and a tool missing here cannot be called at all.
 */
const GROUP_OF: Readonly<Record<string, Group>> = {
  get_me: "read",
  get_commit: "read",
  get_file_contents: "read",
  get_label: "read",
  get_latest_release: "read",
  get_release_by_tag: "read",
  get_repository_tree: "read",
  get_tag: "read",
  issue_read: "read",
  list_branches: "read",
  list_commits: "read",
  list_issue_types: "read",
  list_issues: "read",
  list_pull_requests: "read",
  list_releases: "read",
  list_tags: "read",
  pull_request_read: "read",
  search_code: "read",
  search_commits: "read",
  search_issues: "read",
  search_pull_requests: "read",
  search_repositories: "read",
  add_issue_comment: "comment",
  add_reply_to_pull_request_comment: "comment",
  add_comment_to_pending_review: "comment",
  pull_request_review_write: "comment",
  update_issue_comment: "comment",
  issue_write: "comment",
  create_branch: "branch-pr",
  create_or_update_file: "branch-pr",
  push_files: "branch-pr",
  create_pull_request: "branch-pr",
  update_pull_request: "branch-pr",
  update_pull_request_branch: "branch-pr",
  merge_pull_request: "merge-delete",
  delete_file: "merge-delete",
};

/** Tools that commit to the branch they name. */
const PUSHES = new Set(["create_or_update_file", "push_files", "delete_file"]);
/** Only the user publishes here, so no bot action writes to them, approved or not. */
const PROTECTED_BRANCHES = new Set(["main", "master", "dev"]);

const GITHUB_TOOLS = Object.keys(GROUP_OF);

export interface Classified {
  readonly group: Group;
  /** Changes nothing in the app, so a thread in plan mode may still run it. */
  readonly reads: boolean;
  /** Goes to the user's inbox even when the bot's group is `allow`. */
  readonly alwaysAsk: boolean;
}

/** Undefined for a tool we never classified: the caller refuses it. */
export function classifyGithub(action: string, args: Args): Classified | undefined {
  const group = GROUP_OF[action];
  if (group === undefined) return undefined;
  // Closing an issue or a pull request counts as deleting it, whatever tool does it.
  const closes =
    (action === "issue_write" || action === "update_pull_request") && args.state === "closed";
  const effective = closes ? "merge-delete" : group;
  return {
    group: effective,
    reads: effective === "read",
    alwaysAsk: effective === "merge-delete" || PUSHES.has(action),
  };
}

const isProtected = (branch: unknown) =>
  typeof branch !== "string" || PROTECTED_BRANCHES.has(branch.replace(/^refs\/heads\//, ""));

/** The read whose answer `refuseGithub` needs before this action, if any. */
export function githubLookup(action: string, args: Args) {
  if (action !== "merge_pull_request" && action !== "update_pull_request_branch") return undefined;
  const { owner, repo, pullNumber } = args;
  return { action: "pull_request_read", args: { method: "get", owner, repo, pullNumber } };
}

/**
 * Why this action may never run, or undefined. `pull` is the answer to `githubLookup`, as
 * GitHub's API gives a pull request; one that could not be read is refused.
 */
export function refuseGithub(action: string, args: Args, pull: unknown): string | undefined {
  if (PUSHES.has(action)) {
    return isProtected(args.branch)
      ? `Bots never push to ${[...PROTECTED_BRANCHES].join(", ")} or to an unnamed branch.`
      : undefined;
  }
  if (githubLookup(action, args) === undefined) return undefined;
  const found = pull as {
    readonly base?: { readonly ref?: unknown; readonly repo?: { default_branch?: unknown } };
    readonly head?: { readonly ref?: unknown };
  } | null;
  // Merging writes the base branch; updating the branch writes the head.
  const written = action === "merge_pull_request" ? found?.base?.ref : found?.head?.ref;
  if (isProtected(written) || written === found?.base?.repo?.default_branch) {
    return `Bots never write to ${typeof written === "string" ? written : "a branch that could not be read"}: only the user publishes there.`;
  }
  return undefined;
}

/** The login in `get_me`'s answer. */
export function githubAccount(answer: unknown): string | undefined {
  const login = (answer as { login?: unknown } | null | undefined)?.login;
  return typeof login === "string" ? login : undefined;
}

/** The token reaches this one process, by its environment, and nothing else. */
export function githubProcess(command: string, token: string, host: string | undefined) {
  return {
    command,
    args: [
      "stdio",
      "--tools",
      GITHUB_TOOLS.join(","),
      ...(host === undefined ? [] : ["--gh-host", host]),
    ],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: token },
  };
}
