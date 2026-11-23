import { EnvironmentId } from "@t3tools/contracts";

// Another tab of this ADE has its own open connections. When one tab pairs or removes a machine,
// the others take in what is stored for that machine, in place: a page reload would lose a draft.
const channel =
  typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("ade-machines");

/** Tells this ADE's other tabs that a stored machine changed. The sender hears nothing. */
export const machinesChanged = (environmentId: EnvironmentId) =>
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- A BroadcastChannel has none.
  channel?.postMessage(environmentId);

/** Runs `listener` when another tab changed a stored machine; returns how to stop. */
export function onMachinesChanged(listener: (environmentId: EnvironmentId) => void) {
  const onMessage = (event: MessageEvent) => {
    if (typeof event.data === "string") listener(EnvironmentId.make(event.data));
  };
  channel?.addEventListener("message", onMessage);
  return () => channel?.removeEventListener("message", onMessage);
}
