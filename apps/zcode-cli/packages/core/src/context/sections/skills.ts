// ============================================================
// Skills Section Builder
// ============================================================

import type { SkillLoadOutcome, SkillMetadata } from "@zcode/contracts";
import type { ContextSection } from "../types.js";
import { estimateTokens } from "../utils.js";

const DEFAULT_SKILL_METADATA_BUDGET = 12_000;
const MAX_DESCRIPTION_CHARS = 160;

interface SkillsSectionOptions {
  outcome: SkillLoadOutcome;
  metadataBudget?: number;
}

export function buildSkillsSection(options: SkillsSectionOptions): ContextSection | null {
  if (options.outcome.skills.length === 0) {
    return null;
  }

  const content = buildSkillsContent(
    options.outcome.skills,
    options.metadataBudget ?? DEFAULT_SKILL_METADATA_BUDGET,
  );

  return {
    name: "Skills",
    source: "skills",
    injectionTarget: "meta_user",
    cacheHint: "dynamic",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}

function buildSkillsContent(skills: SkillMetadata[], budget: number): string {
  const lines = [
    "Installed skills currently available for this workspace:",
    "",
    "Choose an exact listed skill name when it matches the task, and load it with Skill if that tool is available to your role.",
    "If no available skill matches the task, use SkillSearch to search the public skills.sh marketplace; install a relevant, reputable result with SkillInstall, then load it with Skill.",
    "",
  ];

  const sortedSkills = [...skills].sort((a, b) =>
    skillDisplayName(a).localeCompare(skillDisplayName(b)),
  );
  // Progressive disclosure: keep full descriptions for the skills that fit, then fall
  // back to names only for the tail. This preserves useful routing hints instead of
  // dropping every description as soon as the catalog crosses the budget.
  let content = lines.join("\n");
  for (const skill of sortedSkills) {
    const line = formatSkillLine(skill, MAX_DESCRIPTION_CHARS);
    const nameLine = formatSkillNameLine(skill);
    const next = content.length + 1 + line.length <= budget ? line : nameLine;
    content += `\n${next}`;
  }
  return content;
}

function formatSkillNameLine(skill: SkillMetadata): string {
  return `- ${skillDisplayName(skill)}${bareAliasSuffix(skill)} (file: ${skill.path})`;
}

function formatSkillLine(skill: SkillMetadata, maxDescriptionChars: number): string {
  const description = skill.whenToUse
    ? `${skill.description} - ${skill.whenToUse}`
    : skill.description;
  const trimmed =
    description.length > maxDescriptionChars
      ? `${description.slice(0, maxDescriptionChars - 1)}...`
      : description;
  return `- ${skillDisplayName(skill)}: ${trimmed}${bareAliasSuffix(skill)} (file: ${skill.path})`;
}

function skillDisplayName(skill: SkillMetadata): string {
  return skill.qualifiedName ?? skill.name;
}

function bareAliasSuffix(skill: SkillMetadata): string {
  return skill.qualifiedName && skill.qualifiedName !== skill.name
    ? ` (also loadable as ${skill.name})`
    : "";
}
