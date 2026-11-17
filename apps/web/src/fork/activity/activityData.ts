// Fork-only: the activity feeds of every connected fork server this client may read diagnostics
// from, asked only while the card or the page is on screen and again every 30 s while visible.
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import {
  AuthDiagnosticsReadScope,
  type EnvironmentId,
  type ForkActivityFeed,
  type ForkActivityFeedInput,
  WS_METHODS,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useContext } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { environmentPresentations } from "../../state/presentation";
import { useEnvironmentsWithScope } from "../../state/session";
import { useVisibleInterval } from "../dashboard/visibleInterval";
import type { MachineFeed } from "./activity.logic";

/** Servers cache their feed this long, so asking sooner reads the same one. */
const ACTIVITY_REFRESH_MS = 30_000;
const KEEP_MS = 2 * 60_000;

const feedQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:fork-activity:feed",
  tag: WS_METHODS.forkActivityFeed,
  idleTtlMs: KEEP_MS,
  staleTimeMs: 15_000,
});

const feedOf = (environmentId: EnvironmentId, input: ForkActivityFeedInput) =>
  feedQuery({ environmentId, input });

export interface ActivityMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

interface FeedKey {
  readonly machines: ReadonlyArray<ActivityMachine>;
  readonly input: ForkActivityFeedInput;
}

export interface ActivityFeeds {
  readonly feeds: ReadonlyArray<MachineFeed>;
  /** Machines asked that have not answered yet. */
  readonly pending: number;
  /** Machines whose last read failed. */
  readonly failed: number;
}

const feedsAtom = Atom.family((key: string) =>
  Atom.make((get): ActivityFeeds => {
    const { machines, input } = JSON.parse(key) as FeedKey;
    let pending = 0;
    let failed = 0;
    const feeds = machines.flatMap(({ environmentId, label }) => {
      const result = get(feedOf(environmentId, input));
      const value = AsyncResult.getOrElse(result, (): ForkActivityFeed | null => null);
      if (value === null && result.waiting) pending += 1;
      else if (value === null && AsyncResult.isFailure(result)) failed += 1;
      return value === null ? [] : [{ environmentId, machine: label, entries: value.entries }];
    });
    return { feeds, pending, failed };
  }).pipe(Atom.withLabel(`fork-activity:feeds:${key}`)),
);

/** Connected fork servers that keep an activity feed and let this client read it. */
function useActivityMachines(): ReadonlyArray<ActivityMachine> {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const candidates = [...presentations]
    .filter(
      ([, presentation]) =>
        presentation.entry.enabled &&
        presentation.connection.phase === "connected" &&
        (presentation.serverConfig?.environment.capabilities.forkActivity ?? 0) >= 1,
    )
    .map(([environmentId, presentation]) => ({
      environmentId,
      label: presentation.entry.target.label,
    }));
  const readable = useEnvironmentsWithScope(candidates, AuthDiagnosticsReadScope);
  return candidates
    .filter(({ environmentId }) => readable.has(environmentId))
    .toSorted((a, b) => a.environmentId.localeCompare(b.environmentId));
}

export function useActivityFeeds(input: ForkActivityFeedInput): ActivityFeeds & {
  readonly machines: ReadonlyArray<ActivityMachine>;
} {
  const registry = useContext(RegistryContext);
  const machines = useActivityMachines();
  const key: FeedKey = { machines, input };
  const feeds = useAtomValue(feedsAtom(JSON.stringify(key)));
  useVisibleInterval(() => {
    for (const { environmentId } of machines) registry.refresh(feedOf(environmentId, input));
  }, ACTIVITY_REFRESH_MS);
  return { ...feeds, machines };
}
