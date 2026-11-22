/**
 * 技能名称 key 与 SKILL.md 扫描：把目录树映射为技能文件路径/名称集合。
 */
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { SkillDiagnostic } from "@zcode/shared";
import { walkSkillMarkdownPaths, SKILL_FILE_NAME } from "../skillDiscoveryWalk.js";
import { readFrontmatter } from "./skillFrontmatter.js";
import { exists, getUserAgentsSkillRoot, getUserZcodeSkillRoot } from "./skillPaths.js";

function normalizeSkillNameKey(name: string): string {
  return name.trim().toLowerCase();
}

async function readSkillNameKey(skillPath: string): Promise<string> {
  const fallbackName = basename(dirname(skillPath));
  try {
    const parsed = readFrontmatter(await readFile(skillPath, "utf-8"));
    const rawName = parsed.hasFrontmatter ? parsed.name.trim() : fallbackName;
    return normalizeSkillNameKey(rawName || fallbackName);
  } catch {
    return normalizeSkillNameKey(fallbackName);
  }
}

export async function collectSkillNameKeysInRoot(rootPath: string): Promise<Set<string>> {
  const nameKeys = new Set<string>();
  if (!(await exists(rootPath))) {
    return nameKeys;
  }
  const diagnostics: SkillDiagnostic[] = [];
  for (const skillPath of await collectSkillMarkdownPaths(rootPath, diagnostics)) {
    nameKeys.add(await readSkillNameKey(skillPath));
  }
  return nameKeys;
}

export async function isUserAgentsSkillCoveredByZcode(params: {
  skillPath: string;
  rootPath: string;
  userZcodeSkillNameKeys: Set<string>;
}): Promise<boolean> {
  const { skillPath, rootPath, userZcodeSkillNameKeys } = params;
  if (rootPath !== getUserAgentsSkillRoot()) {
    return false;
  }
  if (await exists(join(getUserZcodeSkillRoot(), basename(dirname(skillPath)), SKILL_FILE_NAME))) {
    return true;
  }
  return userZcodeSkillNameKeys.has(await readSkillNameKey(skillPath));
}

export async function collectSkillMarkdownPaths(
  rootPath: string,
  diagnostics: SkillDiagnostic[],
): Promise<string[]> {
  // 复用共享的有界遍历：支持分组目录，但排除 node_modules 等内容目录、限制深度、对软链按 realpath 去重，
  // 避免 Windows junction / 巨型依赖目录把单次扫描放大到数十秒。
  const discovered = new Set<string>();
  for await (const skillPath of walkSkillMarkdownPaths(rootPath, {
    onError: (path, error) => {
      diagnostics.push({
        code: "skill_scan_failed",
        severity: "warning",
        message: error instanceof Error ? error.message : `Failed to scan skill directory: ${path}`,
        path,
      });
    },
  })) {
    discovered.add(skillPath);
  }
  return [...discovered].sort((left, right) => left.localeCompare(right));
}
