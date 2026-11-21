// Fork-only: the saved Dashboard arrangement laid over the machines that exist right now. Saved
// entries are found by any identity they share with a live machine, never by order or label, so
// a tailnet peer that becomes a T3 environment keeps its alias, icon, colour and section.
import {
  DEFAULT_FORK_DASHBOARD_ACTIVITY,
  DEFAULT_FORK_DASHBOARD_CHARTS,
  DEFAULT_FORK_DASHBOARD_LAYOUT,
  type ForkDashboardLayout,
  type ForkDashboardMachine,
  type ForkDashboardPanelId,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";

export type DashboardPanelId = "machines" | "subscriptions" | "charts" | "threads" | "activity";

const DASHBOARD_PANELS: ReadonlyArray<{
  readonly id: DashboardPanelId;
  readonly title: string;
}> = [
  { id: "machines", title: msg("Machines") },
  { id: "subscriptions", title: msg("Subscriptions") },
  { id: "charts", title: msg("Charts") },
  { id: "threads", title: msg("Active threads") },
  { id: "activity", title: msg("What the AI did") },
];

export interface ResolvedPanel {
  readonly id: DashboardPanelId;
  readonly title: string;
  readonly hidden: boolean;
}

const CHARTS = DASHBOARD_PANELS.find((panel) => panel.id === "charts")!;
const ACTIVITY = DASHBOARD_PANELS.find((panel) => panel.id === "activity")!;
const SAVED_PANELS = DASHBOARD_PANELS.filter(
  (panel): panel is { readonly id: ForkDashboardPanelId; readonly title: string } =>
    panel.id !== "charts" && panel.id !== "activity",
);

const insertAfter = (
  panels: ResolvedPanel[],
  after: DashboardPanelId | null,
  panel: ResolvedPanel,
) => {
  const found = after === null ? -1 : panels.findIndex((entry) => entry.id === after);
  panels.splice(after === null ? 0 : found === -1 ? panels.length : found + 1, 0, panel);
};

/**
 * Saved panels in their order, unknown ones dropped and missing ones after them as defaults, with
 * Charts and then Activity after the panel each is saved to follow (both live apart from
 * `panels`; see contracts). Activity goes in last, so sharing Charts' anchor puts it first.
 */
export function resolvePanels(layout: ForkDashboardLayout): ReadonlyArray<ResolvedPanel> {
  const seen = new Set<string>();
  const saved = layout.panels.flatMap((setting) => {
    const panel = SAVED_PANELS.find((entry) => entry.id === setting.id);
    if (panel === undefined || seen.has(panel.id)) return [];
    seen.add(panel.id);
    return [{ ...panel, hidden: setting.hidden }];
  });
  const panels: ResolvedPanel[] = [
    ...saved,
    ...SAVED_PANELS.filter((panel) => !seen.has(panel.id)).map((panel) => ({
      ...panel,
      hidden: false,
    })),
  ];
  insertAfter(panels, layout.charts.after, { ...CHARTS, hidden: layout.charts.hidden });
  insertAfter(panels, layout.activity.after, { ...ACTIVITY, hidden: layout.activity.hidden });
  return panels;
}

const writePanels = (
  layout: ForkDashboardLayout,
  panels: ReadonlyArray<ResolvedPanel>,
): ForkDashboardLayout => {
  const withoutActivity = panels.filter((panel) => panel.id !== "activity");
  const chartsAt = withoutActivity.findIndex((panel) => panel.id === "charts");
  const chartsAfter = chartsAt > 0 ? withoutActivity[chartsAt - 1]!.id : null;
  const activityAt = panels.findIndex((panel) => panel.id === "activity");
  const activityAfter = activityAt > 0 ? panels[activityAt - 1]!.id : null;
  return {
    ...layout,
    panels: panels.flatMap((panel): ForkDashboardLayout["panels"] =>
      panel.id === "charts" || panel.id === "activity"
        ? []
        : [{ id: panel.id, hidden: panel.hidden }],
    ),
    charts: {
      hidden: panels.find((panel) => panel.id === "charts")?.hidden ?? false,
      // Skipping Activity keeps Charts' anchor one that clients from before Activity can read.
      after: chartsAfter === "charts" || chartsAfter === "activity" ? null : chartsAfter,
    },
    activity: {
      hidden: panels[activityAt]?.hidden ?? false,
      after: activityAfter === "activity" ? null : activityAfter,
    },
  };
};

function moveItem<T>(items: ReadonlyArray<T>, from: number, to: number): ReadonlyArray<T> {
  if (from < 0 || from >= items.length) return items;
  const target = Math.max(0, Math.min(items.length - 1, to));
  if (target === from) return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item!);
  return next;
}

