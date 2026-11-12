import { DEFAULT_SERVER_SETTINGS, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  firstForkTargetBranch,
  forkAutoPullSkipReason,
  forkPrBaseCandidate,
  forkTargetBranchFor,
  isForkAutoPullBranch,
} from "./targetBranch.ts";

const projectId = ProjectId.make("project-a");

describe("forkTargetBranchFor", () => {
  it("devuelve null sin valor", () => {
    expect(forkTargetBranchFor(DEFAULT_SERVER_SETTINGS, projectId)).toBeNull();
  });

  it("usa el valor global", () => {
    expect(
      forkTargetBranchFor({ ...DEFAULT_SERVER_SETTINGS, forkTargetBranch: "dev" }, projectId),
    ).toBe("dev");
  });

  it("el override de proyecto gana al global", () => {
    expect(
      forkTargetBranchFor(
        {
          ...DEFAULT_SERVER_SETTINGS,
          forkTargetBranch: "dev",
          projectSettingsOverrides: { [projectId]: { forkTargetBranch: "staging" } },
        },
        projectId,
      ),
    ).toBe("staging");
  });

  it("solo espacios equivale a vacío", () => {
    expect(
      forkTargetBranchFor({ ...DEFAULT_SERVER_SETTINGS, forkTargetBranch: "  " }, projectId),
    ).toBeNull();
  });

  it("quita el prefijo refs/heads/", () => {
    expect(
      forkTargetBranchFor(
        { ...DEFAULT_SERVER_SETTINGS, forkTargetBranch: "refs/heads/dev" },
        projectId,
      ),
    ).toBe("dev");
  });
});

describe("isForkAutoPullBranch", () => {
  it.each([true, false])(
    "sin destino devuelve isDefaultBranch tal cual (%s)",
    (isDefaultBranch) => {
      expect(isForkAutoPullBranch({ branch: "main", isDefaultBranch, targetBranch: null })).toBe(
        isDefaultBranch,
      );
    },
  );

  it("true cuando la rama es el destino", () => {
    expect(
      isForkAutoPullBranch({ branch: "dev", isDefaultBranch: false, targetBranch: "dev" }),
    ).toBe(true);
  });

  it("el destino sustituye a la principal, no se suma", () => {
    expect(
      isForkAutoPullBranch({ branch: "main", isDefaultBranch: true, targetBranch: "dev" }),
    ).toBe(false);
  });

  it("false sin rama", () => {
    expect(isForkAutoPullBranch({ branch: null, isDefaultBranch: true, targetBranch: "dev" })).toBe(
      false,
    );
  });
});

describe("forkPrBaseCandidate", () => {
  it("null sin destino", () => {
    expect(forkPrBaseCandidate({ headBranch: "feature/x", targetBranch: null })).toBeNull();
  });

  it("propone el destino para una rama distinta", () => {
    expect(forkPrBaseCandidate({ headBranch: "feature/x", targetBranch: "dev" })).toBe("dev");
  });

  it("null cuando la cabeza es el propio destino", () => {
    expect(forkPrBaseCandidate({ headBranch: "dev", targetBranch: "dev" })).toBeNull();
  });
});

describe("firstForkTargetBranch", () => {
  it("devuelve el primer destino no nulo", () => {
    expect(firstForkTargetBranch([null, "dev", "qa"])).toBe("dev");
  });

  it("null si no hay ninguno o la lista está vacía", () => {
    expect(firstForkTargetBranch([null, null])).toBeNull();
    expect(firstForkTargetBranch([])).toBeNull();
  });
});

describe("forkAutoPullSkipReason", () => {
  const clean = {
    isRepo: true,
    branch: "dev",
    isDefaultBranch: false,
    hasUpstream: true,
    hasWorkingTreeChanges: false,
    aheadCount: 0,
  };

  it("en la rama de destino con árbol sucio atribuye el motivo al árbol", () => {
    expect(forkAutoPullSkipReason({ ...clean, hasWorkingTreeChanges: true }, "dev")).toBe(
      "working-tree-changes",
    );
    expect(forkAutoPullSkipReason({ ...clean, hasUpstream: false }, "dev")).toBe("no-upstream");
  });

  it("en la principal con destino distinto dice not-on-target-branch aunque haya otros motivos", () => {
    const main = { ...clean, branch: "main", isDefaultBranch: true, hasUpstream: false };
    expect(forkAutoPullSkipReason(main, "dev")).toBe("not-on-target-branch");
  });

  it("sin destino conserva los motivos originales", () => {
    expect(forkAutoPullSkipReason(clean, null)).toBe("not-on-default-branch");
    expect(forkAutoPullSkipReason({ ...clean, isDefaultBranch: true, aheadCount: 1 }, null)).toBe(
      "local-commits",
    );
    expect(forkAutoPullSkipReason({ ...clean, isDefaultBranch: true }, null)).toBeNull();
  });
});
