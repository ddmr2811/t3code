import { ForkExtensionsError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import { readWithFingerprint, writeIfUnchanged } from "./safeFileEdit.ts";

/**
 * Store for things the user switched off globally but that the agent has no "disable"
 * for: Claude MCP servers (definition stashed, removed via CLI, re-added on enable) and
 * loose skills (folder moved out of the skills dir). Lives in
 * `<ServerConfig.baseDir>/fork-extensions/`.
 */

export type DisabledStoreAgent = "claude" | "codex";

interface StashedMcpEntry {
  readonly definition: unknown;
  readonly stashedAt: string;
}

const STASH_FILE = "disabled-claude-mcp.json";
const DISABLED_SKILLS_DIR = "disabled-skills";

const invalidInput = (summary: string, nextStep: string, rawOutput: string | null = null) =>
  new ForkExtensionsError({ problem: { reason: "invalidInput", summary, nextStep, rawOutput } });

const fileProblem = (path: string, cause: PlatformError.PlatformError): ForkExtensionsError =>
  new ForkExtensionsError({
    problem: {
      reason: cause.reason._tag === "PermissionDenied" ? "permissionDenied" : "commandFailed",
      summary: `Could not access ${path}.`,
      nextStep: "Check the folder's permissions and that no other program is using it, then retry.",
      rawOutput: cause.message,
    },
  });

const rootDir = Effect.fn("ForkExtensions.disabledStoreRoot")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return path.join(config.baseDir, "fork-extensions");
});

const JsonText = Schema.fromJsonString(Schema.Unknown);
const decodeJsonOption = Schema.decodeOption(JsonText);
const decodeJson = Schema.decodeEffect(JsonText);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readStash = Effect.fn("ForkExtensions.readStash")(function* () {
  const path = yield* Path.Path;
  const file = path.join(yield* rootDir(), STASH_FILE);
  const snapshot = yield* readWithFingerprint(file);
  if (snapshot.text.trim() === "") {
    return {
      file,
      fingerprint: snapshot.fingerprint,
      entries: {} as Record<string, StashedMcpEntry>,
    };
  }
  const parsed = yield* decodeJson(snapshot.text).pipe(
    Effect.mapError((cause) =>
      invalidInput(
        `${STASH_FILE} is not valid JSON.`,
        "Fix or delete the file in T3's fork-extensions folder, then retry.",
        String(cause),
      ),
    ),
  );
  if (!isRecord(parsed)) {
    return yield* invalidInput(
      `${STASH_FILE} does not hold an object.`,
      "Fix or delete the file in T3's fork-extensions folder, then retry.",
    );
  }
  return {
    file,
    fingerprint: snapshot.fingerprint,
    entries: parsed as Record<string, StashedMcpEntry>,
  };
});

const isJsonObject = (text: string): boolean => {
  const parsed = decodeJsonOption(text);
  return Option.isSome(parsed) && isRecord(parsed.value);
};

const writeStash = (
  stash: { readonly file: string; readonly fingerprint: string },
  entries: Record<string, StashedMcpEntry>,
) =>
  writeIfUnchanged(
    stash.file,
    stash.fingerprint,
    `${JSON.stringify(entries, null, 2)}\n`,
    isJsonObject,
  );

/** Saves the exact definition of a Claude MCP server so it can be re-added later. */
export const stashClaudeMcp = Effect.fn("ForkExtensions.stashClaudeMcp")(function* (
  name: string,
  _scope: "user",
  definition: unknown,
) {
  const stash = yield* readStash();
  const now = yield* Clock.currentTimeMillis;
  yield* writeStash(stash, {
    ...stash.entries,
    [name]: { definition, stashedAt: DateTime.formatIso(DateTime.makeUnsafe(now)) },
  });
});

/** Returns the stashed definition (or null) and removes it from the stash. */
export const takeClaudeMcp = Effect.fn("ForkExtensions.takeClaudeMcp")(function* (name: string) {
  const stash = yield* readStash();
  const entry = stash.entries[name];
  if (entry === undefined) return null;
  const { [name]: _removed, ...rest } = stash.entries;
  yield* writeStash(stash, rest);
  return entry.definition ?? null;
});

