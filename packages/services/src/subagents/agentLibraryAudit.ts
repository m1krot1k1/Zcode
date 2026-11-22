import type { AgentSummary, SkillSummary } from "@zcode/shared";

/**
 * Agent Librarian audit for the skill→agent lifecycle.
 *
 * The audit is read-only and deterministic: it reports drift between installed skills
 * and agent profiles, but never deletes or rewrites a user profile. Backfill of missing
 * marketplace agents stays in the install/reconcile path, where it is idempotent.
 */

const GENERATED_SKILL_AGENT_MARKER = "специализированный агент навыка";

export interface OrphanedSkillAgent {
  agentName: string;
  skillName: string;
  path: string;
}

export interface AgentWithMissingSkills {
  agentName: string;
  missingSkills: string[];
  path: string;
}

export interface SkillWithoutAgent {
  skillName: string;
  path: string;
}

export interface AgentLibraryAudit {
  generatedSkillAgents: number;
  orphanedSkillAgents: OrphanedSkillAgent[];
  agentsWithMissingSkills: AgentWithMissingSkills[];
  skillsWithoutAgent: SkillWithoutAgent[];
}

function normalizeSkillReference(name: string): string {
  const trimmed = name.trim();
  const separator = trimmed.lastIndexOf(":");
  return (separator >= 0 ? trimmed.slice(separator + 1) : trimmed).trim();
}

function isGeneratedSkillAgent(agent: AgentSummary): boolean {
  return (
    agent.source === "user" &&
    (agent.skills?.length ?? 0) > 0 &&
    agent.systemPrompt.toLowerCase().includes(GENERATED_SKILL_AGENT_MARKER)
  );
}

function isMarketplaceSkillPath(path: string): boolean {
  return /[\\/]\.agents[\\/]skills[\\/]/u.test(path) && !/[\\/]\.zcode[\\/]skills[\\/]/u.test(path);
}

export function auditAgentSkillLibrary(input: {
  agents: readonly AgentSummary[];
  skills: readonly SkillSummary[];
}): AgentLibraryAudit {
  const installed = new Set(
    input.skills.map((skill) => normalizeSkillReference(skill.name).toLowerCase()),
  );
  const referenced = new Set<string>();
  const orphanedSkillAgents: OrphanedSkillAgent[] = [];
  const agentsWithMissingSkills: AgentWithMissingSkills[] = [];
  let generatedSkillAgents = 0;

  for (const agent of input.agents) {
    const agentSkills = (agent.skills ?? []).map(normalizeSkillReference).filter(Boolean);
    const missingSkills = agentSkills.filter((skill) => !installed.has(skill.toLowerCase()));
    if (missingSkills.length > 0) {
      agentsWithMissingSkills.push({ agentName: agent.name, missingSkills, path: agent.path });
    }
    for (const skill of agentSkills) referenced.add(skill.toLowerCase());
    if (!isGeneratedSkillAgent(agent)) continue;
    generatedSkillAgents += 1;
    const primarySkill = agentSkills[0];
    if (primarySkill && !installed.has(primarySkill.toLowerCase())) {
      orphanedSkillAgents.push({
        agentName: agent.name,
        skillName: primarySkill,
        path: agent.path,
      });
    }
  }

  const skillsWithoutAgent = input.skills
    .filter((skill) => skill.enabled)
    .filter((skill) => !skill.pluginName && skill.scope !== "plugin")
    .filter((skill) => isMarketplaceSkillPath(skill.path))
    .filter((skill) => !referenced.has(normalizeSkillReference(skill.name).toLowerCase()))
    .map((skill) => ({ skillName: skill.name, path: skill.path }));

  return {
    generatedSkillAgents,
    orphanedSkillAgents,
    agentsWithMissingSkills,
    skillsWithoutAgent,
  };
}
