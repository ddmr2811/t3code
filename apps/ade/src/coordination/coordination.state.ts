import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type ForkCoordinationEntry,
  type ProjectId,
  WS_METHODS,
} from "@t3tools/contracts";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime, environmentCatalog } from "../connection/runtime.ts";
import { environmentProjects } from "../state.ts";

export const forkCoordinationListQuery = createEnvironmentRpcQueryAtomFamily(
  connectionAtomRuntime,
  {
    label: "ade:fork-coordination:list",
    tag: WS_METHODS.forkCoordinationList,
    staleTimeMs: 15_000,
    idleTtlMs: 60_000,
  },
);

export const forkCoordinationUpsertCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "ade:fork-coordination:upsert",
  tag: WS_METHODS.forkCoordinationUpsert,
});

export const forkCoordinationRemoveCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "ade:fork-coordination:remove",
  tag: WS_METHODS.forkCoordinationRemove,
});

export function refreshCoordinationBoard(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
) {
  registry.refresh(forkCoordinationListQuery({ environmentId, input: {} }));
}

export const allCoordinationEntriesAtom = Atom.make((get) => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  const byEnv = new Map<EnvironmentId, ReadonlyArray<ForkCoordinationEntry>>();
  let loadingCount = 0;
  for (const [environmentId] of catalog.entries) {
    const result = get(forkCoordinationListQuery({ environmentId, input: {} }));
    if (result._tag === "Initial") loadingCount += 1;
    const value = AsyncResult.getOrElse(result, () => null);
    byEnv.set(environmentId, value?.entries ?? []);
  }
  return { byEnv, loadingCount };
}).pipe(Atom.withLabel("ade-all-coordination-entries"));

export const allEnvironmentProjectsAtom = Atom.make((get) => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  const projectsByEnv = new Map<
    EnvironmentId,
    ReadonlyMap<string, { readonly id: ProjectId; readonly title: string }>
  >();
  for (const [environmentId] of catalog.entries) {
    const index = get(environmentProjects.environmentProjectIndexAtom(environmentId));
    const map = new Map<string, { readonly id: ProjectId; readonly title: string }>();
    for (const [id, project] of index) {
      map.set(id, { id: project.id, title: project.title });
    }
    projectsByEnv.set(environmentId, map);
  }
  return projectsByEnv;
}).pipe(Atom.withLabel("ade-all-environment-projects"));