export function movePanel(
  layout: ForkDashboardLayout,
  id: DashboardPanelId,
  steps: number,
): ForkDashboardLayout {
  const panels = resolvePanels(layout);
  const from = panels.findIndex((panel) => panel.id === id);
  return writePanels(layout, moveItem(panels, from, from + steps));
}

export function setPanelHidden(
  layout: ForkDashboardLayout,
  id: DashboardPanelId,
  hidden: boolean,
): ForkDashboardLayout {
  return writePanels(
    layout,
    resolvePanels(layout).map((panel) => (panel.id === id ? { ...panel, hidden } : panel)),
  );
}

export function visibleProviders<T extends string>(
  providers: ReadonlyArray<T>,
  layout: ForkDashboardLayout,
): ReadonlyArray<T> {
  const hidden = new Set(layout.hiddenProviders);
  return providers.filter((provider) => !hidden.has(provider));
}

export function setProviderHidden(
  layout: ForkDashboardLayout,
  provider: string,
  hidden: boolean,
): ForkDashboardLayout {
  const rest = layout.hiddenProviders.filter((entry) => entry !== provider);
  return { ...layout, hiddenProviders: hidden ? [...rest, provider] : rest };
}

export const isDefaultLayout = (layout: ForkDashboardLayout) =>
  layout.panels.every((panel, index) => panel.id === SAVED_PANELS[index]?.id && !panel.hidden) &&
  layout.charts.hidden === DEFAULT_FORK_DASHBOARD_CHARTS.hidden &&
  layout.charts.after === DEFAULT_FORK_DASHBOARD_CHARTS.after &&
  layout.activity.hidden === DEFAULT_FORK_DASHBOARD_ACTIVITY.hidden &&
  layout.activity.after === DEFAULT_FORK_DASHBOARD_ACTIVITY.after &&
  layout.sections.length === 0 &&
  layout.machines.length === 0 &&
  layout.hiddenProviders.length === 0;

export const resetLayout = (): ForkDashboardLayout => DEFAULT_FORK_DASHBOARD_LAYOUT;

export const environmentIdentity = (environmentId: string) => `env:${environmentId}`;
export const tailnetIdentity = (nodeId: string) => `tailnet:${nodeId}`;
export const exporterIdentity = (name: string, host: string) => `exporter:${name}@${host}`;

export type MachineKind = "environment" | "exporter" | "peer";

/** T3 environments and node_exporters start in the map; tailnet peers in their own box. */
export const T3_SECTION = "t3";
export const TAILNET_SECTION = "tailnet";
export const BUILT_IN_SECTIONS = {
  [T3_SECTION]: msg("Connected machines"),
  [TAILNET_SECTION]: msg("Tailnet · without T3 Code"),
} as const;
/** Saved in English like any name the user types; only its display is translated. */
export const NEW_SECTION_NAME = msg("New section");

export const MACHINE_ICONS = [
  "monitor",
  "laptop",
  "server",
  "cloud",
  "database",
  "cpu",
  "router",
  "smartphone",
  "tablet",
  "tv",
  "gamepad",
  "house",
] as const;
export type MachineIcon = (typeof MACHINE_ICONS)[number];

export const MACHINE_COLORS = [
  "red",
  "orange",
  "amber",
  "lime",
  "emerald",
  "teal",
  "sky",
  "blue",
  "violet",
  "pink",
] as const;
export type MachineColor = (typeof MACHINE_COLORS)[number];

const known = <T extends string>(values: ReadonlyArray<T>, value: string | null): T | null =>
  value !== null && (values as ReadonlyArray<string>).includes(value) ? (value as T) : null;

export interface LiveMachine<T> {
  /** The machine's own identity first, then the tailnet node it was matched to, if any. */
  readonly ids: ReadonlyArray<string>;
  readonly kind: MachineKind;
  readonly name: string;
  readonly data: T;
}

export interface PlacedMachine<T> {
  readonly key: string;
  /** What its entry is written with: its own server or exporter ids and its current ones. */
  readonly ids: ReadonlyArray<string>;
  readonly name: string;
  readonly alias: string | null;
  readonly label: string;
  readonly icon: MachineIcon | null;
  readonly color: MachineColor | null;
  readonly hidden: boolean;
  /** The custom section it was put in, or null for its default one. */
  readonly assignedSection: string | null;
  readonly defaultSection: string;
  /** Null once nothing reports the machine: only its saved entry is left. */
  readonly live: LiveMachine<T> | null;
  /** The saved entry this machine owns, if any; edits rewrite it and no other. */
  readonly entries: ReadonlyArray<ForkDashboardMachine>;
  /** A saved entry that matches several machines equally, so it is applied to none. */
  readonly ambiguous: boolean;
}

