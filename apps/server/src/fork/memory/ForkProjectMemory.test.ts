import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { FORK_MEMORY_ESSENTIAL_MAX_BYTES, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerConfig from "../../config.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ForkProjectMemory from "./ForkProjectMemory.ts";

const projectA = ProjectId.make("proj-a");
const projectB = ProjectId.make("proj-b");

const withMemory = <A, E>(
  use: (memory: ForkProjectMemory.ForkProjectMemory["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    return yield* use(yield* ForkProjectMemory.ForkProjectMemory);
  }).pipe(
    Effect.provide(
      ForkProjectMemory.layer.pipe(
        Layer.provideMerge(
          ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-fork-memory-test-" }),
        ),
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(
          Layer.mock(ProjectService.ProjectService)({
            getById: (projectId) =>
              Effect.succeed(
                projectId === projectA || projectId === projectB
                  ? Option.some({ id: projectId } as never)
                  : Option.none(),
              ),
          }),
        ),
      ),
    ),
    Effect.scoped,
  );

describe("ForkProjectMemory", () => {
  it.effect("caps each project's essential notes at 8 KB of text", () =>
    withMemory((memory) =>
      Effect.gen(function* () {
        // "ñ" is two UTF-8 bytes, so the cap counts bytes, not characters: 4 × 2000 + 192 = 8192.
        const wide = "ñ".repeat(1000);
        for (const text of [
          wide,
          wide,
          wide,
          wide,
          "a".repeat(FORK_MEMORY_ESSENTIAL_MAX_BYTES - 8000),
        ]) {
          yield* memory.upsert({ projectId: projectA, text, inclusion: "essential" }, "user");
        }
        const over = { projectId: projectA, text: "x", inclusion: "essential" } as const;
        expect(yield* memory.upsert(over, "agent").pipe(Effect.flip)).toMatchObject({
          reason: "limitExceeded",
        });
        // The same note still fits as searchable, and another project has its own budget.
        yield* memory.upsert({ ...over, inclusion: "searchable" }, "agent");
        yield* memory.upsert({ ...over, projectId: projectB }, "agent");
      }),
    ),
  );

  it.effect("never reads, edits, merges or removes another project's notes", () =>
    withMemory((memory) =>
      Effect.gen(function* () {
        const other = yield* memory.upsert(
          { projectId: projectB, text: "Secreto de B", inclusion: "essential" },
          "user",
        );
        const mine = yield* memory.upsert(
          { projectId: projectA, text: "Nota de A", inclusion: "searchable" },
          "agent",
        );

        expect((yield* memory.search(projectA, "secreto")).total).toBe(0);
        expect(yield* memory.essentials(projectA)).toEqual([]);
        expect(
          yield* memory
            .upsert(
              { id: other.id, projectId: projectA, text: "Robada", inclusion: "searchable" },
              "agent",
            )
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "notFound" });
        expect(
          yield* memory
            .upsert({ projectId: projectA, text: "Fusión", inclusion: "searchable" }, "agent", [
              mine.id,
              other.id,
            ])
            .pipe(Effect.flip),
        ).toMatchObject({ reason: "notFound" });
        expect((yield* memory.remove({ projectId: projectA, id: other.id })).removed).toBe(false);

        expect((yield* memory.list({ projectId: projectB })).notes).toEqual([other]);
        expect((yield* memory.list({ projectId: projectA })).notes).toEqual([mine]);
      }),
    ),
  );

  it.effect("lets an agent merge only searchable agent notes, never the user's or essentials", () =>
    withMemory((memory) =>
      Effect.gen(function* () {
        const save = (
          text: string,
          origin: "user" | "agent",
          inclusion: "essential" | "searchable",
        ) => memory.upsert({ projectId: projectA, text, inclusion }, origin);
        const fromUser = yield* save("Despliegue solo los viernes", "user", "searchable");
        const promoted = yield* save("Usa pnpm", "agent", "essential");
        const fromAgent = yield* save("Tests con Vitest", "agent", "searchable");

        const agentNote = yield* save("Puerto 3000", "agent", "searchable");
        const correctedByUser = yield* memory.upsert(
          { id: agentNote.id, projectId: projectA, text: "Puerto 3001", inclusion: "searchable" },
          "user",
        );

        for (const protectedNote of [fromUser, promoted, correctedByUser]) {
          expect(
            yield* memory
              .upsert({ projectId: projectA, text: "Fusión", inclusion: "searchable" }, "agent", [
                protectedNote.id,
              ])
              .pipe(Effect.flip),
          ).toMatchObject({ reason: "invalidInput" });
        }
        yield* memory.upsert(
          { projectId: projectA, text: "Tests con Vitest y Playwright", inclusion: "searchable" },
          "agent",
          [fromAgent.id],
        );
        expect(
          (yield* memory.list({ projectId: projectA })).notes.map((note) => note.id),
        ).not.toContain(fromAgent.id);
        expect((yield* memory.list({ projectId: projectA })).notes.map((note) => note.id)).toEqual(
          expect.arrayContaining([fromUser.id, promoted.id]),
        );
      }),
    ),
  );

  it.effect("finds notes that contain every word, in any case", () =>
    withMemory((memory) =>
      Effect.gen(function* () {
        for (const text of ["El despliegue va por Fly", "Despliegue manual", "Fly cobra aparte"]) {
          yield* memory.upsert({ projectId: projectA, text, inclusion: "searchable" }, "agent");
        }
        const found = yield* memory.search(projectA, "fly DESPLIEGUE");
        expect(found.notes.map((note) => note.text)).toEqual(["El despliegue va por Fly"]);
        expect((yield* memory.search(projectA, "")).total).toBe(3);
      }),
    ),
  );
});
