import { describe, expect, it, vi } from "vite-plus/test";

import { startVisibleInterval } from "./visibleInterval";

function page(initial: DocumentVisibilityState) {
  const listeners = new Set<() => void>();
  const source = {
    visibilityState: initial,
    addEventListener: (_type: "visibilitychange", listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: "visibilitychange", listener: () => void) =>
      listeners.delete(listener),
  };
  const show = (state: DocumentVisibilityState) => {
    source.visibilityState = state;
    for (const listener of listeners) listener();
  };
  return { source, show, listeners };
}

describe("startVisibleInterval", () => {
  it("ticks only while visible and catches up when shown again", () => {
    using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
    vi.useFakeTimers();
    const tick = vi.fn();
    const { source, show, listeners } = page("visible");
    const stop = startVisibleInterval(tick, 1_000, source);

    expect(tick).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(2_000);
    expect(tick).toHaveBeenCalledTimes(2);

    show("hidden");
    vi.advanceTimersByTime(10_000);
    expect(tick).toHaveBeenCalledTimes(2);

    show("visible");
    expect(tick).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1_000);
    expect(tick).toHaveBeenCalledTimes(4);

    stop();
    vi.advanceTimersByTime(5_000);
    expect(tick).toHaveBeenCalledTimes(4);
    expect(listeners.size).toBe(0);
  });

  it("does not start a timer in a hidden page, nor tick on a quick return", () => {
    using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
    vi.useFakeTimers();
    const tick = vi.fn();
    const { source, show } = page("hidden");
    const stop = startVisibleInterval(tick, 1_000, source);
    vi.advanceTimersByTime(5_000);
    expect(tick).toHaveBeenCalledTimes(0);

    show("visible");
    // Hidden for long enough: it was overdue.
    expect(tick).toHaveBeenCalledTimes(1);
    show("hidden");
    vi.advanceTimersByTime(200);
    show("visible");
    expect(tick).toHaveBeenCalledTimes(1);
    stop();
  });
});
