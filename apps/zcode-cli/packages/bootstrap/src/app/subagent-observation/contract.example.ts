import type { SubagentObservation } from "./contract.js";

/** Read the current page of ended and running child sessions for the TUI. */
export async function exampleCliSubagentObservation(
  observation: SubagentObservation,
): Promise<Awaited<ReturnType<SubagentObservation["readSubagents"]>>> {
  return observation.readSubagents({ endedLimit: 20 });
}
