import { userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { createRef, type ReactNode } from "react";

import { render } from "../../../test/render";

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  return { ...actual, primaryServerKeybindingsAtom: Atom.make([]) };
});
// One thread waits on a plan, so the block has a panel to open.
vi.mock(import("../../state/threads"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const { EnvironmentId, ProjectId, RunId, ThreadId } = await import("@t3tools/contracts");
  const shell = {
    environmentId: EnvironmentId.make("env-1"),
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Plan ready",
    archivedAt: null,
    deletedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingGuestMessageCount: 0,
    interactionMode: "plan",
    hasActionableProposedPlan: true,
    latestRun: {
      runId: RunId.make("run-1"),
      status: "completed",
      requestedAt: "2026-11-22T10:00:00.000Z",
      startedAt: "2026-11-22T10:00:00.000Z",
      completedAt: "2026-11-22T10:05:00.000Z",
      assistantMessageId: null,
    },
    runtime: null,
  } as unknown as EnvironmentThreadShell;
  return {
    ...actual,
    environmentThreadShells: {
      ...actual.environmentThreadShells,
      quietThreadShellsAtom: Atom.make<ReadonlyArray<EnvironmentThreadShell>>([shell]),
    },
  };
});
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentsWithScope: (environments) =>
    new Set(environments.map(({ environmentId }) => environmentId)),
}));

import { ComposerPromptEditorTiptap } from "~/components/ComposerPromptEditorTiptap";
import { DecisionsPanel } from "./DecisionsPanel";
import { NeedsYouBlock } from "./NeedsYouBlock";

async function renderOpenPanel(extra: ReactNode = null) {
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(
    await render(
      <>
        <NeedsYouBlock />
        <DecisionsPanel />
        <button type="button">Outside</button>
        {extra}
      </>,
    ),
  );
  const panel = () => screen.container.querySelector("#fork-decisions-panel");
  // It opens by itself the first time; a test before this one may have closed it.
  const block = screen.container.querySelector('[aria-controls="fork-decisions-panel"]')!;
  if (block.getAttribute("aria-expanded") !== "true") await userEvent.click(block);
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

  it("closes from the composer unless the composer's own menu takes Escape", async () => {
    let menuOpen = true;
    const { screen, panel } = await renderOpenPanel(
      <ComposerPromptEditorTiptap
        editorRef={createRef()}
        value=""
        cursor={0}
        richTextEnabled
        disabled={false}
        contextRecords={new Map()}
        skills={[]}
        placeholder=""
        onChange={() => {}}
        onPaste={() => {}}
        // As ChatComposer does: true only while an @, / or suggestion menu is open.
        onCommandKeyDown={(key) => key === "Escape" && menuOpen}
      />,
    );
    await using _screen = screen;
    await userEvent.click(screen.container.querySelector(".tiptap")!);
    await userEvent.keyboard("{Escape}");
    expect(panel()).not.toBeNull();
    menuOpen = false;
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(panel()).toBeNull());
  });
});
