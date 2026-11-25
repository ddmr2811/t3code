import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import type { EnvironmentId, UsageProviderKind, UsageSummaryInput } from "@t3tools/contracts";
import type { EnvironmentUsage } from "@t3tools/shared/usageMerge";
import { collectLimitAccounts } from "@t3tools/shared/usageLimits";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/runtime.ts";
import { serverEnvironment, usageAccessAtom } from "../state.ts";
import { summaryIncomplete } from "./spend.logic.ts";

export const limitAccountsAtom = Atom.make((get) => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  return collectLimitAccounts(
    new Map(
      [...catalog.entries].map(([environmentId, entry]) => [
        environmentId,
        { entry, serverConfig: get(serverEnvironment.configValueAtom(environmentId)) },
      ]),
    ),
  );
}).pipe(Atom.withLabel("ade-limit-accounts"));

// Usage names Claude after the provider; its driver is `claudeAgent`. The rest share the name.
export const USAGE_PROVIDER_OF_DRIVER: Record<string, UsageProviderKind> = {
  claudeAgent: "claude",
  codex: "codex",
  grok: "grok",
  cursor: "cursor",
  opencode: "opencode",
  antigravity: "antigravity",
  pi: "pi",
  muse: "muse",
};

/**
 * Per machine, the providers it pays as a flat subscription (from the accounts whose limits it
 * reads), and per provider the fullest window of those accounts (0–1) for the breakdown.
 */
export const flatProvidersAtom = Atom.make((get) => {
  const byEnvironment = new Map<EnvironmentId, Set<UsageProviderKind>>();
  const peaks = new Map<UsageProviderKind, number>();
  for (const account of get(limitAccountsAtom)) {
    const provider = USAGE_PROVIDER_OF_DRIVER[String(account.driver)];
    if (provider === undefined) continue;
    for (const { environmentId } of account.environments) {
      const providers = byEnvironment.get(environmentId) ?? new Set();
      byEnvironment.set(environmentId, providers.add(provider));
    }
    const used = Math.max(0, ...account.limits.windows.map((window) => window.usedPercent)) / 100;
    peaks.set(provider, Math.max(peaks.get(provider) ?? 0, used));
  }
  return { byEnvironment, peaks };
}).pipe(Atom.withLabel("ade-flat-providers"));

export interface SpendUsage {
  readonly environments: ReadonlyArray<EnvironmentUsage>;
  /** Machines paired before F7, without `usage:read`: pairing again is the way out. */
  readonly needsPairing: ReadonlyArray<string>;
  /** Machines whose session check, usage read or transcripts failed; the total misses some. */
  readonly failed: ReadonlyArray<string>;
  /** Machines whose usage this ADE may read, to refresh them. */
  readonly readable: ReadonlyArray<EnvironmentId>;
  readonly pending: boolean;
}

/** One usage summary per machine, by day: the only spend data that crosses the WebSocket. */
export const spendUsageAtom = Atom.family((windowKey: string) =>
  Atom.make((get): SpendUsage => {
    const input = JSON.parse(windowKey) as UsageSummaryInput;
    const catalog = get(environmentCatalog.catalogValueAtom);
    const environments: EnvironmentUsage[] = [];
    const needsPairing: string[] = [];
    const failed: string[] = [];
    const readable: EnvironmentId[] = [];
    let pending = false;
    for (const environmentId of enabledEnvironmentIds(catalog)) {
      const label = catalog.entries.get(environmentId)?.target.label ?? environmentId;
      const access = get(usageAccessAtom(environmentId));
      if (access === false) needsPairing.push(label);
      if (access === "unknown") failed.push(label);
      if (access !== true) {
        pending ||= access === null;
        continue;
      }
      readable.push(environmentId);
      const result = get(serverEnvironment.usageSummary({ environmentId, input }));
      pending ||= result.waiting;
      if (result._tag === "Failure") failed.push(label);
      const summary = AsyncResult.getOrElse(result, () => null);
      if (summary === null) continue;
      // Its own sources can fail or be read in part: that total is short too.
      if (result._tag !== "Failure" && summaryIncomplete(summary)) failed.push(label);
      environments.push({ environmentId, label, summary });
    }
    return { environments, needsPairing, failed, readable, pending };
  }).pipe(Atom.withLabel(`ade-spend-usage:${windowKey}`)),
);
