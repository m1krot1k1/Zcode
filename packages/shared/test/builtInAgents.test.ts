import { describe, expect, it } from "vitest";
import {
  BUILT_IN_AGENT_NAMES,
  BUILT_IN_AGENT_SUMMARIES,
} from "../src/subagent-catalog/builtInAgents.js";
import { subagentRuntimeStateSchema } from "../src/subagent-catalog/runtimeConfig.js";

const selection = { providerId: "custom-openai", modelId: "glm-5.2" };

describe("built-in agent catalog", () => {
  it("exposes the full specialized roster, not only Explore", () => {
    expect(BUILT_IN_AGENT_SUMMARIES.map((agent) => agent.name)).toEqual([
      "start",
      "orchestrator",
      "researcher",
      "debugger",
      "implementer",
      "coder",
      "frontend-coder",
      "backend-coder",
      "infra-coder",
      "reviewer",
      "security-reviewer",
      "test-engineer",
      "evaluator",
      "self-improver",
      "knowledge-curator",
      "subagent-factory",
    ]);
    expect(BUILT_IN_AGENT_NAMES).toContain("Explore");
    for (const agent of BUILT_IN_AGENT_SUMMARIES) {
      expect(BUILT_IN_AGENT_NAMES).toContain(agent.name);
      expect(agent.skills.length).toBeGreaterThan(0);
    }
    expect(BUILT_IN_AGENT_SUMMARIES.find((agent) => agent.name === "coder")?.skills).toContain(
      "code-craft",
    );
  });

  it("keeps router model overrides through the formal runtime-state reader", () => {
    const parsed = subagentRuntimeStateSchema.parse({
      disabledAgentIds: [],
      builtInModelSelectionOverrides: {
        Explore: selection,
        start: selection,
        orchestrator: { ...selection, options: { reasoningLevel: "low" } },
      },
      pluginAgentModelSelectionOverrides: {},
    });
    expect(parsed.builtInModelSelectionOverrides).toEqual({
      Explore: selection,
      start: selection,
      orchestrator: { ...selection, options: { reasoningLevel: "low" } },
    });
  });
});
