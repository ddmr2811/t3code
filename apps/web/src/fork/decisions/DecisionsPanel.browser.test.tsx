import { userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  return { ...actual, primaryServerKeybindingsAtom: Atom.make([]) };
});

import { DecisionsPanel } from "./DecisionsPanel";
import { NeedsYouBlock } from "./NeedsYouBlock";

async function renderOpenPanel() {
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(
    await render(
      <>
        <NeedsYouBlock />
        <DecisionsPanel />
        <button type="button">Outside</button>
      </>,
    ),
  );
  const panel = () => screen.container.querySelector("#fork-decisions-panel");
  await userEvent.click(screen.container.querySelector('[aria-controls="fork-decisions-panel"]')!);
  await vi.waitFor(() => expect(panel()).not.toBeNull());
  // Focus stays outside the panel, as it does when the panel opens by itself.
  await userEvent.click(screen.getByRole("button", { name: "Outside" }));
  stack.move();
  return { screen, panel };
}

describe("decisions panel Escape", () => {
  it("closes the panel when focus is elsewhere in the window", async () => {
    const { screen, panel } = await renderOpenPanel();
    await using _screen = screen;
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(panel()).toBeNull());
  });

  it("leaves Escape to whoever took it first", async () => {
    const { screen, panel } = await renderOpenPanel();
    await using _screen = screen;
    // A dialog or menu closes on a document listener and prevents the default.
    const takeEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") event.preventDefault();
    };
    document.addEventListener("keydown", takeEscape);
    try {
      await userEvent.keyboard("{Escape}");
      expect(panel()).not.toBeNull();
    } finally {
      document.removeEventListener("keydown", takeEscape);
    }
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(panel()).toBeNull());
  });
});
