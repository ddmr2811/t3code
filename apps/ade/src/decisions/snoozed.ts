import * as DateTime from "effect/DateTime";
import { Atom, type AtomRegistry } from "effect/reactivity";

import {
  pruneSnoozes,
  readSnoozes,
  snoozeUntilTomorrow,
  type Snoozes,
  writeSnoozes,
} from "./tray.logic.ts";

const nowMillis = () => DateTime.toEpochMillis(DateTime.nowUnsafe());

/** «Luego» in this browser: every place that counts decisions reads it. */
export const snoozesAtom = Atom.make<Snoozes>(readSnoozes(nowMillis())).pipe(Atom.keepAlive);

/** The time snoozes are judged against; moved by the panel's timer and when the tab shows again. */
export const snoozeClockAtom = Atom.make(nowMillis()).pipe(Atom.keepAlive);

export const tickSnoozeClock = (registry: AtomRegistry.AtomRegistry) =>
  registry.set(snoozeClockAtom, nowMillis());

function save(registry: AtomRegistry.AtomRegistry, next: Snoozes) {
  registry.set(snoozesAtom, next);
  tickSnoozeClock(registry);
  writeSnoozes(next);
}

/** Snoozes a decision with the requests it has now; a request it did not have brings it back. */
export function snoozeDecision(
  registry: AtomRegistry.AtomRegistry,
  key: string,
  requestIds: ReadonlyArray<string>,
  waitingKeys: ReadonlyArray<string>,
) {
  const kept = pruneSnoozes(registry.get(snoozesAtom), waitingKeys, nowMillis());
  save(registry, {
    ...kept,
    [key]: { until: snoozeUntilTomorrow(DateTime.nowUnsafe()), requestIds },
  });
}

export function bringBackDecision(registry: AtomRegistry.AtomRegistry, key: string) {
  const { [key]: _back, ...rest } = registry.get(snoozesAtom);
  save(registry, rest);
}
