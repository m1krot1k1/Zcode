/**
 * prompt 中的技能激活：解析 `$skill-name` 引用、拼接激活块、写审计日志。
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { SkillSummary } from "@zcode/shared";
import { resolveUserHomeDir } from "./skillPaths.js";

const SKILL_SETTINGS_DIR = join(resolveUserHomeDir(), ".zcode", "v2");

export function collectMentionedSkillNames(prompt: string): Set<string> {
  const names = new Set<string>();
  for (const match of prompt.matchAll(/\$([a-z0-9]+(?:-[a-z0-9]+)*)/g)) {
    const name = match[1];
    if (name) {
      names.add(name);
    }
  }
  return names;
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function buildActivatedSkillsPromptBlock(skills: SkillSummary[]): string {
  return [
    "<available_skills>",
    ...skills.map((skill) =>
      [
        `<activated_skill name="${escapeXmlAttribute(skill.name)}" path="${escapeXmlAttribute(skill.path)}">`,
        skill.body,
        "</activated_skill>",
      ].join("\n"),
    ),
    "</available_skills>",
  ].join("\n");
}

export async function appendSkillsAuditLog(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  activatedSkillNames: string[];
}): Promise<void> {
  await mkdir(SKILL_SETTINGS_DIR, { recursive: true });
  await appendFile(
    join(SKILL_SETTINGS_DIR, "skills-audit.log"),
    `${JSON.stringify({
      createdAt: Date.now(),
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity ?? null,
      activatedSkillNames: params.activatedSkillNames,
    })}\n`,
    "utf-8",
  );
}
