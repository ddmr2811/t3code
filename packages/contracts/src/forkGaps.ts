import * as Schema from "effect/Schema";
import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ForkBotId } from "./forkBots.ts";
import { RuntimeMode } from "./providerPolicy.ts";

/** Fork: what a bot does when it lacks a tool, one rung at a time, in `<stateDir>/fork/gaps.json`. */
export const FORK_GAPS_PROTOCOL_VERSION = 1;
export const FORK_GAPS_MAX_FILE_BYTES = 512 * 1024;
/** Steps one gap may record before the ladder closes and the user decides. */
export const FORK_GAP_MAX_ATTEMPTS = 8;
/** New tokens (uncached input plus output) the bot's thread may spend on one gap. */
export const FORK_GAP_MAX_TOKENS = 500_000;
/** New gaps one bot may open in a day, so renaming a gap does not reset its limits. */
export const FORK_GAPS_PER_BOT_AND_DAY = 3;
export const FORK_GAPS_DAY_MS = 24 * 60 * 60 * 1000;

const SINGLE_LINE_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** One line: a command with a line break is two commands. */
const singleLine = (maxLength: number) =>
  TrimmedNonEmptyString.check(
    Schema.isMaxLength(maxLength),
    Schema.makeFilter((value: string) => !SINGLE_LINE_CONTROL_PATTERN.test(value), {
      expected: "one line without control characters",
    }),
  );
const safeId = TrimmedNonEmptyString.check(
  Schema.makeFilter((value: string) => SAFE_ID_PATTERN.test(value) && !value.includes(".."), {
    expected: "a safe identifier",
  }),
);

export const ForkGapId = safeId;
export type ForkGapId = typeof ForkGapId.Type;
export const ForkGapInstallId = safeId;
export type ForkGapInstallId = typeof ForkGapInstallId.Type;

export const ForkGapName = singleLine(80);
/** Short enough for one board entry to hold every step of a gap and its install. */
export const ForkGapNote = singleLine(60);
/**
 * One command: nothing that chains, pipes, substitutes or redirects, so one yes approves one
 * install and the way back is a command too.
 */
export const ForkGapCommand = singleLine(120).check(
  Schema.makeFilter((value: string) => !/[;&|`<>]|\$\(/.test(value), {
    expected: "a single command without ; & | ` < > or $(",
  }),
);

/** In order: use what exists, install, build it in a child thread, propose a new bot. */
export const ForkGapRung = Schema.Literals(["reuse", "install", "build", "hire"]);
export type ForkGapRung = typeof ForkGapRung.Type;

export const ForkGapResult = Schema.Literals(["trying", "worked", "failed"]);
export type ForkGapResult = typeof ForkGapResult.Type;

/** What the bot asks to install. The server stores and shows it; it never runs it. */
export const ForkGapInstallDraft = Schema.Struct({
  /** `system`: outside the project (global packages, binaries, sudo). */
  scope: Schema.Literals(["project", "system"]),
  command: ForkGapCommand,
  /** Required: without a clear way back the request is refused. */
  rollback: ForkGapCommand,
});
export type ForkGapInstallDraft = typeof ForkGapInstallDraft.Type;

export const ForkGapInstall = Schema.Struct({
  ...ForkGapInstallDraft.fields,
  id: ForkGapInstallId,
  /** The asking thread's mode then; a yes is delivered only while it is still that. */
  runtimeMode: RuntimeMode,
  /** Answered once. `cancelled`: the gap closed, or the bot or its thread changed since it asked. */
  answer: Schema.Literals(["pending", "approved", "rejected", "cancelled"]),
  decidedAt: Schema.NullOr(IsoDateTime),
});
export type ForkGapInstall = typeof ForkGapInstall.Type;

export const ForkGapStep = Schema.Struct({
  rung: ForkGapRung,
  result: ForkGapResult,
  note: ForkGapNote,
  install: Schema.optionalKey(ForkGapInstall),
  at: IsoDateTime,
});
export type ForkGapStep = typeof ForkGapStep.Type;

export const ForkGap = Schema.Struct({
  id: ForkGapId,
  botId: ForkBotId,
  projectId: ProjectId,
  /** The bot's thread that opened it; an install approval only ever goes back there. */
  threadId: ThreadId,
  name: ForkGapName,
  /** `exhausted`: it hit the attempt or token limit. */
  status: Schema.Literals(["open", "solved", "exhausted"]),
  /** Oldest first. */
  steps: Schema.Array(ForkGapStep).check(Schema.isMaxLength(FORK_GAP_MAX_ATTEMPTS)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ForkGap = typeof ForkGap.Type;

export const ForkGapStepInput = Schema.Struct({
  gap: ForkGapName,
  rung: ForkGapRung,
  result: ForkGapResult,
  note: ForkGapNote,
  install: Schema.optionalKey(ForkGapInstallDraft),
});
export type ForkGapStepInput = typeof ForkGapStepInput.Type;

export const ForkGapListInput = Schema.Struct({});
export type ForkGapListInput = typeof ForkGapListInput.Type;

export const ForkGapListResult = Schema.Struct({
  /** Least recently changed first. */
  gaps: Schema.Array(ForkGap),
});
export type ForkGapListResult = typeof ForkGapListResult.Type;

export const ForkGapAnswerInstallInput = Schema.Struct({
  id: ForkGapInstallId,
  answer: Schema.Literals(["approve", "reject"]),
});
export type ForkGapAnswerInstallInput = typeof ForkGapAnswerInstallInput.Type;
