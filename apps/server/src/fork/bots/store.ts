import {
  FORK_BOTS_HANDOFF_HISTORY,
  FORK_BOTS_MAX_COUNT,
  FORK_BOTS_PROTOCOL_VERSION,
  ForkBot,
  ForkBotHandoff,
  ForkBotProposal,
  type ForkBotListResult,
  IsoDateTime,
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

export const StoredBotDirectory = Schema.Struct({
  version: Schema.Literal(FORK_BOTS_PROTOCOL_VERSION),
  updatedAt: Schema.NullOr(IsoDateTime),
  bots: Schema.Array(ForkBot).check(Schema.isMaxLength(FORK_BOTS_MAX_COUNT), uniqueBots),
  /** Oldest first; the id of each one is what stops a repeated handoff. */
  handoffs: Schema.Array(ForkBotHandoff)
    .check(Schema.isMaxLength(FORK_BOTS_HANDOFF_HISTORY))
    .pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** Oldest first: every pending and refused one, and each project's latest accepted. */
  proposals: Schema.Array(ForkBotProposal).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type StoredBotDirectory = typeof StoredBotDirectory.Type;

export const EMPTY_BOT_DIRECTORY: StoredBotDirectory = {
  version: FORK_BOTS_PROTOCOL_VERSION,
  updatedAt: null,
  bots: [],
  handoffs: [],
  proposals: [],
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
