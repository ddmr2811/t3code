import {
  FORK_BOTS_HANDOFF_HISTORY,
  FORK_BOTS_MAX_COUNT,
  FORK_BOTS_PROTOCOL_VERSION,
  ForkBot,
  ForkBotHandoff,
  ForkBotProposal,
  type ForkBotListResult,
  IsoDateTime,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const uniqueBots = Schema.makeFilter(
  (bots: ReadonlyArray<ForkBot>) => {
    const ids = new Set<string>();
    const handles = new Set<string>();
    for (const bot of bots) {
      const handle = bot.handle.toLowerCase();
      if (ids.has(bot.id) || handles.has(handle)) return false;
      ids.add(bot.id);
      handles.add(handle);
    }
    return true;
  },
  { expected: "unique bot ids and handles" },
);

/** Refusals kept per project; an older one then rests on the memory note alone. */
export const FORK_BOTS_VETOES_PER_PROJECT = 20;
/** Pending proposals stop here, in UTF-8 bytes as saved, so bots added by hand keep room. */
export const FORK_BOTS_PROPOSALS_MAX_BYTES = 512 * 1024;

/** Threads left behind that are still remembered, about 60 KB at most. */
export const FORMER_THREADS_KEPT = 1000;

/** A «No» to a proposed bot. Never sent to clients. */
const StoredVeto = Schema.Struct({
  projectId: ProjectId,
  handle: Schema.String,
  name: Schema.String,
});

export const StoredBotDirectory = Schema.Struct({
  version: Schema.Literal(FORK_BOTS_PROTOCOL_VERSION),
  updatedAt: Schema.NullOr(IsoDateTime),
  bots: Schema.Array(ForkBot).check(Schema.isMaxLength(FORK_BOTS_MAX_COUNT), uniqueBots),
  /** Oldest first; the id of each one is what stops a repeated handoff. */
  handoffs: Schema.Array(ForkBotHandoff)
    .check(Schema.isMaxLength(FORK_BOTS_HANDOFF_HISTORY))
    .pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Oldest first: every pending one and each project's last answered, for the weekly wait. */
  proposals: Schema.Array(ForkBotProposal).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  vetoes: Schema.Array(StoredVeto).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Threads a bot has left, oldest first: a workflow reaches none of them by id. */
  formerThreads: Schema.Array(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type StoredBotDirectory = typeof StoredBotDirectory.Type;

export const EMPTY_BOT_DIRECTORY: StoredBotDirectory = {
  version: FORK_BOTS_PROTOCOL_VERSION,
  updatedAt: null,
  bots: [],
  handoffs: [],
  proposals: [],
  vetoes: [],
  formerThreads: [],
};

export const decodeStoredBotDirectory = Schema.decodeUnknownEffect(
  Schema.fromJsonString(StoredBotDirectory),
);

export function listBots(directory: StoredBotDirectory): ForkBotListResult {
  return {
    bots: directory.bots.toSorted(
      (left, right) => left.name.localeCompare(right.name, "es") || left.id.localeCompare(right.id),
    ),
    handoffs: directory.handoffs,
    proposals: directory.proposals,
    updatedAt: directory.updatedAt,
  };
}
