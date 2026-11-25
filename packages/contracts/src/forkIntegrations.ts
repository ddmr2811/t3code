import * as Schema from "effect/Schema";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Fork: outside apps a bot may act on through the server, which alone holds their credentials. */
export const FORK_INTEGRATIONS_PROTOCOL_VERSION = 1;
export const FORK_INTEGRATIONS_MAX_FILE_BYTES = 4 * 1024 * 1024;
/** Requests kept on disk; pending ones are never trimmed. */
export const FORK_INTEGRATIONS_REQUEST_HISTORY = 100;
export const FORK_INTEGRATIONS_PENDING_PER_BOT = 5;
/** UTF-8 length of an action's arguments as JSON; a card must be able to show them whole. */
const FORK_INTEGRATIONS_ARGUMENTS_MAX_LENGTH = 32_000;
export const FORK_INTEGRATIONS_DETAIL_MAX_LENGTH = 2000;
/** How long a «No» refuses the same bot the same action with the same arguments. */
export const FORK_INTEGRATIONS_DENIAL_MS = 24 * 60 * 60 * 1000;

export const ForkIntegrationApp = Schema.Literals(["github"]);
export type ForkIntegrationApp = typeof ForkIntegrationApp.Type;

/** `ask` sends the action to the user's inbox; a group with no level is `deny`. */
export const ForkIntegrationLevel = Schema.Literals(["allow", "ask", "deny"]);
export type ForkIntegrationLevel = typeof ForkIntegrationLevel.Type;

/** Every app's action groups, in the order a bot's card lists them. */
export const FORK_INTEGRATION_GROUPS = {
  github: ["read", "comment", "branch-pr", "merge-delete"],
} as const satisfies Record<ForkIntegrationApp, ReadonlyArray<string>>;

const level = Schema.optionalKey(ForkIntegrationLevel);

/** What one bot may do in each app. A new app is one more optional key. */
export const ForkBotIntegrations = Schema.Struct({
  github: Schema.optionalKey(
    Schema.Struct({ read: level, comment: level, "branch-pr": level, "merge-delete": level }),
  ),
});
export type ForkBotIntegrations = typeof ForkBotIntegrations.Type;

export function integrationLevel(
  integrations: ForkBotIntegrations,
  app: ForkIntegrationApp,
  group: string,
): ForkIntegrationLevel {
  const levels: Readonly<Record<string, ForkIntegrationLevel | undefined>> =
    integrations[app] ?? {};
  return levels[group] ?? "deny";
}

const LEVEL_RANK = { deny: 0, ask: 1, allow: 2 } as const;

/** The first `app:group` where `target` may do more than `ceiling`, if any. */
export function integrationAbove(
  target: ForkBotIntegrations,
  ceiling: ForkBotIntegrations,
): string | undefined {
  for (const app of ForkIntegrationApp.literals) {
    for (const group of FORK_INTEGRATION_GROUPS[app]) {
      if (
        LEVEL_RANK[integrationLevel(target, app, group)] >
        LEVEL_RANK[integrationLevel(ceiling, app, group)]
      ) {
        return `${app}:${group}`;
      }
    }
  }
  return undefined;
}

export const ForkIntegrationRequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type ForkIntegrationRequestId = typeof ForkIntegrationRequestId.Type;

/**
 * An action a bot asked for that waits for the user. `running` is an approved one the server is
 * executing; one left `running` by a restart becomes `failed`, never run again.
 */
export const ForkIntegrationRequest = Schema.Struct({
  id: ForkIntegrationRequestId,
  botId: Schema.String.check(Schema.isMaxLength(128)),
  app: ForkIntegrationApp,
  action: Schema.String.check(Schema.isMaxLength(100)),
  group: Schema.String.check(Schema.isMaxLength(40)),
  /** The exact arguments as JSON with sorted keys: what the card shows is what runs. */
  arguments: Schema.String.check(Schema.isMaxLength(FORK_INTEGRATIONS_ARGUMENTS_MAX_LENGTH)),
  status: Schema.Literals(["pending", "running", "done", "failed", "denied"]),
  /** The start of the result, or why it failed. */
  detail: Schema.String.check(Schema.isMaxLength(FORK_INTEGRATIONS_DETAIL_MAX_LENGTH)),
  createdAt: IsoDateTime,
  decidedAt: Schema.NullOr(IsoDateTime),
});
export type ForkIntegrationRequest = typeof ForkIntegrationRequest.Type;

export const ForkIntegrationStatus = Schema.Struct({
  app: ForkIntegrationApp,
  connected: Schema.Boolean,
  /** The account the stored credential belongs to. */
  account: Schema.NullOr(Schema.String),
});
export type ForkIntegrationStatus = typeof ForkIntegrationStatus.Type;

export const ForkIntegrationListInput = Schema.Struct({});
export type ForkIntegrationListInput = typeof ForkIntegrationListInput.Type;

export const ForkIntegrationListResult = Schema.Struct({
  apps: Schema.Array(ForkIntegrationStatus),
  /** Oldest first. */
  requests: Schema.Array(ForkIntegrationRequest),
});
export type ForkIntegrationListResult = typeof ForkIntegrationListResult.Type;

/** A null token disconnects the app. The token is never sent back. */
export const ForkIntegrationConnectInput = Schema.Struct({
  app: ForkIntegrationApp,
  token: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(1000))),
});
export type ForkIntegrationConnectInput = typeof ForkIntegrationConnectInput.Type;

export const ForkIntegrationAnswerInput = Schema.Struct({
  id: ForkIntegrationRequestId,
  answer: Schema.Literals(["approve", "deny"]),
});
export type ForkIntegrationAnswerInput = typeof ForkIntegrationAnswerInput.Type;

export class ForkIntegrationsError extends Schema.TaggedError<ForkIntegrationsError>()(
  "ForkIntegrationsError",
  {
    reason: Schema.Literals([
      "invalidInput",
      "permissionDenied",
      "limitExceeded",
      "notFound",
      "notConnected",
      "unavailable",
      "storageFailed",
    ]),
    message: Schema.String,
  },
) {}
