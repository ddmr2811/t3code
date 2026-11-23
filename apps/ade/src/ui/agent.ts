import { agentTools, createAgent, registerTools } from "@ui-sdk/react/agent";

type AdeUiAgent = ReturnType<typeof createAgent>;
type AdeUiAgentAllow = NonNullable<NonNullable<Parameters<typeof createAgent>[0]>["allow"]>;

/**
 * Creates a UI SDK agent bridge for ADE controls.
 * Any step targeting a `data-agent-confirm` control is refused by default unless
 * `onConfirm` explicitly approves it.
 */
export function createAdeUiAgent(onConfirm?: AdeUiAgentAllow): AdeUiAgent {
  return createAgent({
    allow: (step, context) => {
      if (!step.confirm) return true;
      return onConfirm ? onConfirm(step, context) : false;
    },
  });
}

/**
 * Registers the UI SDK tools with browser WebMCP (`document.modelContext`) when available.
 * Returns a cleanup callback; no-ops in browsers without WebMCP support.
 */
export function registerAdeWebMcpTools(agent: AdeUiAgent): () => void {
  return registerTools(agent, { allow: () => true });
}

export { agentTools };
