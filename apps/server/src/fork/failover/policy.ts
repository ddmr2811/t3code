import type {
  ForkFailoverChain,
  ForkFailoverConfig,
  ForkFailoverEvent,
  ForkFailoverTarget,
  OrchestrationV2ProviderFailure,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

export type FailoverTrigger = "auto_usage_limit" | "manual";

export type FailoverSkipReason =
  | "disabled"
  | "not_usage_limit"
  | "loop_guard"
  | "no_chain"
  | "no_eligible_target"
  | "same_target"
  | "target_unavailable";

export type FailoverDecision =
  | {
      readonly decision: "switch";
      readonly target: ForkFailoverTarget;
      readonly chainId: string | null;
    }
  | {
      readonly decision: "skip";
      readonly skipReason: FailoverSkipReason;
      readonly detail: string;
    };

/**
 * Eligible provider instances mapped to their known selectable model slugs, or `null` when the
 * provider has not published a model catalog yet (`models.length === 0`).
 */
export type AvailableProviderCatalog = ReadonlyMap<ProviderInstanceId, ReadonlySet<string> | null>;

function targetKey(target: Pick<ForkFailoverTarget, "instanceId" | "model">): string {
  return `${target.instanceId}\u0000${target.model}`;
}

function sameFailoverTarget(
  left: Pick<ForkFailoverTarget, "instanceId" | "model">,
  right: Pick<ForkFailoverTarget, "instanceId" | "model">,
): boolean {
  return left.instanceId === right.instanceId && left.model === right.model;
}

function isTargetAvailable(
  target: Pick<ForkFailoverTarget, "instanceId" | "model">,
  availableProviders: AvailableProviderCatalog,
): boolean {
  if (!availableProviders.has(target.instanceId)) return false;
  const knownModels = availableProviders.get(target.instanceId);
  if (knownModels === null || knownModels === undefined) return true;
  return knownModels.has(target.model);
}

/**
 * Only quota/usage-limit failures (429 / rate limit / exhausted plan window) are eligible for
 * automatic failover. User cancellations, OOM kills, auth/permission errors, and normal failures
 * are never automatically rerouted.
 */
export function isUsageLimitFailure(
  failure: Pick<OrchestrationV2ProviderFailure, "class" | "code"> | null | undefined,
): boolean {
  if (failure === null || failure === undefined) return false;
  return failure.class === "usage_limit" && failure.code !== "oom_kill";
}

function chainSpecificity(
  chain: ForkFailoverChain,
  current: Pick<ForkFailoverTarget, "instanceId" | "model">,
): number {
  const hasInstance = chain.matchInstanceId !== undefined;
  const hasModel = chain.matchModel !== undefined;
  if (hasInstance && chain.matchInstanceId !== current.instanceId) return -1;
  if (hasModel && chain.matchModel !== current.model) return -1;
  if (hasInstance && hasModel) return 3;
  if (hasInstance) return 2;
  if (hasModel) return 1;
  return 0;
}

/** Picks the most specific chain matching `(instanceId, model)`, falling back to the default chain. */
export function selectMatchingChain(
  chains: ReadonlyArray<ForkFailoverChain>,
  current: Pick<ForkFailoverTarget, "instanceId" | "model">,
): ForkFailoverChain | null {
  let best: ForkFailoverChain | null = null;
  let bestScore = -1;
  for (const chain of chains) {
    const score = chainSpecificity(chain, current);
    if (score > bestScore) {
      best = chain;
      bestScore = score;
    }
  }
  return best;
}

function recentThreadWindowStats(
  recentEvents: ReadonlyArray<ForkFailoverEvent>,
  threadId: ThreadId,
  nowMs: number,
  cooldownSeconds: number,
): {
  readonly switchesInWindow: number;
  readonly cooledDownKeys: ReadonlySet<string>;
} {
  const windowMs = cooldownSeconds * 1000;
  const cutoffMs = nowMs - windowMs;
  let switchesInWindow = 0;
  const cooledDownKeys = new Set<string>();

  for (const event of recentEvents) {
    if (event.threadId !== threadId) continue;
    const occurredMs = Date.parse(event.occurredAt);
    if (!Number.isFinite(occurredMs) || occurredMs < cutoffMs || occurredMs > nowMs + 60_000) {
      continue;
    }
    if (event.status === "switched") {
      switchesInWindow += 1;
      cooledDownKeys.add(targetKey(event.fromSelection));
      if (event.toSelection !== null) {
        cooledDownKeys.add(targetKey(event.toSelection));
      }
    } else if (event.status === "failed") {
      cooledDownKeys.add(targetKey(event.fromSelection));
      if (event.toSelection !== null) {
        cooledDownKeys.add(targetKey(event.toSelection));
      }
    }
  }

  return { switchesInWindow, cooledDownKeys };
}

export function selectFailoverTarget(input: {
  readonly config: ForkFailoverConfig;
  readonly trigger: FailoverTrigger;
  readonly failure?: Pick<OrchestrationV2ProviderFailure, "class" | "code"> | null;
  readonly threadId: ThreadId;
  readonly currentSelection: ForkFailoverTarget;
  readonly availableProviders: AvailableProviderCatalog;
  readonly recentEvents: ReadonlyArray<ForkFailoverEvent>;
  readonly nowMs: number;
  readonly explicitTarget?: ForkFailoverTarget;
}): FailoverDecision {
  const {
    config,
    trigger,
    failure,
    threadId,
    currentSelection,
    availableProviders,
    recentEvents,
    nowMs,
    explicitTarget,
  } = input;

  if (trigger === "auto_usage_limit") {
    if (!config.enabled) {
      return {
        decision: "skip",
        skipReason: "disabled",
        detail: "Automatic quota failover is disabled.",
      };
    }
    if (!isUsageLimitFailure(failure)) {
      return {
        decision: "skip",
        skipReason: "not_usage_limit",
        detail: "Failure is not eligible for quota failover.",
      };
    }
  }

  const { switchesInWindow, cooledDownKeys } = recentThreadWindowStats(
    recentEvents,
    threadId,
    nowMs,
    config.cooldownSeconds,
  );

  if (trigger === "auto_usage_limit" && switchesInWindow >= config.maxSwitchesPerWindow) {
    return {
      decision: "skip",
      skipReason: "loop_guard",
      detail: `Anti-loop limit reached (${switchesInWindow}/${config.maxSwitchesPerWindow} switches within ${config.cooldownSeconds}s).`,
    };
  }

  if (trigger === "manual" && explicitTarget !== undefined) {
    if (sameFailoverTarget(explicitTarget, currentSelection)) {
      return {
        decision: "skip",
        skipReason: "same_target",
        detail: "The thread is already using the requested model.",
      };
    }
    if (!isTargetAvailable(explicitTarget, availableProviders)) {
      return {
        decision: "skip",
        skipReason: "target_unavailable",
        detail: "The requested backup provider instance or model is unavailable.",
      };
    }
    return { decision: "switch", target: explicitTarget, chainId: null };
  }

  const chain = selectMatchingChain(config.chains, currentSelection);
  if (chain === null) {
    return {
      decision: "skip",
      skipReason: "no_chain",
      detail: "No backup chain matches this thread's current model.",
    };
  }

  const currentKey = targetKey(currentSelection);
  const candidates = chain.targets.filter(
    (target) => targetKey(target) !== currentKey && isTargetAvailable(target, availableProviders),
  );
  if (candidates.length === 0) {
    return {
      decision: "skip",
      skipReason: "no_eligible_target",
      detail: "No enabled backup model is available in the matching chain.",
    };
  }

  const fresh = candidates.find((target) => !cooledDownKeys.has(targetKey(target)));
  if (fresh !== undefined) {
    return { decision: "switch", target: fresh, chainId: chain.id };
  }

  if (trigger === "manual") {
    // A human operator explicitly asked to rotate to the next available backup model.
    const currentIndex = chain.targets.findIndex((target) => targetKey(target) === currentKey);
    const ordered =
      currentIndex >= 0
        ? [...chain.targets.slice(currentIndex + 1), ...chain.targets.slice(0, currentIndex)]
        : chain.targets;
    const manualFallback = ordered.find(
      (target) => targetKey(target) !== currentKey && isTargetAvailable(target, availableProviders),
    );
    if (manualFallback !== undefined) {
      return { decision: "switch", target: manualFallback, chainId: chain.id };
    }
  }

  return {
    decision: "skip",
    skipReason: "no_eligible_target",
    detail: `All backup models in "${chain.name}" were already tried within the ${config.cooldownSeconds}s cooldown window.`,
  };
}

export function buildFailoverResumePrompt(
  from: Pick<ForkFailoverTarget, "instanceId" | "model">,
  to: Pick<ForkFailoverTarget, "instanceId" | "model">,
): string {
  if (from.instanceId === to.instanceId) {
    return `Previous model (${from.model}) reached its usage limit. Continue the interrupted task seamlessly from where it stopped.`;
  }
  return `Previous model (${from.instanceId}/${from.model}) reached its usage limit and this thread failed over to ${to.instanceId}/${to.model}. Review the handoff context and continue the interrupted task from where it stopped.`;
}
