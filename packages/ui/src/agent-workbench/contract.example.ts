import type { AgentWorkbenchViewProps } from "./contract.js";

/** The dashboard always receives the owning workspace identity from the shell. */
export const exampleAgentWorkbenchProps: AgentWorkbenchViewProps = {
  workspacePath: "/path/to/workspace",
  workspaceIdentity: "local-workspace",
};
