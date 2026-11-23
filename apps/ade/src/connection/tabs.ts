// Another tab of this ADE keeps its own copy of the machines and its own open connections. When
// one tab pairs or removes a machine, the others start over from what is stored.
const channel =
  typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("ade-machines");
channel?.addEventListener("message", () => window.location.reload());

/** Tells this ADE's other tabs that the stored machines changed. The sender hears nothing. */
// oxlint-disable-next-line unicorn/require-post-message-target-origin -- A BroadcastChannel has none.
export const machinesChanged = () => channel?.postMessage(null);
