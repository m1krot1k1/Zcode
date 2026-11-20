/**
 * 技能发现：合并 workspace/用户/插件根，校验 SKILL.md，产出 SkillSummary 与诊断。
 */
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { SkillDiagnostic, SkillScope, SkillSummary, ZCodeProvider } from "@zcode/shared";
import { normalizeSkillConfigPath } from "./cliConfig.js";
import { MAX_DESCRIPTION_LENGTH, readFrontmatter, readSkillMetadata } from "./skillFrontmatter.js";
import type { SkillMetadataCache } from "./skillMetadataCache.js";
import {
  dedupeRoots,
  dedupeScanRootsByRealpath,
  exists,
  getUserAgentsSkillRoot,
  getUserZcodeSkillRoot,
  resolveAncestorWorkspaceRoots,
} from "./skillPaths.js";
import {
  collectSkillMarkdownPaths,
  collectSkillNameKeysInRoot,
  isUserAgentsSkillCoveredByZcode,
} from "./skillScan.js";
import { resolvePluginSkillRootDescriptors, type SkillRootDescriptor } from "./pluginRoots.js";

interface DiscoverResult {
  skills: SkillSummary[];
  diagnostics: SkillDiagnostic[];
}

export interface DiscoverSkillsOptions {
  /**
   * Кеш `_meta.json` (создаётся владельцем сервиса). Без него discovery работает
   * как раньше: тело SKILL.md и `_meta.json` читаются на каждый вызов.
   */
  metadataCache?: SkillMetadataCache;
}

