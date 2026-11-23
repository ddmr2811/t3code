import { CHECKPOINT_DIFF_TRUNCATED_MARKER } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { diffFiles, LARGE_FILE_LINES } from "./diff.logic.ts";

const added = (path: string, lines: number) =>
  [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "index 0000000..1111111",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines} @@`,
    ...Array.from({ length: lines }, (_, index) => `+line ${index}`),
    "",
  ].join("\n");

describe("diffFiles", () => {
  it("flags a patch the server cut at its size limit", () => {
    const whole = added("a.txt", 2);
    expect(diffFiles({ diff: whole }).truncated).toBe(false);
    expect(diffFiles({ diff: `${whole}${CHECKPOINT_DIFF_TRUNCATED_MARKER}` }).truncated).toBe(true);
  });

  it("tells a file with no lines and a file too large to draw from one it draws", () => {
    const binary = [
      "diff --git a/logo.png b/logo.png",
      "new file mode 100644",
      "index 0000000..2222222",
      "Binary files /dev/null and b/logo.png differ",
      "",
    ].join("\n");
    const { files, truncated } = diffFiles({
      diff: binary + added("small.ts", 3) + added("big.ts", LARGE_FILE_LINES + 1),
    });
    expect(truncated).toBe(false);
    expect(files.map((file) => [file.path, file.kind])).toEqual([
      ["logo.png", "empty"],
      ["small.ts", "lines"],
      ["big.ts", "large"],
    ]);
  });

  it("names a tracked repository's files from the thread's folder", () => {
    const { files } = diffFiles({
      diff: added("same.txt", 1),
      repositories: [
        {
          name: "lib",
          repositoryPath: "/w/lib",
          relativePath: "../lib",
          diff: added("same.txt", 1),
        },
      ],
    });
    expect(files.map((file) => file.path)).toEqual(["same.txt", "../lib/same.txt"]);
    expect(new Set(files.map((file) => file.key)).size).toBe(2);
  });
});
