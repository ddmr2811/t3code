// Another tab of this ADE has its own open connections. When one tab pairs or removes a machine,
// the others load the stored machines again, in place: a page reload would lose a draft.
const channel =
  typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("ade-machines");

/** Tells this ADE's other tabs that the stored machines changed. The sender hears nothing. */
// oxlint-disable-next-line unicorn/require-post-message-target-origin -- A BroadcastChannel has none.
export const machinesChanged = () => channel?.postMessage(null);

/** Runs `listener` when another tab changed the stored machines; returns how to stop. */
export function onMachinesChanged(listener: () => void) {
  channel?.addEventListener("message", listener);
  return () => channel?.removeEventListener("message", listener);
}
