import { chunkTerminalWrite } from "@t3tools/contracts";

export interface QueuedInput {
  data: string;
  readonly kind?: "binary" | "reply";
  /** The shell it was typed into: input never reaches the one that replaces it. */
  readonly shell: string;
}

/**
 * Sends queued terminal input in order, one write at a time. At the first write that fails, or
 * once the live shell is not the one an entry was typed into, everything left is dropped: half a
 * command, or a command meant for another shell, must not run.
 */
export async function drainTerminalInput(
  queue: Array<QueuedInput>,
  liveShell: () => string | null,
  write: (chunk: string, kind: QueuedInput["kind"]) => Promise<boolean>,
): Promise<void> {
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const chunk of chunkTerminalWrite(next.data)) {
      if (liveShell() !== next.shell || !(await write(chunk, next.kind))) {
        queue.length = 0;
        return;
      }
    }
  }
}
