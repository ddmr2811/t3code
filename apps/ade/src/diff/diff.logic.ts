import type { FileDiffMetadata } from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import {
  repositoryFilePath,
  turnDiffSections,
} from "@t3tools/client-runtime/state/thread-repositories";
import {
  CHECKPOINT_DIFF_TRUNCATED_MARKER,
  type OrchestrationGetTurnDiffResult,
} from "@t3tools/contracts";

/** Above this many rendered lines a file shows a notice until asked for. */
export const LARGE_FILE_LINES = 1500;

export interface DiffFile {
  readonly key: string;
  /** From the thread's folder, so files of two repositories never share a path. */
  readonly path: string;
  readonly fileDiff: FileDiffMetadata;
  readonly additions: number;
  readonly deletions: number;
  /** "empty" has no lines to show: a binary file, or only a rename or a mode change. */
  readonly kind: "lines" | "large" | "empty";
}

export interface DiffFiles {
  readonly files: ReadonlyArray<DiffFile>;
  /** The server cut the patch at its size limit, so the last files may be missing or partial. */
  readonly truncated: boolean;
}

/** A turn or thread diff as the files the view lists, each repository's under its folder. */
export function diffFiles(
  diff: Pick<OrchestrationGetTurnDiffResult, "diff" | "repositories">,
): DiffFiles {
  let truncated = false;
  const files = turnDiffSections(diff, "").flatMap((section) => {
    // The parser skips the marker line; it only tells the user what is missing.
    if (section.diff.endsWith(CHECKPOINT_DIFF_TRUNCATED_MARKER)) truncated = true;
    return parsePatchFiles(section.diff)
      .flatMap((parsed) => parsed.files)
      .map((fileDiff): DiffFile => {
        const path = repositoryFilePath(section.relativePath, fileDiff.name);
        let additions = 0;
        let deletions = 0;
        for (const hunk of fileDiff.hunks) {
          additions += hunk.additionLines;
          deletions += hunk.deletionLines;
        }
        return {
          key: `${section.key}:${path}`,
          path,
          fileDiff,
          additions,
          deletions,
          kind:
            fileDiff.hunks.length === 0
              ? "empty"
              : fileDiff.unifiedLineCount > LARGE_FILE_LINES
                ? "large"
                : "lines",
        };
      });
  });
  return { files, truncated };
}
