import type { AgentMemoryScope } from "../subagent-profile.js";
import type { AgentColor } from "../subagents-types.js";

/**
 * Public metadata projection of a built-in ZCode agent.
 *
 * The runtime owns prompts and execution; Settings/Services consume only this stable
 * projection. Keeping the type here prevents the contract from depending on the catalog
 * implementation.
 */
export interface BuiltInAgentSummary {
  readonly name: string;
  readonly description: string;
  readonly color: AgentColor;
  readonly tools: readonly string[];
  readonly skills: readonly string[];
  readonly injectAgentsMd?: boolean;
  readonly memory?: AgentMemoryScope;
}

/** Read-only catalog consumed by Settings and Services. */
export interface SharedSubagentCatalogContract {
  readonly agents: readonly BuiltInAgentSummary[];
}
