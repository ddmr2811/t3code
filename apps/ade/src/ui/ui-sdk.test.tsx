import { definePrimitive } from "@ui-sdk/core";
import { createParts } from "@ui-sdk/react/primitive";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { agentTools, createAdeUiAgent, registerAdeWebMcpTools } from "./agent.ts";
import { cn } from "./utils.ts";

const filterToggle = definePrimitive({
  name: "ade-filter-toggle",
  state: () => ({ pressed: false }),
  api: (context) => ({
    toggle: () => context.store.set({ pressed: !context.store.get().pressed }),
  }),
  slots: (slot) => ({
    trigger: slot({
      attrs: (state) => ({
        type: "button",
        "aria-pressed": state.pressed ? "true" : "false",
        "data-pressed": state.pressed ? "" : undefined,
      }),
      press: ({ api }) => api.toggle(),
    }),
  }),
  agent: { actions: ["toggle"] },
});

const parts = createParts(filterToggle, { trigger: "button" });
const FilterToggle = parts.Root;
const FilterToggleTrigger = parts.Trigger;

describe("ADE shadcn + UI SDK setup", () => {
  it("merges Tailwind classes cleanly via cn()", () => {
    expect(cn("px-2 py-1 text-muted-foreground", "px-4")).toBe("py-1 text-muted-foreground px-4");
  });

  it("renders a @ui-sdk/core primitive through @ui-sdk/react with ARIA state", () => {
    const html = renderToStaticMarkup(
      <FilterToggle>
        <FilterToggleTrigger className={cn("rounded-md", "bg-card")}>
          Solo pendientes
        </FilterToggleTrigger>
      </FilterToggle>,
    );
    expect(html).toContain('data-slot="ade-filter-toggle-trigger"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain("Solo pendientes");
  });

  it("exposes UI SDK agent tools and creates a guarded agent bridge", () => {
    const toolNames = agentTools.map((tool) => tool.name);
    expect(toolNames).toEqual(expect.arrayContaining(["snapshot", "act", "query"]));
    const agent = createAdeUiAgent();
    expect(typeof agent.snapshot).toBe("function");
    expect(typeof agent.act).toBe("function");
    expect(typeof agent.query).toBe("function");
    const unregister = registerAdeWebMcpTools(agent);
    expect(typeof unregister).toBe("function");
    unregister();
  });
});
