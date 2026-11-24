import {
  DEFAULT_FORK_FAILOVER_CONFIG,
  FORK_FAILOVER_MAX_CONFIG_BYTES,
  FORK_FAILOVER_MAX_EVENTS,
  FORK_FAILOVER_MAX_FILE_BYTES,
  FORK_FAILOVER_PROTOCOL_VERSION,
  ForkFailoverConfig,
  ForkFailoverError,
  ForkFailoverEvent,
  type ForkFailoverState,
  IsoDateTime,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const StoredFailoverState = Schema.Struct({
  version: Schema.Literal(FORK_FAILOVER_PROTOCOL_VERSION),
  updatedAt: Schema.NullOr(IsoDateTime),
  config: ForkFailoverConfig,
  recentEvents: Schema.Array(ForkFailoverEvent).check(Schema.isMaxLength(FORK_FAILOVER_MAX_EVENTS)),
});
export type StoredFailoverState = typeof StoredFailoverState.Type;

export const EMPTY_FAILOVER_STATE: StoredFailoverState = {
  version: FORK_FAILOVER_PROTOCOL_VERSION,
  updatedAt: null,
  config: DEFAULT_FORK_FAILOVER_CONFIG,
  recentEvents: [],
};

export const decodeStoredFailoverState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(StoredFailoverState),
);

const utf8ByteLength = (text: string): number => new TextEncoder().encode(text).byteLength;

export function validateFailoverConfigBytes(
  config: ForkFailoverConfig,
): { readonly ok: true } | { readonly ok: false; readonly error: ForkFailoverError } {
  const bytes = utf8ByteLength(JSON.stringify(config, null, 2));
  if (bytes > FORK_FAILOVER_MAX_CONFIG_BYTES) {
    return {
      ok: false,
      error: new ForkFailoverError({
        reason: "limitExceeded",
        message: `Failover configuration exceeds the ${FORK_FAILOVER_MAX_CONFIG_BYTES}-byte limit.`,
      }),
    };
  }
  return { ok: true };
}

export function toPublicFailoverState(state: StoredFailoverState): ForkFailoverState {
  return {
    config: state.config,
    recentEvents: state.recentEvents,
    updatedAt: state.updatedAt,
  };
}

export function withUpdatedConfig(
  state: StoredFailoverState,
  config: ForkFailoverConfig,
  nowIso: IsoDateTime,
): StoredFailoverState {
  return {
    version: FORK_FAILOVER_PROTOCOL_VERSION,
    updatedAt: nowIso,
    config,
    recentEvents: state.recentEvents,
  };
}

export function withAppendedEvent(
  state: StoredFailoverState,
  event: ForkFailoverEvent,
  nowIso: IsoDateTime,
): StoredFailoverState {
  const nextEvents = [event, ...state.recentEvents].slice(0, FORK_FAILOVER_MAX_EVENTS);
  return {
    version: FORK_FAILOVER_PROTOCOL_VERSION,
    updatedAt: nowIso,
    config: state.config,
    recentEvents: nextEvents,
  };
}

/**
 * Serializes the failover store within `FORK_FAILOVER_MAX_FILE_BYTES`, progressively pruning the
 * oldest `recentEvents` if needed so event growth can never block config updates or new events.
 */
export function serializeFailoverState(
  state: StoredFailoverState,
  maxBytes: number = FORK_FAILOVER_MAX_FILE_BYTES,
):
  | { readonly ok: true; readonly json: string; readonly state: StoredFailoverState }
  | { readonly ok: false; readonly error: ForkFailoverError } {
  let candidate: StoredFailoverState = state;
  let json = `${JSON.stringify(candidate, null, 2)}\n`;
  if (utf8ByteLength(json) <= maxBytes) {
    return { ok: true, json, state: candidate };
  }

  let low = 0;
  let high = state.recentEvents.length;
  let bestJson: string | null = null;
  let bestCount = -1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const trimmed: StoredFailoverState = {
      ...state,
      recentEvents: state.recentEvents.slice(0, mid),
    };
    const encoded = `${JSON.stringify(trimmed, null, 2)}\n`;
    if (utf8ByteLength(encoded) <= maxBytes) {
      bestJson = encoded;
      bestCount = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (bestJson === null || bestCount < 0) {
    return {
      ok: false,
      error: new ForkFailoverError({
        reason: "limitExceeded",
        message: `Failover store exceeds the ${maxBytes}-byte limit.`,
      }),
    };
  }

  candidate = {
    ...state,
    recentEvents: state.recentEvents.slice(0, bestCount),
  };
  json = bestJson;
  return { ok: true, json, state: candidate };
}
