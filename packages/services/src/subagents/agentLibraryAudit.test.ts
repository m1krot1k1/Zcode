import { describe, expect, it } from "vitest";
import type { AgentSummary, SkillSummary } from "@zcode/shared";
import { auditAgentSkillLibrary } from "./agentLibraryAudit.js";

function agent(overrides: Partial<AgentSummary>): AgentSummary {
  return {
    id: overrides.id ?? overrides.name ?? "agent",
    name: overrides.name ?? "agent",
    description: "",
    systemPrompt: "",
    path: overrides.path ?? "/home/.zcode/agents/agent.md",
    scope: "user",
    source: "user",
    enabled: true,
    ...overrides,
  };
}

function skill(overrides: Partial<SkillSummary>): SkillSummary {
  return {
    id: overrides.id ?? overrides.name ?? "skill",
    name: overrides.name ?? "skill",
    description: "",
    body: "",
    path: overrides.path ?? "/repo/.agents/skills/skill/SKILL.md",
    scope: "workspace",
    enabled: true,
    ...overrides,
  };
}

const generatedPrompt = "Ты специализированный агент навыка «x».";

describe("agent library audit", () => {
  it("reports a generated skill agent whose skill disappeared", () => {
    const audit = auditAgentSkillLibrary({
      agents: [
        agent({
          name: "orphan",
          skills: ["missing-skill"],
          systemPrompt: generatedPrompt,
        }),
      ],
      skills: [],
    });
    expect(audit.orphanedSkillAgents).toEqual([
      {
        agentName: "orphan",
        skillName: "missing-skill",
        path: "/home/.zcode/agents/agent.md",
      },
    ]);
    expect(audit.agentsWithMissingSkills[0]?.missingSkills).toEqual(["missing-skill"]);
  });

  it("does not mark hand-edited agents as generated", () => {
    const audit = auditAgentSkillLibrary({
      agents: [
        agent({
          name: "custom",
          skills: ["missing-skill"],
          systemPrompt: "Custom review instructions",
        }),
      ],
      skills: [],
    });
    expect(audit.generatedSkillAgents).toBe(0);
    expect(audit.orphanedSkillAgents).toEqual([]);
    expect(audit.agentsWithMissingSkills).toHaveLength(1);
  });

  it("reports an enabled marketplace skill without a matching agent", () => {
    const audit = auditAgentSkillLibrary({
      agents: [agent({ name: "other", skills: ["other"] })],
      skills: [
        skill({ name: "frontend-design", path: "/repo/.agents/skills/frontend-design/SKILL.md" }),
        skill({
          name: "disabled-skill",
          enabled: false,
          path: "/repo/.agents/skills/disabled-skill/SKILL.md",
        }),
        skill({ name: "plugin-skill", pluginName: "p", path: "/repo/.agents/skills/p/SKILL.md" }),
      ],
    });
    expect(audit.skillsWithoutAgent.map((entry) => entry.skillName)).toEqual(["frontend-design"]);
  });

  it("resolves plugin-qualified skill references to their bare alias", () => {
    const audit = auditAgentSkillLibrary({
      agents: [agent({ name: "plugin-user", skills: ["market:frontend-design"] })],
      skills: [
        skill({ name: "frontend-design", path: "/repo/.agents/skills/frontend-design/SKILL.md" }),
      ],
    });
    expect(audit.agentsWithMissingSkills).toEqual([]);
    expect(audit.skillsWithoutAgent).toEqual([]);
  });
});
