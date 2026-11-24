import {
  DEFAULT_FORK_FAILOVER_CONFIG,
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

export function serializeFailoverState(
  state: StoredFailoverState,
):
  | { readonly ok: true; readonly json: string }
  | { readonly ok: false; readonly error: ForkFailoverError } {
  const json = `${JSON.stringify(state, null, 2)}\n`;
  if (utf8ByteLength(json) > FORK_FAILOVER_MAX_FILE_BYTES) {
    return {
      ok: false,
      error: new ForkFailoverError({
        reason: "limitExceeded",
        message: `Failover store exceeds the ${FORK_FAILOVER_MAX_FILE_BYTES}-byte limit.`,
      }),
    };
  }
  return { ok: true, json };
}
