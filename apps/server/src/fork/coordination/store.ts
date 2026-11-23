import {
  FORK_COORDINATION_MAX_ENTRIES,
  FORK_COORDINATION_MAX_FILE_BYTES,
  FORK_COORDINATION_PROTOCOL_VERSION,
  ForkCoordinationEntry,
  ForkCoordinationError,
  type ForkCoordinationListResult,
  type ForkCoordinationUpsertInput,
  IsoDateTime,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const StoredCoordinationBoard = Schema.Struct({
  version: Schema.Literal(FORK_COORDINATION_PROTOCOL_VERSION),
  updatedAt: Schema.NullOr(IsoDateTime),
  entries: Schema.Array(ForkCoordinationEntry),
});
export type StoredCoordinationBoard = typeof StoredCoordinationBoard.Type;

export const EMPTY_COORDINATION_BOARD: StoredCoordinationBoard = {
  version: FORK_COORDINATION_PROTOCOL_VERSION,
  updatedAt: null,
  entries: [],
};

export const decodeStoredCoordinationBoard = Schema.decodeUnknownEffect(
  Schema.fromJsonString(StoredCoordinationBoard),
);

const utf8ByteLength = (text: string): number => new TextEncoder().encode(text).byteLength;

function sortCoordinationEntries(
  entries: ReadonlyArray<ForkCoordinationEntry>,
): ReadonlyArray<ForkCoordinationEntry> {
  return entries.toSorted(
    (left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
  );
}

export function listBoardEntries(
  board: StoredCoordinationBoard,
  projectKey?: string,
): ForkCoordinationListResult {
  const filtered =
    projectKey === undefined
      ? board.entries
      : board.entries.filter((entry) => entry.projectKey === projectKey);
  return {
    entries: sortCoordinationEntries(filtered),
    updatedAt: board.updatedAt,
  };
}

export function upsertBoardEntry(
  board: StoredCoordinationBoard,
  input: ForkCoordinationUpsertInput,
  resolvedId: ForkCoordinationEntry["id"],
  nowIso: IsoDateTime,
):
  | {
      readonly ok: true;
      readonly board: StoredCoordinationBoard;
      readonly entry: ForkCoordinationEntry;
    }
  | { readonly ok: false; readonly error: ForkCoordinationError } {
  const existingIndex = board.entries.findIndex((entry) => entry.id === resolvedId);
  if (existingIndex === -1 && board.entries.length >= FORK_COORDINATION_MAX_ENTRIES) {
    return {
      ok: false,
      error: new ForkCoordinationError({
        reason: "limitExceeded",
        message: `Coordination board cannot hold more than ${FORK_COORDINATION_MAX_ENTRIES} entries.`,
      }),
    };
  }
  const entry: ForkCoordinationEntry = {
    id: resolvedId,
    projectKey: input.projectKey,
    projectName: input.projectName,
    ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
    agentName: input.agentName,
    status: input.status,
    workingOn: input.workingOn,
    completedSummary: input.completedSummary,
    waitingFor: input.waitingFor,
    ...(input.modelLabel === undefined ? {} : { modelLabel: input.modelLabel }),
    updatedAt: nowIso,
  };
  const nextEntries =
    existingIndex === -1
      ? [...board.entries, entry]
      : board.entries.map((item, index) => (index === existingIndex ? entry : item));
  return {
    ok: true,
    board: {
      version: FORK_COORDINATION_PROTOCOL_VERSION,
      updatedAt: nowIso,
      entries: sortCoordinationEntries(nextEntries),
    },
    entry,
  };
}

export function removeBoardEntry(
  board: StoredCoordinationBoard,
  id: ForkCoordinationEntry["id"],
  nowIso: IsoDateTime,
): { readonly board: StoredCoordinationBoard; readonly removed: boolean } {
  const nextEntries = board.entries.filter((entry) => entry.id !== id);
  if (nextEntries.length === board.entries.length) {
    return { board, removed: false };
  }
  return {
    board: {
      version: FORK_COORDINATION_PROTOCOL_VERSION,
      updatedAt: nowIso,
      entries: nextEntries,
    },
    removed: true,
  };
}

export function serializeBoard(
  board: StoredCoordinationBoard,
):
  | { readonly ok: true; readonly json: string }
  | { readonly ok: false; readonly error: ForkCoordinationError } {
  const json = `${JSON.stringify(board, null, 2)}\n`;
  if (utf8ByteLength(json) > FORK_COORDINATION_MAX_FILE_BYTES) {
    return {
      ok: false,
      error: new ForkCoordinationError({
        reason: "limitExceeded",
        message: `Coordination board exceeds the ${FORK_COORDINATION_MAX_FILE_BYTES}-byte limit.`,
      }),
    };
  }
  return { ok: true, json };
}
