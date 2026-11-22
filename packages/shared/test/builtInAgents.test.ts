import { describe, expect, it } from "vitest";
import {
  BUILT_IN_AGENT_NAMES,
  BUILT_IN_AGENT_SUMMARIES,
} from "../src/subagent-catalog/builtInAgents.js";
import { subagentRuntimeStateSchema } from "../src/subagent-catalog/runtimeConfig.js";
import {
  buildSkillAgentProfile,
  serializeSkillAgentMarkdown,
} from "../src/subagent-catalog/skillAgent.js";

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
      "architect",
      "planner",
      "data-engineer",
      "ml-engineer",
      "mobile-coder",
      "performance-engineer",
      "migration-engineer",
      "docs-writer",
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

  it("builds a persisted agent from a marketplace skill with the same name", () => {
    const profile = buildSkillAgentProfile({
      name: "frontend-design",
      description: "Designs distinctive interfaces from existing components.",
      whenToUse: "Use for UI direction and visual polish.",
    });
    expect(profile.agentName).toBe("frontend-design");
    expect(profile.nameAdjusted).toBeNull();
    expect(profile.config.skills).toEqual(["frontend-design"]);
    expect(profile.config.tools).toContain("Skill");
    expect(profile.config.includeInSwarm).toBe(true);
    expect(serializeSkillAgentMarkdown(profile.config)).toContain('name: "frontend-design"');
    expect(serializeSkillAgentMarkdown(profile.config)).toContain("frontend-design");
  });

  it("keeps built-in role names and unsafe skill names callable without overwriting them", () => {
    const reserved = buildSkillAgentProfile({ name: "reviewer", description: "Review skill" });
    expect(reserved.agentName).toBe("reviewer-skill");
    expect(reserved.nameAdjusted).toBe("built-in");
    const invalid = buildSkillAgentProfile({ name: "@scope/skill", description: "Scoped" });
    expect(invalid.agentName).toBe("scope-skill");
    expect(invalid.nameAdjusted).toBe("invalid");
  });
});
