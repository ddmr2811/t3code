import { createAssetEnvironmentAtoms } from "@t3tools/client-runtime/state/assets";
import { createAttachmentEnvironmentAtoms } from "@t3tools/client-runtime/state/attachments";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import { createOrchestrationEnvironmentAtoms } from "@t3tools/client-runtime/state/orchestration";
import { createEnvironmentProjectAtoms } from "@t3tools/client-runtime/state/projects";
import { createServerEnvironmentAtoms } from "@t3tools/client-runtime/state/server";
import { createEnvironmentSessionAtoms } from "@t3tools/client-runtime/state/session";
import {
  createEnvironmentThreadDetailAtoms,
  createEnvironmentThreadShellAtoms,
  createEnvironmentThreadStateAtoms,
  createThreadEnvironmentAtoms,
  createThreadFamilyAtoms,
} from "@t3tools/client-runtime/state/threads";
import {
  AuthForkGatewayScope,
  AuthOrchestrationOperateScope,
  AuthTerminalOperateScope,
  type EnvironmentId,
  sessionGrantsScope,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import {
  connectionAtomRuntime,
  environmentCatalog,
  environmentShell,
} from "./connection/runtime.ts";

export const environmentSession = createEnvironmentSessionAtoms(connectionAtomRuntime);
// Signed, short-lived URLs for attachments and tool images, minted over the session's socket.
export const assetEnvironment = createAssetEnvironmentAtoms(connectionAtomRuntime);
// Upload slots for the composer's images: a signed URL per file, then the bytes over HTTP.
export const attachmentEnvironment = createAttachmentEnvironmentAtoms(connectionAtomRuntime);
// Its hidden-thread tags keep a thread the user hides in T3 hidden here too.
// Also the machine's providers and models, for the composer's pickers.
export const serverEnvironment = createServerEnvironmentAtoms(connectionAtomRuntime, {
  initialConfigValueAtom: environmentSession.initialConfigValueAtom,
});
const threadFamilies = createThreadFamilyAtoms(connectionAtomRuntime, environmentShell.stateAtom);
export const threadEnvironment = createThreadEnvironmentAtoms(
  connectionAtomRuntime,
  threadFamilies.snapshotAtom,
);

export const environmentThreadShells = createEnvironmentThreadShellAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: threadEnvironment.snapshotAtom,
  hiddenThreadTagsAtom: serverEnvironment.hiddenThreadTagsAtom,
});

export const environmentThreadDetails = createEnvironmentThreadDetailAtoms(
  createEnvironmentThreadStateAtoms(connectionAtomRuntime).stateAtom,
);
// For a tool's output the snapshot left out; the timeline asks only when a row is opened.
export const orchestrationEnvironment = createOrchestrationEnvironmentAtoms(connectionAtomRuntime);

export const environmentProjects = createEnvironmentProjectAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: threadEnvironment.snapshotAtom,
});

/** Whether this ADE's session may operate on a machine; null while the session is still loading. */
export const operateAccessAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): "operate" | "read" | "unknown" | null => {
    const result = get(environmentSession.sessionStateAtom(environmentId));
    // A failed revalidation keeps the old session as its value; it no longer proves the grant.
    if (result._tag === "Failure") return "unknown";
    const session = AsyncResult.getOrElse(result, () => null);
    if (session === null) return null;
    return sessionGrantsScope(session, AuthOrchestrationOperateScope) ? "operate" : "read";
  }).pipe(Atom.withLabel(`ade-operate-access:${environmentId}`)),
);

/** Whether this ADE's session may run a shell on a machine: only if pairing asked for it. */
export const terminalAccessAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const result = get(environmentSession.sessionStateAtom(environmentId));
    if (result._tag === "Failure") return false;
    const session = AsyncResult.getOrElse(result, () => null);
    return session !== null && sessionGrantsScope(session, AuthTerminalOperateScope);
  }).pipe(Atom.withLabel(`ade-terminal-access:${environmentId}`)),
);

/** Whether this ADE's session may reach a machine's extension sidecars. */
export const gatewayAccessAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const result = get(environmentSession.sessionStateAtom(environmentId));
    if (result._tag === "Failure") return false;
    const session = AsyncResult.getOrElse(result, () => null);
    return session !== null && sessionGrantsScope(session, AuthForkGatewayScope);
  }).pipe(Atom.withLabel(`ade-gateway-access:${environmentId}`)),
);

let previousOperable: ReadonlySet<EnvironmentId> = new Set();
/** The machines where this ADE's session may answer: only those are asked to. */
export const operableEnvironmentIdsAtom = Atom.make((get) => {
  const next = new Set(
    [...enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))].filter(
      (environmentId) => get(operateAccessAtom(environmentId)) === "operate",
    ),
  );
  if (next.size === previousOperable.size && [...next].every((id) => previousOperable.has(id))) {
    return previousOperable;
  }
  previousOperable = next;
  return next;
}).pipe(Atom.withLabel("ade-operable-environments"));