export interface PlacedSection<T> {
  readonly id: string;
  readonly name: string;
  readonly custom: boolean;
  readonly machines: ReadonlyArray<PlacedMachine<T>>;
}

const shares = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.some((id) => right.includes(id));

const defaultSectionOfIds = (ids: ReadonlyArray<string>) =>
  ids.some((id) => id.startsWith("env:") || id.startsWith("exporter:"))
    ? T3_SECTION
    : TAILNET_SECTION;

const isStrongId = (id: string) => id.startsWith("env:") || id.startsWith("exporter:");

/** The schema's cap on identities per saved machine. */
const MAX_IDS = 10;

/**
 * The identities an entry keeps when written: the machine's own server or exporter ids first, then
 * the entry's other strong ids, then the machine's current tailnet nodes. Nodes it no longer has go,
 * and past the cap tailnet nodes go before any strong id, so a save never fails and never drops the
 * identity that ties the entry to its machine.
 */
function keptIds(entry: ForkDashboardMachine | null, current: ReadonlyArray<string>) {
  return [
    ...new Set([
      ...current.filter(isStrongId),
      ...(entry?.ids.filter(isStrongId) ?? []),
      ...current.filter((id) => !isStrongId(id)),
    ]),
  ].slice(0, MAX_IDS);
}

const sameIds = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length && left.every((id, index) => id === right[index]);

/**
 * Which live machine each saved entry belongs to; every machine takes one entry at most. An entry
 * holding a machine's own identity (its first id) belongs to it. Only a machine with no such entry
 * may take one through a linked identity, such as a shared tailnet node, and only when no other
 * machine could. Entries are never joined: the rest show as gone or ambiguous.
 */
function assignEntries<T>(
  layout: ForkDashboardLayout,
  live: ReadonlyArray<LiveMachine<T>>,
): { readonly owner: ReadonlyArray<number | null>; readonly ambiguous: ReadonlySet<number> } {
  const ambiguous = new Set<number>();
  const owner: Array<number | null> = layout.machines.map(() => null);
  const taken = new Set<number>();
  const strong = layout.machines.map((entry) =>
    live.flatMap((machine, index) =>
      machine.ids[0] !== undefined && entry.ids.includes(machine.ids[0]) ? [index] : [],
    ),
  );
  const hasOwnEntry = new Set(
    strong.flatMap((machines) => (machines.length === 1 ? machines : [])),
  );
  strong.forEach((machines, entryIndex) => {
    if (machines.length > 1) ambiguous.add(entryIndex);
    const [machine] = machines;
    if (machines.length !== 1 || taken.has(machine!)) return;
    owner[entryIndex] = machine!;
    taken.add(machine!);
  });
  layout.machines.forEach((entry, entryIndex) => {
    if (strong[entryIndex]!.length > 0) return;
    const candidates = live.flatMap((machine, index) =>
      !hasOwnEntry.has(index) && shares(entry.ids, machine.ids) ? [index] : [],
    );
    if (candidates.length > 1) ambiguous.add(entryIndex);
    const [machine] = candidates;
    if (candidates.length !== 1 || taken.has(machine!)) return;
    owner[entryIndex] = machine!;
    taken.add(machine!);
  });
  return { owner, ambiguous };
}

/**
 * Every section in its order (the map, the custom ones, then the tailnet box) with its machines.
 * Saved machines keep their saved order; one never saved goes right after the live machine it
 * follows, so naming a machine never moves it. Gone machines go last. A saved section that is
 * gone sends its machines back to their default one.
 */
