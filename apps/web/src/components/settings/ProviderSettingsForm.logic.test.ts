import { describe, expect, it } from "vite-plus/test";

import { relativePathWarning } from "./ProviderSettingsForm.logic";

describe("relativePathWarning", () => {
  it.each([
    "",
    "/home/dani/.claude-hub",
    "~",
    "~/.claude-hub",
    "~\\.claude-hub",
    "C:\\Users\\dani\\.claude-hub",
    "d:/claude",
    "\\\\server\\share\\claude",
  ])("accepts %j", (value) => {
    expect(relativePathWarning(value)).toBeUndefined();
  });

  it.each([".claude-hub", "claude-hub/config", "~dani/.claude", "C:claude"])(
    "warns about %j",
    (value) => {
      expect(relativePathWarning(value)).toBe(
        "Relative paths are taken from your home folder; use an absolute path or ~/…",
      );
    },
  );
});
