import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ForkExtensionsError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";
import {
  disableSkill,
  discardClaudeMcp,
  enableSkill,
  listDisabledSkills,
  listStashedClaudeMcp,
  stashClaudeMcp,
  takeClaudeMcp,
} from "./disabledStore.ts";

const layer = Layer.provideMerge(
  ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-disabled-store-" }),
  NodeServices.layer,
);

const withSkillsDir = <A, E, R>(
  body: (input: {
    readonly fs: FileSystem.FileSystem;
    readonly skillsDir: string;
    readonly path: Path.Path;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const skillsDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-skills-" });
    return yield* body({ fs, path, skillsDir });
  }).pipe(Effect.scoped);

const makeSkill = (fs: FileSystem.FileSystem, path: Path.Path, skillsDir: string, name: string) =>
  Effect.gen(function* () {
    yield* fs.makeDirectory(path.join(skillsDir, name), { recursive: true });
    yield* fs.writeFileString(path.join(skillsDir, name, "SKILL.md"), `# ${name}\n`);
  });

describe("disabledStore", () => {
  it.effect("stashes a Claude MCP definition, lists it, and take returns and removes it", () =>
    Effect.gen(function* () {
      const definition = { type: "stdio", command: "npx", args: ["-y", "thing"] };
      expect(yield* listStashedClaudeMcp()).toEqual({});
      yield* stashClaudeMcp("my server/1", "user", definition);
      yield* stashClaudeMcp("other", "user", { type: "http", url: "https://x" });
      expect(yield* listStashedClaudeMcp()).toEqual({
        "my server/1": definition,
        other: { type: "http", url: "https://x" },
      });
      expect(yield* takeClaudeMcp("my server/1")).toEqual(definition);
      expect(yield* takeClaudeMcp("my server/1")).toBeNull();
      expect(Object.keys(yield* listStashedClaudeMcp())).toEqual(["other"]);
      yield* discardClaudeMcp("other");
      yield* discardClaudeMcp("other");
      expect(yield* listStashedClaudeMcp()).toEqual({});
    }).pipe(Effect.provide(layer)),
  );

  it.effect("disables and enables a skill, keeping SKILL.md", () =>
    withSkillsDir(({ fs, path, skillsDir }) =>
      Effect.gen(function* () {
        yield* makeSkill(fs, path, skillsDir, "pdf");
        expect(yield* listDisabledSkills("claude")).toEqual([]);
        yield* disableSkill("claude", skillsDir, "pdf");
        expect(yield* fs.exists(path.join(skillsDir, "pdf"))).toBe(false);
        expect(yield* listDisabledSkills("claude")).toEqual(["pdf"]);
        expect(yield* listDisabledSkills("codex")).toEqual([]);
        yield* enableSkill("claude", skillsDir, "pdf");
        expect(yield* fs.readFileString(path.join(skillsDir, "pdf", "SKILL.md"))).toBe("# pdf\n");
        expect(yield* listDisabledSkills("claude")).toEqual([]);
      }),
    ).pipe(Effect.provide(layer)),
  );

  it.effect("enable with the destination taken fails with alreadyExists", () =>
    withSkillsDir(({ fs, path, skillsDir }) =>
      Effect.gen(function* () {
        yield* makeSkill(fs, path, skillsDir, "pdf");
        yield* disableSkill("claude", skillsDir, "pdf");
        yield* makeSkill(fs, path, skillsDir, "pdf");
        const error = yield* enableSkill("claude", skillsDir, "pdf").pipe(Effect.flip);
        expect(error).toBeInstanceOf(ForkExtensionsError);
        expect(error.problem.reason).toBe("alreadyExists");
        expect(yield* listDisabledSkills("claude")).toEqual(["pdf"]);
      }),
    ).pipe(Effect.provide(layer)),
  );

  it.effect("disable with the stash slot taken fails with alreadyExists", () =>
    withSkillsDir(({ fs, path, skillsDir }) =>
      Effect.gen(function* () {
        yield* makeSkill(fs, path, skillsDir, "pdf");
        yield* disableSkill("claude", skillsDir, "pdf");
        yield* makeSkill(fs, path, skillsDir, "pdf");
        const error = yield* disableSkill("claude", skillsDir, "pdf").pipe(Effect.flip);
        expect(error.problem.reason).toBe("alreadyExists");
        expect(yield* fs.exists(path.join(skillsDir, "pdf", "SKILL.md"))).toBe(true);
      }),
    ).pipe(Effect.provide(layer)),
  );

  it.effect("rejects skill names that escape the skills directory", () =>
    withSkillsDir(({ skillsDir }) =>
      Effect.gen(function* () {
        const error = yield* disableSkill("claude", skillsDir, "../evil").pipe(Effect.flip);
        expect(error.problem.reason).toBe("invalidInput");
      }),
    ).pipe(Effect.provide(layer)),
  );
});