export function placeMachines<T>(
  layout: ForkDashboardLayout,
  live: ReadonlyArray<LiveMachine<T>>,
  resolve: MessageResolver = m,
): ReadonlyArray<PlacedSection<T>> {
  const customIds = new Set(layout.sections.map((section) => section.id));
  const { owner, ambiguous } = assignEntries(layout, live);
  const savedKeys = new Map<string, number>();
  /** A gone or ambiguous entry's own key, so it never collides with a live machine's. */
  const savedKey = (ids: ReadonlyArray<string>) => {
    const base = `saved:${ids.join(",")}`;
    const seen = savedKeys.get(base) ?? 0;
    savedKeys.set(base, seen + 1);
    return seen === 0 ? base : `${base}#${seen}`;
  };
  const toPlaced = (
    entries: ReadonlyArray<ForkDashboardMachine>,
    machine: LiveMachine<T> | null,
    ids: ReadonlyArray<string>,
    isAmbiguous = false,
  ): PlacedMachine<T> => {
    const entry = entries[0] ?? null;
    const name = machine?.name || entry?.name || ids[0] || "Machine";
    const alias = entry?.alias?.trim() || null;
    return {
      key: machine === null ? savedKey(ids) : (machine.ids[0] ?? name),
      ids,
      name,
      alias,
      label: alias ?? name,
      icon: known(MACHINE_ICONS, entry?.icon ?? null),
      color: known(MACHINE_COLORS, entry?.color ?? null),
      hidden: entry?.hidden ?? false,
      assignedSection:
        entry?.section != null && customIds.has(entry.section) ? entry.section : null,
      defaultSection:
        machine === null
          ? defaultSectionOfIds(ids)
          : machine.kind === "peer"
            ? TAILNET_SECTION
            : T3_SECTION,
      live: machine,
      entries,
      ambiguous: isAmbiguous,
    };
  };
  const resolved = live.map((machine, index) => {
    const matches = owner.flatMap((owned, entryIndex) => (owned === index ? [entryIndex] : []));
    const entries = matches.map((entryIndex) => layout.machines[entryIndex]!);
    const ids = keptIds(entries[0] ?? null, machine.ids);
    return { savedIndex: matches[0] ?? null, machine: toPlaced(entries, machine, ids) };
  });
  const gone = layout.machines.flatMap((entry, entryIndex) =>
    owner[entryIndex] !== null || entry.ids.length === 0
      ? []
      : [toPlaced([entry], null, entry.ids, ambiguous.has(entryIndex))],
  );
  const sectionOf = (machine: PlacedMachine<T>) =>
    machine.assignedSection ?? machine.defaultSection;
  // The order is worked out per section, so a newcomer follows a machine it is shown beside.
  const inSection = (id: string) => {
    const members = resolved.filter((entry) => sectionOf(entry.machine) === id);
    const ordered = members
      .filter((entry) => entry.savedIndex !== null)
      .toSorted((left, right) => left.savedIndex! - right.savedIndex!)
      .map((entry) => entry.machine);
    let cursor = 0;
    for (const entry of members) {
      if (entry.savedIndex === null) ordered.splice(cursor++, 0, entry.machine);
      else cursor = ordered.indexOf(entry.machine) + 1;
    }
    return [...ordered, ...gone.filter((machine) => sectionOf(machine) === id)];
  };
  return [
    {
      id: T3_SECTION,
      name: resolve(BUILT_IN_SECTIONS[T3_SECTION]),
      custom: false,
      machines: inSection(T3_SECTION),
    },
    ...layout.sections.map((section) => ({
      id: section.id,
      name: section.name === NEW_SECTION_NAME ? resolve(NEW_SECTION_NAME) : section.name,
      custom: true,
      machines: inSection(section.id),
    })),
    {
      id: TAILNET_SECTION,
      name: resolve(BUILT_IN_SECTIONS[TAILNET_SECTION]),
      custom: false,
      machines: inSection(TAILNET_SECTION),
    },
  ];
}

type MachinePatch = Partial<
  Pick<ForkDashboardMachine, "alias" | "icon" | "color" | "hidden" | "section">
>;

interface MachineTarget {
  readonly ids: ReadonlyArray<string>;
  readonly name: string;
  /** The entry it owns, as placed; without it, the first entry sharing an identity. */
  readonly entries?: ReadonlyArray<ForkDashboardMachine>;
}

/** Writes the machine's one entry, in place of the one it owns, and returns it. */
function upsertMachine(
  layout: ForkDashboardLayout,
  target: MachineTarget,
  patch: MachinePatch,
): { readonly layout: ForkDashboardLayout; readonly entry: ForkDashboardMachine } {
  const owned = target.entries
    ? layout.machines.find((entry) => target.entries!.includes(entry))
    : layout.machines.find((entry) => shares(entry.ids, target.ids));
  const base: ForkDashboardMachine = owned ?? {
    ids: [],
    name: "",
    alias: null,
    icon: null,
    color: null,
    hidden: false,
    section: null,
  };
  const ids = keptIds(owned ?? null, target.ids);
  const alias = patch.alias === undefined ? base.alias : patch.alias?.trim() || null;
  const merged: ForkDashboardMachine = {
    ...base,
    ...patch,
    ids,
    name: target.name || base.name,
    alias: alias === target.name ? null : alias,
  };
  if (owned === undefined) {
    return { layout: { ...layout, machines: [...layout.machines, merged] }, entry: merged };
  }
  return {
    layout: {
      ...layout,
      machines: layout.machines.map((entry) => (entry === owned ? merged : entry)),
    },
    entry: merged,
  };
}

