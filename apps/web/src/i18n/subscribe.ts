// Apart from runtime.ts so the terminal surface the ADE shares does not pull in web settings.
const listeners = new Set<() => void>();

export function subscribeI18n(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyI18n(): void {
  for (const listener of listeners) listener();
}
