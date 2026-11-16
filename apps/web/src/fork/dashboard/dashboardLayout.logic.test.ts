import { DEFAULT_FORK_DASHBOARD_LAYOUT, type ForkDashboardLayout } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addSection,
  environmentIdentity,
  forgetMachine,
  isDefaultLayout,
  type LiveMachine,
  moveMachine,
  moveMachineToSection,
  movePanel,
  nextSectionId,
  placeMachines,
  removeSection,
  resetLayout,
  resolvePanels,
  setPanelHidden,
  setProviderHidden,
  TAILNET_SECTION,
  T3_SECTION,
  tailnetIdentity,
  updateMachine,
  visibleProviders,
} from "./dashboardLayout.logic";

const env = (id: string, name: string, node?: string): LiveMachine<string> => ({
  ids: [environmentIdentity(id), ...(node ? [tailnetIdentity(node)] : [])],
  kind: "environment",
  name,
  data: id,
});
const peer = (node: string, name: string): LiveMachine<string> => ({
  ids: [tailnetIdentity(node)],
  kind: "peer",
  name,
  data: node,
});

const names = (layout: ForkDashboardLayout, live: ReadonlyArray<LiveMachine<string>>) =>
  Object.fromEntries(
    placeMachines(layout, live).map((section) => [
      section.id,
      section.machines.map((machine) => (machine.live ? machine.label : `${machine.label} (gone)`)),
    ]),
  );

const empty = DEFAULT_FORK_DASHBOARD_LAYOUT;

describe("placeMachines", () => {
  const live = [env("pc", "Dani"), env("dev", "dev-cx43"), peer("nPs5", "ps5")];

  it("puts new machines in their default section, in the order they came", () => {
    expect(names(empty, live)).toEqual({ t3: ["Dani", "dev-cx43"], tailnet: ["ps5"] });
  });

  it("keeps alias, icon and colour when a tailnet peer turns into a T3 environment", () => {
    // dev-cx53 runs no T3 Code yet: Dani names it and gives it an icon and a colour.
    const before = [...live, peer("nCx53", "dev-cx53")];
    const target = placeMachines(empty, before)
      .flatMap((section) => section.machines)
      .find((machine) => machine.name === "dev-cx53")!;
    const saved = updateMachine(empty, target, { alias: "Builder", icon: "server", color: "teal" });
    expect(names(saved, before).tailnet).toEqual(["ps5", "Builder"]);

    // After the move it is an environment whose server or endpoint names the same tailnet node.
    const after = [...live, env("cx53", "dev-cx53", "nCx53")];
    const sections = placeMachines(saved, after);
    const moved = sections.find((section) => section.id === T3_SECTION)!.machines.at(-1)!;
    expect(moved).toMatchObject({
      label: "Builder",
      icon: "server",
      color: "teal",
      ids: ["env:cx53", "tailnet:nCx53"],
    });
    expect(sections.find((section) => section.id === TAILNET_SECTION)!.machines).toHaveLength(1);
  });

  it("keeps a custom section through the same move, and joins both identities on the next save", () => {
    const work = addSection(empty, "work", "Work");
    const saved = moveMachineToSection(work, { ids: ["tailnet:nCx53"], name: "dev-cx53" }, "work");
    const after = [...live, env("cx53", "dev-cx53", "nCx53")];
    expect(names(saved, after).work).toEqual(["dev-cx53"]);
    const moved = placeMachines(saved, after).find((section) => section.id === "work")!
      .machines[0]!;
    // Later, without the tailnet reading, the environment id alone still finds the entry.
    const joined = updateMachine(saved, moved, { alias: "cx53" });
    expect(names(joined, [env("cx53", "dev-cx53")]).work).toEqual(["cx53"]);
  });

  it("lists a saved machine that is gone after the live ones, and forgets it on request", () => {
    const saved = updateMachine(
      empty,
      { ids: ["tailnet:nOld"], name: "old-box" },
      { alias: "Old" },
    );
    expect(names(saved, live).tailnet).toEqual(["ps5", "Old (gone)"]);
    const gone = placeMachines(saved, live)
      .flatMap((section) => section.machines)
      .find((machine) => machine.live === null)!;
    expect(names(forgetMachine(saved, gone.ids), live).tailnet).toEqual(["ps5"]);
  });

  it("hides a machine without losing its place", () => {
    const saved = updateMachine(empty, live[0]!, { hidden: true });
    const machine = placeMachines(saved, live)[0]!.machines[0]!;
    expect(machine).toMatchObject({ name: "Dani", hidden: true });
  });

  it("saves the shown order once a machine is moved, and slots newcomers beside the machine they follow", () => {
    const section = placeMachines(empty, live)[0]!;
    const moved = moveMachine(empty, section, "env:dev", -1);
    expect(names(moved, live).t3).toEqual(["dev-cx43", "Dani"]);
    // In the default order nexo follows dev-cx43, so it lands right after it.
    expect(names(moved, [...live, env("nexo", "nexo")]).t3).toEqual(["dev-cx43", "nexo", "Dani"]);
    // A newcomer that comes first in the live order stays first.
    expect(names(moved, [env("a", "a-box"), ...live]).t3).toEqual(["a-box", "dev-cx43", "Dani"]);
    // The first machine has nowhere further up to go.
    expect(moveMachine(empty, section, "env:pc", -1)).toBe(empty);
  });

  it("sends the machines of a deleted section back to their defaults, keeping their aliases", () => {
    let layout = addSection(empty, "devices", "Devices");
    layout = moveMachineToSection(layout, { ids: ["tailnet:nPs5"], name: "ps5" }, "devices");
    layout = moveMachineToSection(layout, { ids: ["env:dev"], name: "dev-cx43" }, "devices");
    layout = updateMachine(
      layout,
      { ids: ["tailnet:nPs5"], name: "ps5" },
      { alias: "PlayStation" },
    );
    expect(names(layout, live)).toEqual({
      t3: ["Dani"],
      devices: ["PlayStation", "dev-cx43"],
      tailnet: [],
    });
    expect(names(removeSection(layout, "devices"), live)).toEqual({
      t3: ["Dani", "dev-cx43"],
      tailnet: ["PlayStation"],
    });
    expect(nextSectionId(addSection(empty, "s1", "Work"))).toBe("s2");
    // A section id left in an entry with no section behind it falls back the same way.
    expect(names({ ...layout, sections: [] }, live).tailnet).toEqual(["PlayStation"]);
  });

  it("ignores an icon or colour this client does not know, and an alias equal to the name", () => {
    const saved = updateMachine(
      {
        ...empty,
        machines: [
          {
            ids: ["env:pc"],
            name: "Dani",
            alias: null,
            icon: "rocket",
            color: "plaid",
            hidden: false,
            section: null,
          },
        ],
      },
      live[0]!,
      { alias: " Dani " },
    );
    expect(saved.machines[0]!.alias).toBe(null);
    expect(placeMachines(saved, live)[0]!.machines[0]).toMatchObject({ icon: null, color: null });
  });
});