export const listStashedClaudeMcp = Effect.fn("ForkExtensions.listStashedClaudeMcp")(function* () {
  const stash = yield* readStash();
  return Object.fromEntries(
    Object.entries(stash.entries).map(([name, entry]) => [name, entry.definition]),
  ) as Record<string, unknown>;
});

/** Drops a stashed definition without returning it; no-op when absent. */
export const discardClaudeMcp = Effect.fn("ForkExtensions.discardClaudeMcp")(function* (
  name: string,
) {
  const stash = yield* readStash();
  if (!(name in stash.entries)) return;
  const { [name]: _removed, ...rest } = stash.entries;
  yield* writeStash(stash, rest);
});

const assertSkillName = (name: string) =>
  name === "" || name === "." || name === ".." || /[\\/]/.test(name)
    ? Effect.fail(
        invalidInput(
          `"${name}" is not a valid skill folder name.`,
          "Skill names must be a single folder name.",
        ),
      )
    : Effect.void;

const alreadyExists = (destination: string) =>
  new ForkExtensionsError({
    problem: {
      reason: "alreadyExists",
      summary: `${destination} already exists.`,
      nextStep: "Move or rename the existing folder, then retry.",
      rawOutput: null,
    },
  });

const moveFolder = Effect.fn("ForkExtensions.moveFolder")(function* (
  source: string,
  destination: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (
    yield* fs.exists(destination).pipe(Effect.mapError((cause) => fileProblem(destination, cause)))
  ) {
    return yield* alreadyExists(destination);
  }
  yield* fs
    .makeDirectory(path.dirname(destination), { recursive: true })
    .pipe(Effect.mapError((cause) => fileProblem(destination, cause)));
  yield* fs.rename(source, destination).pipe(
    // rename cannot cross devices (EXDEV: skills dir and T3's base dir may be on different
    // drives), so any rename failure falls back to copy then remove. If the copy also
    // fails the source is untouched; the partial destination is cleaned up.
    Effect.catch(() =>
      fs.copy(source, destination).pipe(
        Effect.tapError(() =>
          fs.remove(destination, { recursive: true, force: true }).pipe(Effect.ignore),
        ),
        Effect.flatMap(() => fs.remove(source, { recursive: true })),
      ),
    ),
    Effect.mapError((cause) => fileProblem(source, cause)),
  );
});

const stashedSkillDir = Effect.fn("ForkExtensions.stashedSkillDir")(function* (
  agent: DisabledStoreAgent,
) {
  const path = yield* Path.Path;
  return path.join(yield* rootDir(), DISABLED_SKILLS_DIR, agent);
});

/** Moves `<skillsDir>/<name>` to `disabled-skills/<agent>/<name>`. */
export const disableSkill = Effect.fn("ForkExtensions.disableSkill")(function* (
  agent: DisabledStoreAgent,
  skillsDir: string,
  name: string,
) {
  yield* assertSkillName(name);
  const path = yield* Path.Path;
  yield* moveFolder(path.join(skillsDir, name), path.join(yield* stashedSkillDir(agent), name));
});

/** Moves the skill back from `disabled-skills/<agent>/<name>` into `skillsDir`. */
export const enableSkill = Effect.fn("ForkExtensions.enableSkill")(function* (
  agent: DisabledStoreAgent,
  skillsDir: string,
  name: string,
) {
  yield* assertSkillName(name);
  const path = yield* Path.Path;
  yield* moveFolder(path.join(yield* stashedSkillDir(agent), name), path.join(skillsDir, name));
});

export const listDisabledSkills = Effect.fn("ForkExtensions.listDisabledSkills")(function* (
  agent: DisabledStoreAgent,
) {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* stashedSkillDir(agent);
  if (!(yield* fs.exists(dir).pipe(Effect.mapError((cause) => fileProblem(dir, cause))))) {
    return [] as ReadonlyArray<string>;
  }
  const names = yield* fs
    .readDirectory(dir)
    .pipe(Effect.mapError((cause) => fileProblem(dir, cause)));
  return names.toSorted() as ReadonlyArray<string>;
});
