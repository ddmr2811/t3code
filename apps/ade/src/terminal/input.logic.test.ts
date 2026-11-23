import { TERMINAL_WRITE_MAX_LENGTH } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { drainTerminalInput, type QueuedInput } from "./input.logic.ts";

// A paste of three writes, then a keystroke typed while it was going out.
const paste = () => [
  { data: "a".repeat(TERMINAL_WRITE_MAX_LENGTH * 2 + 1), shell: "1:0" },
  { data: "rm -rf build\r", shell: "1:0" },
];

describe("drainTerminalInput", () => {
  it("sends every chunk in order while the shell stays the same", async () => {
    const queue: Array<QueuedInput> = paste();
    const written: Array<number> = [];
    await drainTerminalInput(
      queue,
      () => "1:0",
      async (chunk) => {
        written.push(chunk.length);
        return true;
      },
    );
    expect(written).toEqual([TERMINAL_WRITE_MAX_LENGTH, TERMINAL_WRITE_MAX_LENGTH, 1, 13]);
  });

  it("writes nothing more after the first write that fails", async () => {
    const queue: Array<QueuedInput> = paste();
    let writes = 0;
    await drainTerminalInput(
      queue,
      () => "1:0",
      async () => {
        writes += 1;
        return false;
      },
    );
    expect(writes).toBe(1);
    expect(queue).toEqual([]);
  });

  it("writes nothing into the shell that replaced the one typed into", async () => {
    const queue: Array<QueuedInput> = paste();
    let shell = "1:0";
    let writes = 0;
    await drainTerminalInput(
      queue,
      () => shell,
      async () => {
        writes += 1;
        shell = "2:1";
        return true;
      },
    );
    expect(writes).toBe(1);
    expect(queue).toEqual([]);
  });
});
