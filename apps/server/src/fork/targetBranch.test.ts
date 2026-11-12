import { DEFAULT_SERVER_SETTINGS, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { forkPrBaseCandidate, forkTargetBranchFor, isForkAutoPullBranch } from "./targetBranch.ts";

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
