import {
  DEFAULT_FORK_DASHBOARD_LAYOUT,
  type ForkDashboardLayout,
  ForkDashboardLayout as ForkDashboardLayoutSchema,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  addSection,
  consolidateLayout,
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
const decodeLayout = Schema.decodeSync(ForkDashboardLayoutSchema);

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
    expect(names(forgetMachine(saved, gone), live).tailnet).toEqual(["ps5"]);
  });

  it("applies an entry two machines match equally to neither, and keeps their own apart", () => {
    // Old data: both servers once got the same node, and Dani named them after that.
    const both = [env("a", "box", "nX"), env("b", "box")];
    const stale = {
      ...empty,
      machines: [
        {
          ids: ["tailnet:nX"],
          name: "box",
          alias: "Shared",
          icon: null,
          color: null,
          hidden: false,
          section: null,
        },
      ],
    };
    const sharedBoth = [
      env("a", "box", "nX"),
      { ...env("b", "box"), ids: ["env:b", "tailnet:nX"] },
    ];
    const placed = placeMachines(stale, sharedBoth).flatMap((section) => section.machines);
    expect(placed.filter((machine) => machine.live).map((machine) => machine.label)).toEqual([
      "box",
      "box",
    ]);
    expect(placed.find((machine) => machine.live === null)).toMatchObject({ ambiguous: true });
    // Naming A then B keeps each alias on its own machine, even with the node in A's entry.
    let layout = updateMachine(empty, placeMachines(empty, both)[0]!.machines[0]!, {
      alias: "Alpha",
    });
    const b = placeMachines(layout, both)[0]!.machines.find((machine) => machine.key === "env:b")!;
    layout = updateMachine(layout, b, { alias: "Beta" });
    expect(names(layout, sharedBoth).t3).toEqual(["Alpha", "Beta"]);
  });

  it("keeps each server's own entry when a tailnet node moves from one to the other", () => {
    const entry = (ids: ReadonlyArray<string>, alias: string) => ({
      ids,
      name: "box",
      alias,
      icon: null,
      color: null,
      hidden: false,
      section: null,
    });
    const saved = {
      ...empty,
      machines: [entry(["env:a", "tailnet:nX"], "Alpha"), entry(["env:b"], "Beta")],
    };
    // A is off and its node now answers as B: B keeps Beta, and Alpha waits for A.
    const aOff = [env("b", "box", "nX")];
    expect(names(saved, aOff).t3).toEqual(["Beta", "Alpha (gone)"]);
    const toSave = consolidateLayout(saved, aOff);
    expect(toSave.machines.map((machine) => [machine.ids, machine.alias])).toEqual([
      [["env:a", "tailnet:nX"], "Alpha"],
      [["env:b", "tailnet:nX"], "Beta"],
    ]);
    expect(names(toSave, [env("a", "box"), env("b", "box", "nX")]).t3).toEqual(["Alpha", "Beta"]);
  });

  it("drops tailnet nodes a machine no longer has, so a save stays under the identity cap", () => {
    const history = Array.from({ length: 9 }, (_, index) => `tailnet:old${index}`);
    const saved = {
      ...empty,
      machines: [
        {
          ids: ["env:pc", ...history],
          name: "pc",
          alias: "Desk",
          icon: null,
          color: null,
          hidden: false,
          section: null,
        },
      ],
    };
    const toSave = consolidateLayout(saved, [env("pc", "pc", "new")]);
    expect(toSave.machines[0]).toMatchObject({ ids: ["env:pc", "tailnet:new"], alias: "Desk" });
    expect(() => decodeLayout(toSave)).not.toThrow();
  });

  it("keeps a machine's own identity when its current tailnet nodes alone reach the cap", () => {
    const saved = updateMachine(empty, { ids: ["env:pc"], name: "pc" }, { alias: "Desk" });
    const nodes = Array.from({ length: 10 }, (_, index) => `tailnet:n${index}`);
    const live = { ...env("pc", "pc"), ids: ["env:pc", ...nodes] };
    const toSave = consolidateLayout(saved, [live]);
    expect(toSave.machines[0]?.ids[0]).toBe("env:pc");
    expect(toSave.machines[0]?.ids).toHaveLength(10);
    expect(names(toSave, [env("pc", "pc")]).t3).toEqual(["Desk"]);
    expect(() => decodeLayout(toSave)).not.toThrow();
  });

  it("gives a gone or ambiguous entry a key of its own, apart from the machines it names", () => {
    // An entry naming two servers at once belongs to neither, and its first id is A's own key.
    const stale = updateMachine(empty, { ids: ["env:a", "env:b"], name: "box" }, { alias: "Both" });
    const servers = [env("a", "alpha"), env("b", "beta")];
    const section = placeMachines(stale, servers)[0]!;
    expect(section.machines.map((machine) => [machine.key, machine.ambiguous])).toEqual([
      ["env:a", false],
      ["env:b", false],
      ["saved:env:a,env:b", true],
    ]);
    // Keys stay apart, so moving B moves B and leaves the entry that names it alone.
    const moved = moveMachine(stale, section, "env:b", -1);
    expect(names(moved, servers).t3).toEqual(["beta", "alpha", "Both (gone)"]);
    expect(moved.machines.find((machine) => machine.alias === "Both")?.ids).toEqual([
      "env:a",
      "env:b",
    ]);
  });

  it("joins a peer's entry with the server it became when saving, so it outlives the link", () => {
    const saved = updateMachine(
      empty,
      { ids: ["tailnet:nCx53"], name: "dev-cx53" },
      { alias: "Builder" },
    );
    const after = [...live, env("cx53", "dev-cx53", "nCx53")];
    // Dani only hides a panel before saving; the save still records the new identity.
    const toSave = consolidateLayout(setPanelHidden(saved, "threads", true), after);
    expect(toSave.machines).toMatchObject([
      { ids: ["env:cx53", "tailnet:nCx53"], alias: "Builder" },
    ]);
    expect(names(toSave, [...live, env("cx53", "dev-cx53")]).t3).toContain("Builder");
    // Nothing to join: the layout comes back as it was.
    expect(consolidateLayout(toSave, after)).toBe(toSave);
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
  it("fills in missing panels, keeps the first of a repeated one and reorders", () => {
    const layout = {
      ...empty,
      panels: [
        { id: "threads", hidden: true },
        { id: "threads", hidden: false },
      ] as const,
    };
    expect(resolvePanels(layout).map((panel) => [panel.id, panel.hidden])).toEqual([
      ["threads", true],
      ["machines", false],
      ["subscriptions", false],
      ["charts", false],
    ]);
    const moved = movePanel(layout, "subscriptions", -2);
    expect(resolvePanels(moved).map((panel) => panel.id)).toEqual([
      "subscriptions",
      "threads",
      "machines",
      "charts",
    ]);
    expect(resolvePanels(setPanelHidden(moved, "threads", false))[1]).toMatchObject({
      id: "threads",
      hidden: false,
    });
  });
});

describe("charts panel", () => {
  it("keeps Charts out of panels and saves where it sits and whether it shows", () => {
    const first = movePanel(movePanel(empty, "charts", -1), "charts", -1);
    expect(first.panels.map((panel) => panel.id)).toEqual(["machines", "subscriptions", "threads"]);
    expect(first.charts).toEqual({ hidden: false, after: null });
    expect(resolvePanels(first)[0]!.id).toBe("charts");

    const hidden = setPanelHidden(movePanel(empty, "charts", 1), "charts", true);
    expect(hidden.charts).toEqual({ hidden: true, after: "threads" });
    expect(hidden.panels.some((panel) => panel.hidden)).toBe(false);
    expect(isDefaultLayout(hidden)).toBe(false);
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