/** The machine's saved entry, created or changed. */
export function updateMachine(
  layout: ForkDashboardLayout,
  target: MachineTarget,
  patch: MachinePatch,
): ForkDashboardLayout {
  return upsertMachine(layout, target, patch).layout;
}

/**
 * Before a save: each live machine's own entry gets the identities it has now, so a peer that
 * became a server keeps its look once the tailnet link is gone. No two entries are joined.
 */
export function consolidateLayout<T>(
  layout: ForkDashboardLayout,
  live: ReadonlyArray<LiveMachine<T>>,
): ForkDashboardLayout {
  let next = layout;
  for (const machine of placeMachines(layout, live).flatMap((section) => section.machines)) {
    const [entry] = machine.entries;
    if (machine.live === null || entry === undefined || sameIds(entry.ids, machine.ids)) continue;
    next = upsertMachine(next, machine, {}).layout;
  }
  return next;
}

/** Saves the section's order as shown after moving one machine `steps` places. */
export function moveMachine<T>(
  layout: ForkDashboardLayout,
  section: PlacedSection<T>,
  key: string,
  steps: number,
): ForkDashboardLayout {
  const from = section.machines.findIndex((machine) => machine.key === key);
  const ordered = moveItem(section.machines, from, from + steps);
  if (ordered === section.machines) return layout;
  let next = layout;
  const owned: ForkDashboardMachine[] = [];
  for (const machine of ordered) {
    const result = upsertMachine(next, machine, {});
    next = result.layout;
    owned.push(result.entry);
  }
  // Only the order within a section counts, so the section's entries can go last together.
  return {
    ...next,
    machines: [...next.machines.filter((entry) => !owned.includes(entry)), ...owned],
  };
}

/** Into a custom section, or back to the default one with null; it lands last there. */
export function moveMachineToSection(
  layout: ForkDashboardLayout,
  target: MachineTarget,
  section: string | null,
): ForkDashboardLayout {
  const { layout: next, entry } = upsertMachine(layout, target, {
    section: section === T3_SECTION || section === TAILNET_SECTION ? null : section,
  });
  return { ...next, machines: [...next.machines.filter((other) => other !== entry), entry] };
}

/** Drops what was saved for a machine, as for one that is gone. */
export function forgetMachine(
  layout: ForkDashboardLayout,
  target: Pick<MachineTarget, "ids" | "entries">,
): ForkDashboardLayout {
  return {
    ...layout,
    machines: layout.machines.filter((entry) =>
      target.entries ? !target.entries.includes(entry) : !shares(entry.ids, target.ids),
    ),
  };
}

/** `s1`, `s2`…: the first number no saved section holds. */
export function nextSectionId(layout: ForkDashboardLayout): string {
  const taken = new Set(layout.sections.map((section) => section.id));
  let index = 1;
  while (taken.has(`s${index}`)) index += 1;
  return `s${index}`;
}

export function addSection(
  layout: ForkDashboardLayout,
  id: string,
  name: string,
): ForkDashboardLayout {
  return {
    ...layout,
    sections: [...layout.sections, { id, name: name.trim() || NEW_SECTION_NAME }],
  };
}

export function renameSection(
  layout: ForkDashboardLayout,
  id: string,
  name: string,
): ForkDashboardLayout {
  const trimmed = name.trim();
  if (trimmed === "") return layout;
  return {
    ...layout,
    sections: layout.sections.map((section) =>
      section.id === id ? { ...section, name: trimmed } : section,
    ),
  };
}

/** Its machines go back to their default sections, keeping everything else saved for them. */
export function removeSection(layout: ForkDashboardLayout, id: string): ForkDashboardLayout {
  return {
    ...layout,
    sections: layout.sections.filter((section) => section.id !== id),
    machines: layout.machines.map((entry) =>
      entry.section === id ? { ...entry, section: null } : entry,
    ),
  };
}

export function moveSection(
  layout: ForkDashboardLayout,
  id: string,
  steps: number,
): ForkDashboardLayout {
  const from = layout.sections.findIndex((section) => section.id === id);
  return { ...layout, sections: moveItem(layout.sections, from, from + steps) };
}
