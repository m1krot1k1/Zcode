import {
  BUILT_IN_AGENT_NAMES,
  BUILT_IN_AGENT_SUMMARIES,
  createAgentStateId,
  modelSelectionSchema,
  type AgentSummary,
  type BuiltInSubagentModelSelectionOverrides,
} from "@zcode/shared";

export { BUILT_IN_AGENT_NAMES };

export function createBuiltInAgents(
  modelSelectionOverrides: BuiltInSubagentModelSelectionOverrides = {},
): AgentSummary[] {
  const exploreOverride = modelSelectionOverrides.Explore;
  return [
    {
      id: createAgentStateId({
        name: "Explore",
        scope: "built-in",
        source: "built-in",
      }),
      name: "Explore",
      description: "Read-only search agent for broad fan-out searches.",
      color: "cyan",
      injectAgentsMd: false,
      modelSelection: exploreOverride,
      modelSelectionOverride: exploreOverride,
      systemPrompt: "",
      tools: ["Bash", "Glob", "Grep", "Read", "WebFetch", "WebSearch", "TodoWrite"],
      path: "built-in:Explore",
      scope: "built-in",
      source: "built-in",
      enabled: true,
      readOnly: true,
    },
    ...BUILT_IN_AGENT_SUMMARIES.map((agent): AgentSummary => {
      // Only the router roles plus Explore/general-purpose are model-overridable today;
      // workers inherit the session model. The summary still exposes tools/skills so the
      // Settings roster can show what each specialized role actually owns.
      const override =
        modelSelectionOverrides[agent.name as keyof BuiltInSubagentModelSelectionOverrides];
      return {
        id: createAgentStateId({
          name: agent.name,
          scope: "built-in",
          source: "built-in",
        }),
        name: agent.name,
        description: agent.description,
        color: agent.color,
        injectAgentsMd: agent.injectAgentsMd,
        ...(override
          ? {
              modelSelection: override,
              modelSelectionOverride: override,
            }
          : {}),
        systemPrompt: "",
        tools: [...agent.tools],
        skills: [...agent.skills],
        path: `built-in:${agent.name}`,
        scope: "built-in",
        source: "built-in",
        enabled: true,
        readOnly: true,
      };
    }),
  ];
}

export function normalizeBuiltInSelectionOverrides(
  structured: unknown,
): BuiltInSubagentModelSelectionOverrides {
  const result: BuiltInSubagentModelSelectionOverrides = {};
  const structuredRecord = isRecord(structured) ? structured : {};
  // Keep the reader aligned with the state migration and the Settings UI: start/orchestrator
  // are real router roles, and dropping their override here silently reverted a user's fast
  // router model to the expensive session model on every Host restart.
  for (const name of ["Explore", "general-purpose", "start", "orchestrator"] as const) {
    const selection = modelSelectionSchema.safeParse(structuredRecord[name]).data;
    if (selection) result[name] = selection;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
