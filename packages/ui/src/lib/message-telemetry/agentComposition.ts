import type { AgentComposition } from "./types.js";

export function composeAgentComposition(input: {
  hasForegroundSubagentResult: boolean;
  hasBackgroundSubagentResult: boolean;
  hasWorkflowResult: boolean;
}): AgentComposition {
  const parts = [
    ...(input.hasForegroundSubagentResult ? ["fg"] : []),
    ...(input.hasBackgroundSubagentResult ? ["bg"] : []),
    ...(input.hasWorkflowResult ? ["wf"] : []),
  ];
  return parts.length === 0 ? "main_only" : (`main_plus_${parts.join("_")}` as AgentComposition);
}
