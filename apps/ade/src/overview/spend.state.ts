import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import type { UsageProviderKind, UsageSummaryInput } from "@t3tools/contracts";
import type { EnvironmentUsage } from "@t3tools/shared/usageMerge";
import { collectLimitAccounts } from "@t3tools/shared/usageLimits";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/runtime.ts";
import { diagnosticsAccessAtom, serverEnvironment } from "../state.ts";

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
const USAGE_PROVIDER_OF_DRIVER: Record<string, UsageProviderKind> = {
  claudeAgent: "claude",
  codex: "codex",
  grok: "grok",
  cursor: "cursor",
  opencode: "opencode",
  antigravity: "antigravity",
  pi: "pi",
  muse: "muse",
};

/** Providers paid as a flat subscription, with the fullest window of their accounts (0–1). */
export const flatProvidersAtom = Atom.make((get) => {
  const peaks = new Map<UsageProviderKind, number>();
  for (const account of get(limitAccountsAtom)) {
    const provider = USAGE_PROVIDER_OF_DRIVER[String(account.driver)];
    if (provider === undefined) continue;
    const used = Math.max(0, ...account.limits.windows.map((window) => window.usedPercent)) / 100;
    peaks.set(provider, Math.max(peaks.get(provider) ?? 0, used));
  }
  return peaks;
}).pipe(Atom.withLabel("ade-flat-providers"));

export interface SpendUsage {
  readonly environments: ReadonlyArray<EnvironmentUsage>;
  /** Machines paired before F7, without `diagnostics:read`: pairing again is the way out. */
  readonly needsPairing: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<string>;
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
    let pending = false;
    for (const environmentId of enabledEnvironmentIds(catalog)) {
      const label = catalog.entries.get(environmentId)?.target.label ?? environmentId;
      const access = get(diagnosticsAccessAtom(environmentId));
      if (access === false) needsPairing.push(label);
      if (access !== true) {
        pending ||= access === null;
        continue;
      }
      const result = get(serverEnvironment.usageSummary({ environmentId, input }));
      pending ||= result.waiting;
      if (result._tag === "Failure") failed.push(label);
      const summary = AsyncResult.getOrElse(result, () => null);
      if (summary !== null) environments.push({ environmentId, label, summary });
    }
    return { environments, needsPairing, failed, pending };
  }).pipe(Atom.withLabel(`ade-spend-usage:${windowKey}`)),
);
