import { describe, expect, it } from "vite-plus/test";

import { environmentsWithoutForkTargetBranch } from "./forkTargetBranchRow.logic";

describe("environmentsWithoutForkTargetBranch", () => {
  it("returns nothing when every environment announces the capability", () => {
    expect(
      environmentsWithoutForkTargetBranch([
        { label: "Local", capabilities: { forkTargetBranch: 1 } },
        { label: "VPS", capabilities: { forkTargetBranch: 1 } },
      ]),
    ).toEqual([]);
  });

  it("names environments without server config or without the key", () => {
    expect(
      environmentsWithoutForkTargetBranch([
        { label: "Local", capabilities: { forkTargetBranch: 1 } },
        { label: "Offline", capabilities: undefined },
        { label: "VPS", capabilities: {} },
      ]),
    ).toEqual(["Offline", "VPS"]);
  });

  it("returns nothing for an empty list", () => {
    expect(environmentsWithoutForkTargetBranch([])).toEqual([]);
  });
});
