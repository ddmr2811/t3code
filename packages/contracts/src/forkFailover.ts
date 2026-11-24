import * as Schema from "effect/Schema";
import { IsoDateTime, ThreadId, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/** Fork: Quota model failover protocol version. */
export const FORK_FAILOVER_PROTOCOL_VERSION = 1;

export const FORK_FAILOVER_MAX_FILE_BYTES = 256 * 1024;
export const FORK_FAILOVER_MAX_CHAINS = 24;
export const FORK_FAILOVER_MAX_TARGETS_PER_CHAIN = 8;
export const FORK_FAILOVER_MAX_EVENTS = 100;
export const FORK_FAILOVER_MAX_OPTIONS = 16;

export const FORK_FAILOVER_MIN_COOLDOWN_SECONDS = 30;
export const FORK_FAILOVER_MAX_COOLDOWN_SECONDS = 86_400;
const FORK_FAILOVER_DEFAULT_COOLDOWN_SECONDS = 600;

export const FORK_FAILOVER_MIN_SWITCHES_PER_WINDOW = 1;
export const FORK_FAILOVER_MAX_SWITCHES_PER_WINDOW = 5;
const FORK_FAILOVER_DEFAULT_SWITCHES_PER_WINDOW = 2;

export const FORK_FAILOVER_ID_MAX_LENGTH = 128;
export const FORK_FAILOVER_NAME_MAX_LENGTH = 120;
export const FORK_FAILOVER_MODEL_MAX_LENGTH = 160;
export const FORK_FAILOVER_REASON_MAX_LENGTH = 160;
export const FORK_FAILOVER_DETAIL_MAX_LENGTH = 400;
export const FORK_FAILOVER_OPTION_KEY_MAX_LENGTH = 80;
export const FORK_FAILOVER_OPTION_VALUE_MAX_LENGTH = 160;

// Disallow ASCII control characters on single-line identifiers, model slugs, and labels.
const SINGLE_LINE_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const noSingleLineControl = Schema.makeFilter(
  (value: string) => !SINGLE_LINE_CONTROL_PATTERN.test(value),
  { expected: "a string without control characters" },
);

const isSafeFailoverId = Schema.makeFilter(
  (value: string) => SAFE_ID_PATTERN.test(value) && !value.includes(".."),
  { expected: "a safe failover identifier" },
);

export const ForkFailoverChainId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(FORK_FAILOVER_ID_MAX_LENGTH),
  isSafeFailoverId,
);
export type ForkFailoverChainId = typeof ForkFailoverChainId.Type;

export const ForkFailoverEventId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(FORK_FAILOVER_ID_MAX_LENGTH),
  isSafeFailoverId,
);
export type ForkFailoverEventId = typeof ForkFailoverEventId.Type;

export const ForkFailoverChainName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(FORK_FAILOVER_NAME_MAX_LENGTH),
  noSingleLineControl,
);
export type ForkFailoverChainName = typeof ForkFailoverChainName.Type;

export const ForkFailoverModel = TrimmedNonEmptyString.check(
  Schema.isMaxLength(FORK_FAILOVER_MODEL_MAX_LENGTH),
  noSingleLineControl,
);
export type ForkFailoverModel = typeof ForkFailoverModel.Type;

export const ForkFailoverThreadId = ThreadId.check(
  Schema.isMaxLength(FORK_FAILOVER_ID_MAX_LENGTH),
  noSingleLineControl,
);
export type ForkFailoverThreadId = typeof ForkFailoverThreadId.Type;

export const ForkFailoverReason = TrimmedNonEmptyString.check(
  Schema.isMaxLength(FORK_FAILOVER_REASON_MAX_LENGTH),
  noSingleLineControl,
);
export type ForkFailoverReason = typeof ForkFailoverReason.Type;

export const ForkFailoverDetail = TrimmedString.check(
  Schema.isMaxLength(FORK_FAILOVER_DETAIL_MAX_LENGTH),
  noSingleLineControl,
);
export type ForkFailoverDetail = typeof ForkFailoverDetail.Type;

const ForkFailoverOptionKey = TrimmedNonEmptyString.check(
  Schema.isMaxLength(FORK_FAILOVER_OPTION_KEY_MAX_LENGTH),
  noSingleLineControl,
);

const ForkFailoverOptionStringValue = TrimmedNonEmptyString.check(
  Schema.isMaxLength(FORK_FAILOVER_OPTION_VALUE_MAX_LENGTH),
  noSingleLineControl,
);

export const ForkFailoverOptionSelection = Schema.Struct({
  id: ForkFailoverOptionKey,
  value: Schema.Union([ForkFailoverOptionStringValue, Schema.Boolean]),
});
export type ForkFailoverOptionSelection = typeof ForkFailoverOptionSelection.Type;

const noDuplicateOptionIds = Schema.makeFilter(
  (options: ReadonlyArray<ForkFailoverOptionSelection>) => {
    const seen = new Set<string>();
    for (const option of options) {
      if (seen.has(option.id)) return false;
      seen.add(option.id);
    }
    return true;
  },
  { expected: "unique option identifiers" },
);

export const ForkFailoverTarget = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: ForkFailoverModel,
  options: Schema.optionalKey(
    Schema.Array(ForkFailoverOptionSelection).check(
      Schema.isMaxLength(FORK_FAILOVER_MAX_OPTIONS),
      noDuplicateOptionIds,
    ),
  ),
});
export type ForkFailoverTarget = typeof ForkFailoverTarget.Type;