function hashStableIdPart(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function buildSkillId(params: {
  provider: ZCodeProvider;
  scope: SkillScope;
  name: string;
  path: string;
}): string {
  return `${params.provider}:${params.scope}:${params.name}:${hashStableIdPart(params.path)}`;
}

export async function discoverSkills(
  params: {
    workspacePath: string;
    workspaceIdentity?: string;
    includeUserSkills: boolean;
    provider: ZCodeProvider;
  },
  options: DiscoverSkillsOptions = {},
): Promise<DiscoverResult> {
  const workspaceRoots = dedupeRoots(await resolveAncestorWorkspaceRoots(params.workspacePath));
  const roots: SkillRootDescriptor[] = workspaceRoots.map((rootPath) => ({
    scope: "workspace" as const,
    rootPath,
  }));
  if (params.includeUserSkills) {
    // 用户级技能是全局资源，`.zcode/skills` 里只要存在一个技能就截断
    // `.agents/skills` 会导致外部 Agent 的全局技能在导入后从设置页消失。
    roots.push({
      scope: "user" as const,
      rootPath: getUserZcodeSkillRoot(),
    });
    roots.push({
      scope: "user" as const,
      rootPath: getUserAgentsSkillRoot(),
    });
  }
  roots.push(...(await resolvePluginSkillRootDescriptors()));

  const diagnostics: SkillDiagnostic[] = [];
  const skills: SkillSummary[] = [];
  const seenSkillPaths = new Set<string>();
  const userZcodeSkillNameKeys = params.includeUserSkills
    ? await collectSkillNameKeysInRoot(getUserZcodeSkillRoot())
    : new Set<string>();
  const scanRootPaths = await dedupeScanRootsByRealpath(roots.map((root) => root.rootPath));
  const rootByPath = new Map(roots.map((root) => [root.rootPath, root]));

  for (const rootPath of scanRootPaths) {
    const root = rootByPath.get(rootPath);
    if (!root) {
      continue;
    }
    if (!(await exists(root.rootPath))) {
      continue;
    }

    const skillPaths = await collectSkillMarkdownPaths(root.rootPath, diagnostics);
    for (const skillPath of skillPaths) {
      if (
        await isUserAgentsSkillCoveredByZcode({
          skillPath,
          rootPath: root.rootPath,
          userZcodeSkillNameKeys,
        })
      ) {
        continue;
      }
      const canonicalSkillPath = await realpath(skillPath).catch(() => skillPath);
      if (seenSkillPaths.has(canonicalSkillPath)) {
        continue;
      }
      seenSkillPaths.add(canonicalSkillPath);
      if (!(await exists(skillPath))) {
        continue;
      }
      let markdown: string;
      try {
        markdown = await readFile(skillPath, "utf-8");
      } catch (error) {
        diagnostics.push({
          code: "skill_read_failed",
          severity: "warning",
          message: error instanceof Error ? error.message : `Failed to read skill: ${skillPath}`,
          path: skillPath,
        });
        continue;
      }
      const parsed = readFrontmatter(markdown);
      const skillFolderName = basename(dirname(skillPath));

      // name 校验只要求非空；大小写/下划线等是其它 skill 生态的合法显示名，不应产出噪音诊断。
      // 缺少 frontmatter 的手写 skill 不应显示不可操作的诊断；用目录名兜底，metadata 字段留空。
      const rawName = parsed.hasFrontmatter ? parsed.name.trim() : skillFolderName;
      const resolvedName = rawName || skillFolderName;
      if (!resolvedName) {
        diagnostics.push({
          code: "skill_missing_name",
          severity: "error",
          message: `Skill frontmatter must include a name: ${skillPath}`,
          path: skillPath,
        });
        continue;
      }

      const description = parsed.hasFrontmatter ? parsed.description.trim() : "";
      if (description.length > MAX_DESCRIPTION_LENGTH) {
        diagnostics.push({
          code: "skill_description_too_long",
          severity: "error",
          message: `Skill description is too long (>${MAX_DESCRIPTION_LENGTH}): ${resolvedName}`,
          path: skillPath,
          skillName: resolvedName,
        });
        continue;
      }

      // frontmatter 扩展字段通常来自不同 skill 生态的元信息。
      // 这些字段不影响 ZCode 读取 name/description，继续报 warning 只会制造无操作价值的噪音。

      const body = parsed.body.trim();
      // Тело SKILL.md читается всегда (публичный SkillSummary.body), кешируется
      // только разбор соседнего `_meta.json`.
      const metadata = options.metadataCache
        ? await options.metadataCache.read(skillPath)
        : await readSkillMetadata(skillPath);
      skills.push({
        id: buildSkillId({
          provider: params.provider,
          scope: root.scope,
          name: resolvedName,
          path: canonicalSkillPath,
        }),
        name: resolvedName,
        description,
        body,
        // SkillSummary.path 之前存的是技能目录，前端在生成 skill mention 链接时拿不到标准文件路径，
        // 最终只能得到 `[$skill](.../skill-dir)` 这种不完整引用。这里直接返回 `SKILL.md` 文件路径，
        // 让 UI、日志和后续技能跳转都能共享同一份标准定位信息。
        path: canonicalSkillPath,
        // 原始扫描路径（未 realpath）。软链技能删除时用它定位链接本体，避免误删目标目录。
        sourcePath: skillPath,
        scope: root.scope,
        enabled: true,
        ...(root.pluginName ? { pluginName: root.pluginName } : {}),
        ...(root.pluginId ? { pluginId: root.pluginId } : {}),
        ...(metadata ? { metadata } : {}),
      });
    }
  }

  skills.sort((left, right) => {
    const byName = left.name.localeCompare(right.name);
    if (byName !== 0) {
      return byName;
    }
    const byScope = left.scope.localeCompare(right.scope);
    return byScope !== 0 ? byScope : left.path.localeCompare(right.path);
  });

  return { skills, diagnostics };
}

export function attachEnabledState(
  skills: SkillSummary[],
  enabledByPath: Record<string, boolean>,
): SkillSummary[] {
  return skills.map((skill) => ({
    ...skill,
    enabled: enabledByPath[normalizeSkillConfigPath(skill.path)] ?? true,
  }));
}
