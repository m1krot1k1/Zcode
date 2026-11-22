import type { AgentColor, SubAgentConfig } from "../subagents-types.js";
import { BUILT_IN_AGENT_NAMES } from "./builtInAgents.js";

/**
 * Tools a generated skill-agent starts with. Keep this in sync with the worker surface:
 * a skill may need to read, edit, run commands, delegate a bounded sub-problem, and load
 * its own instructions. The generated profile never gets root-only tools.
 */
export const SKILL_AGENT_TOOL_NAMES = [
  "CodeIndex",
  "Read",
  "Glob",
  "Grep",
  "Write",
  "Edit",
  "ApplyPatch",
  "MultiEdit",
  "Bash",
  "WebFetch",
  "WebSearch",
  "Task",
  "Skill",
  "SkillSearch",
  "SkillInstall",
  "InstallCapability",
  "TodoRead",
  "TodoWrite",
  "AskUserQuestion",
  "TaskOutput",
  "TaskStop",
] as const;

export interface SkillAgentSource {
  /** Canonical skill name as returned by the marketplace install. */
  readonly name: string;
  readonly description?: string;
  readonly whenToUse?: string;
}

export interface SkillAgentProfile {
  readonly agentName: string;
  readonly fileName: string;
  readonly config: SubAgentConfig;
  /** Set when the exact skill name was unavailable or unsafe. */
  readonly nameAdjusted: "built-in" | "invalid" | null;
}

const SKILL_AGENT_COLORS: readonly AgentColor[] = [
  "cyan",
  "blue",
  "green",
  "purple",
  "orange",
  "pink",
  "yellow",
  "red",
];

export function buildSkillAgentProfile(skill: SkillAgentSource): SkillAgentProfile {
  const canonical = skill.name.trim();
  const adjusted = normalizeSkillAgentName(canonical);
  const description = summarizeSkillDescription(skill);
  const config: SubAgentConfig = {
    name: adjusted.agentName,
    description,
    systemPrompt: [
      `Ты специализированный агент навыка «${canonical}».`,
      `Перед любым исследованием или изменением загрузи обязательный навык через Skill { skill: "${canonical}" } и следуй его инструкциям. Если загрузка не удалась или навык запрещён, сразу остановись со status=blocked; укажи точную ошибку и не продолжай без специализации, не используй другой профиль и не обходи ограничение.`,
      "Работай только в назначенной области, не расширяй права и не подменяй проверку отчётом.",
      "Верни результат, изменённые файлы и фактические проверки. Если заблокирован — status=blocked, evidence и следующий checkpoint.",
    ].join("\n"),
    color: colorForName(adjusted.agentName),
    tools: [...SKILL_AGENT_TOOL_NAMES],
    skills: uniqueSkillNames(canonical),
    includeInSwarm: true,
    maxTurns: 40,
    injectAgentsMd: true,
  };
  return {
    agentName: adjusted.agentName,
    fileName: `${adjusted.agentName.toLowerCase()}.md`,
    config,
    nameAdjusted: adjusted.reason,
  };
}

/**
 * Small, dependency-free serializer for generated profiles. It intentionally supports only
 * the fields a generated agent needs; user-edited profiles keep using the full service
 * serializer (including object-valued `mcpServers`).
 */
export function serializeSkillAgentMarkdown(config: SubAgentConfig): string {
  const lines = [
    `name: "${escapeYaml(config.name)}"`,
    `description: "${escapeYaml(config.description)}"`,
    `color: ${config.color ?? "cyan"}`,
    "tools:",
    ...(config.tools ?? []).map((tool) => `  - ${quoteYaml(tool)}`),
    "skills:",
    ...(config.skills ?? []).map((skill) => `  - ${quoteYaml(skill)}`),
    `includeInSwarm: ${config.includeInSwarm === true ? "true" : "false"}`,
    `maxTurns: ${config.maxTurns ?? 40}`,
    `injectAgentsMd: ${config.injectAgentsMd === true ? "true" : "false"}`,
  ];
  return `---\n${lines.join("\n")}\n---\n\n${config.systemPrompt.trim()}\n`;
}

function normalizeSkillAgentName(raw: string): {
  agentName: string;
  reason: SkillAgentProfile["nameAdjusted"];
} {
  const valid = /^[A-Za-z0-9-]+$/u.test(raw) && !raw.startsWith("-") && !raw.endsWith("-");
  if (valid && !isBuiltInName(raw)) {
    return { agentName: raw, reason: null };
  }
  if (valid && isBuiltInName(raw)) {
    // The built-in role owns its name. Keep the skill agent callable under a deterministic
    // suffix instead of overwriting the canonical runtime role.
    return { agentName: `${raw}-skill`, reason: "built-in" };
  }
  const sanitized = raw
    .trim()
    .replace(/[^A-Za-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 50);
  const agentName = sanitized.length > 0 ? sanitized : "skill-agent";
  return { agentName, reason: "invalid" };
}

function isBuiltInName(name: string): boolean {
  return (
    BUILT_IN_AGENT_NAMES.has(name) ||
    BUILT_IN_AGENT_NAMES.has(name.toLowerCase()) ||
    BUILT_IN_AGENT_NAMES.has(name.trim())
  );
}

function summarizeSkillDescription(skill: SkillAgentSource): string {
  const source = skill.description?.trim() || skill.whenToUse?.trim() || "Навык из skills.sh";
  const suffix = skill.whenToUse && skill.description ? ` Когда: ${skill.whenToUse.trim()}` : "";
  const full = `Специализированный агент навыка «${skill.name.trim()}»: ${source}${suffix}`;
  return full.length > 300 ? `${full.slice(0, 299)}…` : full;
}

function uniqueSkillNames(name: string): string[] {
  const names = [name];
  const separator = name.lastIndexOf(":");
  if (separator >= 0) {
    const bare = name.slice(separator + 1).trim();
    if (bare && bare !== name) names.push(bare);
  }
  return [...new Set(names)];
}

function colorForName(name: string): AgentColor {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return SKILL_AGENT_COLORS[hash % SKILL_AGENT_COLORS.length]!;
}

function quoteYaml(value: string): string {
  return /^[A-Za-z0-9_./@*-]+$/u.test(value) ? value : `"${escapeYaml(value)}"`;
}

function escapeYaml(value: string): string {
  return value
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, '\\"')
    .replace(/\n/gu, "\\n")
    .replace(/\r/gu, "\\r");
}
