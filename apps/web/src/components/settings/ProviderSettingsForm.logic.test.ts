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
      expect(relativePathWarning(value)).toBe("Use an absolute path, or ~ for your home folder.");
    },
  );
});