describe("panels", () => {
  it("fills in missing panels, drops unknown ones and reorders", () => {
    const layout = {
      ...empty,
      panels: [
        { id: "threads", hidden: true },
        { id: "calendar", hidden: false },
      ],
    };
    expect(resolvePanels(layout).map((panel) => [panel.id, panel.hidden])).toEqual([
      ["threads", true],
      ["machines", false],
      ["subscriptions", false],
    ]);
    const moved = movePanel(layout, "subscriptions", -2);
    expect(resolvePanels(moved).map((panel) => panel.id)).toEqual([
      "subscriptions",
      "threads",
      "machines",
    ]);
    expect(resolvePanels(setPanelHidden(moved, "threads", false))[1]).toMatchObject({
      id: "threads",
      hidden: false,
    });
  });
});

describe("providers", () => {
  it("shows the providers that are not hidden", () => {
    const layout = setProviderHidden(setProviderHidden(empty, "grok", true), "opencode", true);
    expect(visibleProviders(["claude", "codex", "grok", "opencode"], layout)).toEqual([
      "claude",
      "codex",
    ]);
    expect(visibleProviders(["claude", "grok"], setProviderHidden(layout, "grok", false))).toEqual([
      "claude",
      "grok",
    ]);
  });
});

describe("reset", () => {
  it("goes back to the defaults, which count as default even when saved in default order", () => {
    const edited = setPanelHidden(addSection(empty, "work", "Work"), "threads", true);
    expect(isDefaultLayout(edited)).toBe(false);
    expect(isDefaultLayout(resetLayout())).toBe(true);
    expect(isDefaultLayout(movePanel(movePanel(empty, "threads", -1), "threads", 1))).toBe(true);
  });
});
