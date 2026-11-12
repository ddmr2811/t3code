import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Fork: Extensions settings protocol version, announced in ExecutionEnvironmentCapabilities. */
export const FORK_EXTENSIONS_PROTOCOL_VERSION = 1;

export const ForkExtensionAgent = Schema.Literals(["claude", "codex"]);
export type ForkExtensionAgent = typeof ForkExtensionAgent.Type;

export const ForkExtensionKind = Schema.Literals(["mcp", "plugin", "skill"]);
export type ForkExtensionKind = typeof ForkExtensionKind.Type;

export const ForkMcpTransport = Schema.Literals(["stdio", "http", "sse", "claudeAi", "plugin"]);
export type ForkMcpTransport = typeof ForkMcpTransport.Type;

export const ForkExtensionScope = Schema.Literals([
  "user",
  "project",
  "local",
  "plugin",
  "claudeAi",
]);
export type ForkExtensionScope = typeof ForkExtensionScope.Type;

/** `unknown` = installed but no health check has run yet. */
export const ForkCellState = Schema.Literals([
  "working",
  "needsAttention",
  "disabled",
  "notInstalled",
  "notApplicable",
  "unknown",
]);
export type ForkCellState = typeof ForkCellState.Type;

export const ForkProblemReason = Schema.Literals([
  "binaryNotFound",
  "needsAuthorization",
  "machineOffline",
  "permissionDenied",
  "configChanged",
  "alreadyExists",
  "notFound",
  "commandFailed",
  "timeout",
  "unsupported",
  "invalidInput",
]);
export type ForkProblemReason = typeof ForkProblemReason.Type;

export const ForkExtensionProblem = Schema.Struct({
  reason: ForkProblemReason,
  summary: Schema.String,
  nextStep: Schema.String,
  rawOutput: Schema.NullOr(Schema.String),
});
export type ForkExtensionProblem = typeof ForkExtensionProblem.Type;

export const ForkProjectToggle = Schema.Struct({
  path: TrimmedNonEmptyString,
  title: Schema.String,
  disabled: Schema.Boolean,
});
export type ForkProjectToggle = typeof ForkProjectToggle.Type;

export const ForkExtensionCell = Schema.Struct({
  agent: ForkExtensionAgent,
  state: ForkCellState,
  scopes: Schema.Array(ForkExtensionScope),
  projects: Schema.Array(ForkProjectToggle),
  problem: Schema.NullOr(ForkExtensionProblem),
  usageCount: NonNegativeInt,
  lastUsedAt: Schema.NullOr(IsoDateTime),
  stashDiscarded: Schema.Boolean,
});
export type ForkExtensionCell = typeof ForkExtensionCell.Type;

export const ForkExtensionItem = Schema.Struct({
  /** "<kind>:<name>" */
  id: Schema.String,
  kind: ForkExtensionKind,
  name: Schema.String,
  source: Schema.String,
  transport: Schema.NullOr(ForkMcpTransport),
  pluginId: Schema.NullOr(Schema.String),
  readOnly: Schema.Boolean,
  cells: Schema.Array(ForkExtensionCell),
});
export type ForkExtensionItem = typeof ForkExtensionItem.Type;

export const ForkExtensionsSnapshot = Schema.Struct({
  protocolVersion: Schema.Literal(FORK_EXTENSIONS_PROTOCOL_VERSION),
  agents: Schema.Array(
    Schema.Struct({
      agent: ForkExtensionAgent,
      available: Schema.Boolean,
      /** Why an unavailable agent could not be read (missing binary, failing CLI…). */
      problem: Schema.optional(ForkExtensionProblem),
    }),
  ),
  projects: Schema.Array(Schema.Struct({ path: TrimmedNonEmptyString, title: Schema.String })),
  items: Schema.Array(ForkExtensionItem),
  healthCheckedAt: Schema.NullOr(IsoDateTime),
});
export type ForkExtensionsSnapshot = typeof ForkExtensionsSnapshot.Type;

