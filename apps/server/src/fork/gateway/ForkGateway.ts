// Fork-only: the sidecars the owner declared for the extension gateway.
import type { ForkGatewayList } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";
import { type GatewayManifestRead, parseGatewayManifest } from "./manifest.ts";

export class ForkGateway extends Context.Service<
  ForkGateway,
  {
    /** Read afresh each time, so an edit needs no restart. Never fails: a missing file lists none. */
    readonly manifest: Effect.Effect<GatewayManifestRead>;
    readonly list: Effect.Effect<ForkGatewayList>;
  }
>()("t3/fork/gateway/ForkGateway") {}

/** @public */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(config.stateDir, "fork", "gateway.json");

  const manifest = fs.readFileString(filePath).pipe(
    Effect.map(parseGatewayManifest),
    Effect.tap((read) =>
      read.problem === undefined
        ? Effect.void
        : Effect.logWarning("fork gateway manifest refused", { problem: read.problem }),
    ),
    Effect.catch((error) =>
      Effect.succeed<GatewayManifestRead>(
        error.reason._tag === "NotFound"
          ? { extensions: [] }
          : { extensions: [], problem: `The manifest could not be read: ${error.message}` },
      ),
    ),
  );

  const list = manifest.pipe(
    Effect.map((read) => ({
      extensions: read.extensions.map(({ id, title, panelPath }) => ({
        id,
        ...(title === undefined ? {} : { title }),
        ...(panelPath === undefined ? {} : { panelPath }),
      })),
      ...(read.problem === undefined ? {} : { problem: read.problem }),
    })),
  );

  return ForkGateway.of({ manifest, list });
});

export const layer = Layer.effect(ForkGateway, make);