const targetIdentityKey = (target: Pick<ForkFailoverTarget, "instanceId" | "model">): string =>
  `${target.instanceId}\u0000${target.model}`;

const noDuplicateTargets = Schema.makeFilter(
  (targets: ReadonlyArray<ForkFailoverTarget>) => {
    const seen = new Set<string>();
    for (const target of targets) {
      const key = targetIdentityKey(target);
      if (seen.has(key)) return false;
      seen.add(key);
    }
    return true;
  },
  { expected: "unique backup targets within a chain" },
);

export const ForkFailoverChain = Schema.Struct({
  id: ForkFailoverChainId,
  name: ForkFailoverChainName,
  matchInstanceId: Schema.optionalKey(ProviderInstanceId),
  matchModel: Schema.optionalKey(ForkFailoverModel),
  targets: Schema.Array(ForkFailoverTarget).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(FORK_FAILOVER_MAX_TARGETS_PER_CHAIN),
    noDuplicateTargets,
  ),
});
export type ForkFailoverChain = typeof ForkFailoverChain.Type;

const noDuplicateChainIds = Schema.makeFilter(
  (chains: ReadonlyArray<ForkFailoverChain>) => {
    const seen = new Set<string>();
    for (const chain of chains) {
      if (seen.has(chain.id)) return false;
      seen.add(chain.id);
    }
    return true;
  },
  { expected: "unique failover chain identifiers" },
);

export const ForkFailoverConfig = Schema.Struct({
  version: Schema.Literal(FORK_FAILOVER_PROTOCOL_VERSION),
  enabled: Schema.Boolean,
  cooldownSeconds: Schema.Int.check(
    Schema.isBetween({
      minimum: FORK_FAILOVER_MIN_COOLDOWN_SECONDS,
      maximum: FORK_FAILOVER_MAX_COOLDOWN_SECONDS,
    }),
  ),
  maxSwitchesPerWindow: Schema.Int.check(
    Schema.isBetween({
      minimum: FORK_FAILOVER_MIN_SWITCHES_PER_WINDOW,
      maximum: FORK_FAILOVER_MAX_SWITCHES_PER_WINDOW,
    }),
  ),
  chains: Schema.Array(ForkFailoverChain).check(
    Schema.isMaxLength(FORK_FAILOVER_MAX_CHAINS),
    noDuplicateChainIds,
  ),
});
export type ForkFailoverConfig = typeof ForkFailoverConfig.Type;

export const DEFAULT_FORK_FAILOVER_CONFIG: ForkFailoverConfig = {
  version: FORK_FAILOVER_PROTOCOL_VERSION,
  enabled: false,
  cooldownSeconds: FORK_FAILOVER_DEFAULT_COOLDOWN_SECONDS,
  maxSwitchesPerWindow: FORK_FAILOVER_DEFAULT_SWITCHES_PER_WINDOW,
  chains: [],
};

export const ForkFailoverEventStatus = Schema.Literals(["switched", "skipped", "failed"]);
export type ForkFailoverEventStatus = typeof ForkFailoverEventStatus.Type;

export const ForkFailoverEvent = Schema.Struct({
  id: ForkFailoverEventId,
  threadId: ForkFailoverThreadId,
  fromSelection: ForkFailoverTarget,
  toSelection: Schema.NullOr(ForkFailoverTarget),
  reason: ForkFailoverReason,
  resetAt: Schema.NullOr(IsoDateTime),
  status: ForkFailoverEventStatus,
  detail: ForkFailoverDetail,
  occurredAt: IsoDateTime,
});
export type ForkFailoverEvent = typeof ForkFailoverEvent.Type;

export const ForkFailoverGetStateInput = Schema.Struct({});
export type ForkFailoverGetStateInput = typeof ForkFailoverGetStateInput.Type;

export const ForkFailoverState = Schema.Struct({
  config: ForkFailoverConfig,
  recentEvents: Schema.Array(ForkFailoverEvent).check(Schema.isMaxLength(FORK_FAILOVER_MAX_EVENTS)),
  updatedAt: Schema.NullOr(IsoDateTime),
});
export type ForkFailoverState = typeof ForkFailoverState.Type;

export const ForkFailoverSetConfigInput = Schema.Struct({
  config: ForkFailoverConfig,
});
export type ForkFailoverSetConfigInput = typeof ForkFailoverSetConfigInput.Type;

export const ForkFailoverSwitchThreadInput = Schema.Struct({
  threadId: ForkFailoverThreadId,
  target: Schema.optionalKey(ForkFailoverTarget),
  resume: Schema.optionalKey(Schema.Boolean),
});
export type ForkFailoverSwitchThreadInput = typeof ForkFailoverSwitchThreadInput.Type;

export const ForkFailoverSwitchThreadResult = Schema.Struct({
  event: ForkFailoverEvent,
  selection: ForkFailoverTarget,
  resumed: Schema.Boolean,
});
export type ForkFailoverSwitchThreadResult = typeof ForkFailoverSwitchThreadResult.Type;

export const ForkFailoverErrorReason = Schema.Literals([
  "invalidInput",
  "limitExceeded",
  "notFound",
  "threadBusy",
  "noCandidate",
  "switchFailed",
  "storageFailed",
]);
export type ForkFailoverErrorReason = typeof ForkFailoverErrorReason.Type;

export class ForkFailoverError extends Schema.TaggedError<ForkFailoverError>()(
  "ForkFailoverError",
  {
    reason: ForkFailoverErrorReason,
    message: Schema.String,
  },
) {}