export const ForkHealthEvent = Schema.Union([
  Schema.TaggedStruct("cell", {
    itemId: Schema.String,
    agent: ForkExtensionAgent,
    state: ForkCellState,
    problem: Schema.NullOr(ForkExtensionProblem),
  }),
  Schema.TaggedStruct("done", { checkedAt: IsoDateTime }),
]);
export type ForkHealthEvent = typeof ForkHealthEvent.Type;

export const ForkInstallRequest = Schema.Union([
  Schema.TaggedStruct("mcp", {
    name: Schema.String,
    agents: Schema.NonEmptyArray(ForkExtensionAgent),
    transport: Schema.Literals(["stdio", "http", "sse"]),
    command: Schema.NullOr(Schema.String),
    args: Schema.Array(Schema.String),
    url: Schema.NullOr(Schema.String),
    scope: Schema.Literals(["user", "project", "local"]),
    projectPath: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct("plugin", {
    /** name@marketplace */
    pluginRef: Schema.String,
    marketplaceSource: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct("skill", {
    name: Schema.String,
    agents: Schema.NonEmptyArray(ForkExtensionAgent),
    source: Schema.String,
  }),
]);
export type ForkInstallRequest = typeof ForkInstallRequest.Type;

export const ForkInstallResult = Schema.Struct({
  agent: ForkExtensionAgent,
  ok: Schema.Boolean,
  problem: Schema.NullOr(ForkExtensionProblem),
});
export type ForkInstallResult = typeof ForkInstallResult.Type;

export const ForkSetEnabledInput = Schema.Struct({
  itemId: Schema.String,
  agent: ForkExtensionAgent,
  enabled: Schema.Boolean,
  /** null = global */
  projectPath: Schema.NullOr(Schema.String),
});
export type ForkSetEnabledInput = typeof ForkSetEnabledInput.Type;

export const ForkUninstallInput = Schema.Struct({
  itemId: Schema.String,
  agents: Schema.NonEmptyArray(ForkExtensionAgent),
});
export type ForkUninstallInput = typeof ForkUninstallInput.Type;

export const ForkPastedSource = Schema.Union([
  Schema.TaggedStruct("mcpRemote", {
    url: Schema.String,
    transport: Schema.Literals(["http", "sse"]),
    suggestedName: Schema.String,
  }),
  Schema.TaggedStruct("mcpCommand", {
    command: Schema.String,
    args: Schema.Array(Schema.String),
    suggestedName: Schema.String,
  }),
  Schema.TaggedStruct("plugin", { pluginRef: Schema.String }),
  Schema.TaggedStruct("marketplace", {
    source: Schema.String,
    plugins: Schema.Array(Schema.String),
  }),
  Schema.TaggedStruct("skill", { source: Schema.String, suggestedName: Schema.String }),
  Schema.TaggedStruct("claudeAiConnector", {}),
  Schema.TaggedStruct("unknown", {}),
]);
export type ForkPastedSource = typeof ForkPastedSource.Type;

export const ForkAuthorizeEvent = Schema.Union([
  Schema.TaggedStruct("authUrl", { sessionId: Schema.String, url: Schema.String }),
  Schema.TaggedStruct("done", {}),
  Schema.TaggedStruct("failed", { problem: ForkExtensionProblem }),
]);
export type ForkAuthorizeEvent = typeof ForkAuthorizeEvent.Type;

export const ForkAuthorizeCompleteInput = Schema.Struct({
  sessionId: Schema.String,
  redirectUrl: Schema.String,
});
export type ForkAuthorizeCompleteInput = typeof ForkAuthorizeCompleteInput.Type;

export class ForkExtensionsError extends Schema.TaggedError<ForkExtensionsError>()(
  "ForkExtensionsError",
  { problem: ForkExtensionProblem },
) {
  override get message(): string {
    return this.problem.summary;
  }
}
