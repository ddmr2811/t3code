import {
  FORK_BOTS_MAX_COUNT,
  FORK_BOTS_PROTOCOL_VERSION,
  ForkBot,
  type ForkBotListResult,
  IsoDateTime,
} from "@t3tools/contracts";
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
});
export type StoredBotDirectory = typeof StoredBotDirectory.Type;

export const EMPTY_BOT_DIRECTORY: StoredBotDirectory = {
  version: FORK_BOTS_PROTOCOL_VERSION,
  updatedAt: null,
  bots: [],
};

export const decodeStoredBotDirectory = Schema.decodeUnknownEffect(
  Schema.fromJsonString(StoredBotDirectory),
);

export function listBots(directory: StoredBotDirectory): ForkBotListResult {
  return {
    bots: directory.bots.toSorted(
      (left, right) => left.name.localeCompare(right.name, "es") || left.id.localeCompare(right.id),
    ),
    updatedAt: directory.updatedAt,
  };
}
