// Fork-only: commits that reached `dev` on a remote, as the local remote-tracking ref last saw
// them. Nothing here fetches: it reads what the repository already has, with a time limit.
import type { ForkActivityEntry } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import * as ProcessRunner from "../../processRunner.ts";
import { isoAt } from "./classify.ts";
import { summaryLine } from "./redact.ts";

const GIT_TIMEOUT = Duration.seconds(3);
const GIT_MAX_COMMITS = 50;
const FIELD = "\x1f";

/** `origin`'s `dev`, else the one on a GitHub remote, else the first remote that has one. */
export function pickDevRef(
  refs: ReadonlyArray<string>,
  remoteUrls: ReadonlyMap<string, string>,
): string | null {
  const remotes = refs.flatMap((ref) => {
    const match = /^refs\/remotes\/([^/]+)\/dev$/.exec(ref.trim());
    return match === null ? [] : [match[1]!];
  });
  const remote =
    remotes.find((name) => name === "origin") ??
    remotes.find((name) => /github\.com[:/]/i.test(remoteUrls.get(name) ?? "")) ??
    remotes[0];
  return remote === undefined ? null : `refs/remotes/${remote}/dev`;
}

export interface DevCommit {
  readonly hash: string;
  readonly at: string;
  readonly subject: string;
}

export function parseGitLog(stdout: string): ReadonlyArray<DevCommit> {
  return stdout.split("\n").flatMap((line) => {
    const [hash, at, ...rest] = line.split(FIELD);
    if (hash === undefined || at === undefined || !/^[0-9a-f]{7,64}$/.test(hash)) return [];
    const atMs = Date.parse(at);
    if (!Number.isFinite(atMs)) return [];
    return [{ hash, at: isoAt(atMs), subject: rest.join(FIELD) }];
  });
}

export function commitEntry(projectTitle: string, commit: DevCommit): ForkActivityEntry {
  const project = summaryLine(projectTitle, 80);
  return {
    id: `git:${commit.hash}`,
    at: commit.at,
    source: "git",
    ...(project.length > 0 ? { project } : {}),
    actor: "worker",
    summary: summaryLine(`Pushed to dev: ${commit.subject}`),
    status: "ok",
  };
}

/** Never fails: a folder that is no repository, or has no remote `dev`, answers nothing. */
export const readDevCommits = Effect.fn("ForkActivity.readDevCommits")(function* (
  workspaceRoot: string,
  sinceIso: string,
) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const git = (args: ReadonlyArray<string>) =>
    runner
      .run({
        command: "git",
        args: ["--no-optional-locks", "-C", workspaceRoot, ...args],
        timeout: GIT_TIMEOUT,
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: 256 * 1024,
        outputMode: "truncate",
      })
      .pipe(
        Effect.map((output) => (output.code === 0 && !output.timedOut ? output.stdout : null)),
        Effect.orElseSucceed(() => null),
      );
  const refs = yield* git(["for-each-ref", "--format=%(refname)", "refs/remotes/*/dev"]);
  if (refs === null) return [];
  const refList = refs.split("\n").filter((ref) => ref.length > 0);
  if (refList.length === 0) return [];
  const urls = new Map<string, string>();
  if (!refList.includes("refs/remotes/origin/dev")) {
    const config = yield* git(["config", "--get-regexp", "^remote\\..*\\.url$"]);
    for (const line of (config ?? "").split("\n")) {
      const match = /^remote\.(.+)\.url (.+)$/.exec(line.trim());
      if (match !== null) urls.set(match[1]!, match[2]!);
    }
  }
  const ref = pickDevRef(refList, urls);
  if (ref === null) return [];
  const log = yield* git([
    "log",
    ref,
    "--first-parent",
    `--since=${sinceIso}`,
    `--max-count=${GIT_MAX_COMMITS}`,
    `--format=%H${FIELD}%cI${FIELD}%s`,
  ]);
  return log === null ? [] : parseGitLog(log);
});
