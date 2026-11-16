// Fork-only: the saved Dashboard arrangement laid over the machines that exist right now. Saved
// entries are found by any identity they share with a live machine, never by order or label, so
// a tailnet peer that becomes a T3 environment keeps its alias, icon, colour and section.
import {
  DEFAULT_FORK_DASHBOARD_LAYOUT,
  type ForkDashboardLayout,
  type ForkDashboardMachine,
} from "@t3tools/contracts";

export type DashboardPanelId = "machines" | "subscriptions" | "threads";

const DASHBOARD_PANELS: ReadonlyArray<{
  readonly id: DashboardPanelId;
  readonly title: string;
}> = [
  { id: "machines", title: "Machines" },
  { id: "subscriptions", title: "Subscriptions" },
  { id: "threads", title: "Active threads" },
];

export interface ResolvedPanel {
  readonly id: DashboardPanelId;
  readonly title: string;
  readonly hidden: boolean;
}

/** Saved panels in their order, unknown ones dropped and missing ones after them as defaults. */
export function resolvePanels(layout: ForkDashboardLayout): ReadonlyArray<ResolvedPanel> {
  const seen = new Set<string>();
  const saved = layout.panels.flatMap((setting) => {
    const panel = DASHBOARD_PANELS.find((entry) => entry.id === setting.id);
    if (panel === undefined || seen.has(panel.id)) return [];
    seen.add(panel.id);
    return [{ ...panel, hidden: setting.hidden }];
  });
  return [
    ...saved,
    ...DASHBOARD_PANELS.filter((panel) => !seen.has(panel.id)).map((panel) => ({
      ...panel,
      hidden: false,
    })),
  ];
}

const writePanels = (
  layout: ForkDashboardLayout,
  panels: ReadonlyArray<ResolvedPanel>,
): ForkDashboardLayout => ({
  ...layout,
  panels: panels.map((panel) => ({ id: panel.id, hidden: panel.hidden })),
});

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
  layout.panels.every(
    (panel, index) => panel.id === DASHBOARD_PANELS[index]?.id && !panel.hidden,
  ) &&
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
  [T3_SECTION]: "Connected machines",
  [TAILNET_SECTION]: "Tailnet · without T3 Code",
} as const;

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
  /** The live identities and every saved one they matched, so a save joins them. */
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

/**
 * Every section in its order (the map, the custom ones, then the tailnet box) with its machines.
 * Saved machines keep their saved order; one never saved goes right after the live machine it
 * follows, so naming a machine never moves it. Gone machines go last. A saved section that is
 * gone sends its machines back to their default one.
 */
export function placeMachines<T>(
  layout: ForkDashboardLayout,
  live: ReadonlyArray<LiveMachine<T>>,
): ReadonlyArray<PlacedSection<T>> {
  const customIds = new Set(layout.sections.map((section) => section.id));
  const claimed = new Set<number>();
  const toPlaced = (
    entry: ForkDashboardMachine | null,
    machine: LiveMachine<T> | null,
    ids: ReadonlyArray<string>,
  ): PlacedMachine<T> => {
    const name = machine?.name || entry?.name || ids[0] || "Machine";
    const alias = entry?.alias?.trim() || null;
    return {
      key: ids[0] ?? name,
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
    };
  };
  const resolved = live.map((machine) => {
    const matches = layout.machines.flatMap((entry, entryIndex) =>
      !claimed.has(entryIndex) && shares(entry.ids, machine.ids) ? [entryIndex] : [],
    );
    for (const entryIndex of matches) claimed.add(entryIndex);
    const first = matches[0];
    const ids = [
      ...new Set([
        ...machine.ids,
        ...matches.flatMap((entryIndex) => layout.machines[entryIndex]!.ids),
      ]),
    ];
    return {
      savedIndex: first ?? null,
      machine: toPlaced(first === undefined ? null : layout.machines[first]!, machine, ids),
    };
  });
  const gone = layout.machines.flatMap((entry, entryIndex) =>
    claimed.has(entryIndex) || entry.ids.length === 0 ? [] : [toPlaced(entry, null, entry.ids)],
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
      name: BUILT_IN_SECTIONS[T3_SECTION],
      custom: false,
      machines: inSection(T3_SECTION),
    },
    ...layout.sections.map((section) => ({
      id: section.id,
      name: section.name,
      custom: true,
      machines: inSection(section.id),
    })),
    {
      id: TAILNET_SECTION,
      name: BUILT_IN_SECTIONS[TAILNET_SECTION],
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
}

/** One saved entry for the machine, joining every entry that shares an identity with it. */
export function updateMachine(
  layout: ForkDashboardLayout,
  target: MachineTarget,
  patch: MachinePatch,
): ForkDashboardLayout {
  const matches = layout.machines.flatMap((entry, index) =>
    shares(entry.ids, target.ids) ? [index] : [],
  );
  const first = matches[0];
  const base: ForkDashboardMachine =
    first === undefined
      ? { ids: [], name: "", alias: null, icon: null, color: null, hidden: false, section: null }
      : layout.machines[first]!;
  const ids = [
    ...new Set([...target.ids, ...matches.flatMap((index) => layout.machines[index]!.ids)]),
  ];
  const alias = patch.alias === undefined ? base.alias : patch.alias?.trim() || null;
  const merged: ForkDashboardMachine = {
    ...base,
    ...patch,
    ids,
    name: target.name || base.name,
    alias: alias === target.name ? null : alias,
  };
  if (first === undefined) return { ...layout, machines: [...layout.machines, merged] };
  return {
    ...layout,
    machines: layout.machines.flatMap((entry, index) =>
      index === first ? [merged] : matches.includes(index) ? [] : [entry],
    ),
  };
}

const entryOf = (layout: ForkDashboardLayout, target: MachineTarget) =>
  layout.machines.find((entry) => shares(entry.ids, target.ids));

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
  for (const machine of ordered) next = updateMachine(next, machine, {});
  const owned = ordered.map((machine) => entryOf(next, machine)!);
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
  const next = updateMachine(layout, target, {
    section: section === T3_SECTION || section === TAILNET_SECTION ? null : section,
  });
  const entry = entryOf(next, target)!;
  return { ...next, machines: [...next.machines.filter((other) => other !== entry), entry] };
}

/** Drops what was saved for a machine, as for one that is gone. */
export function forgetMachine(
  layout: ForkDashboardLayout,
  ids: ReadonlyArray<string>,
): ForkDashboardLayout {
  return { ...layout, machines: layout.machines.filter((entry) => !shares(entry.ids, ids)) };
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
  return { ...layout, sections: [...layout.sections, { id, name: name.trim() || "New section" }] };
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
