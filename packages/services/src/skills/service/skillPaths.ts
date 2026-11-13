/**
 * 技能根目录解析：用户级 / workspace 级目录、worktree 祖先链、扫描根去重。
 * 只处理路径与存在性，不读写技能内容。
 */
import { access, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const GIT_MARKER = ".git";

export function resolveUserHomeDir(): string {
  const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

/** ZCode Agent 工作区级技能目录。 */
export function getWorkspaceZcodeSkillRoot(workspacePath: string): string {
  return join(workspacePath, ".zcode", "skills");
}

/** 兼容目录: workspace 级 `.agents/skills`, 仅在同层 `.zcode/skills` 没读到技能时 fallback。 */
export function getWorkspaceAgentsSkillRoot(workspacePath: string): string {
  return join(workspacePath, ".agents", "skills");
}

/** ZCode Agent 用户级技能目录。 */
export function getUserZcodeSkillRoot(): string {
  return join(resolveUserHomeDir(), ".zcode", "skills");
}

/** 兼容目录: 用户级 `~/.agents/skills`。 */
export function getUserAgentsSkillRoot(): string {
  return join(resolveUserHomeDir(), ".agents", "skills");
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 从 workspacePath 向上走到 worktree 根（含 .git 标记），把每一层的
 * `.zcode/skills` 与 `.agents/skills` 都收集起来。
 * 对齐 apps/zcode-cli/packages/adapters/src/skills/roots.ts:60-72。
 * 找不到 .git 时退回 workspacePath 自身。
 */
export async function resolveAncestorWorkspaceRoots(workspacePath: string): Promise<string[]> {
  const worktreeRoot = await findWorktreeRoot(workspacePath);
  const baseDirectories: string[] = [];
  if (!worktreeRoot) {
    baseDirectories.push(workspacePath);
  } else {
    let current = workspacePath;
    while (true) {
      baseDirectories.push(current);
      if (current === worktreeRoot || current === dirname(current)) {
        break;
      }
      current = dirname(current);
    }
  }
  const roots: string[] = [];
  for (const dir of baseDirectories) {
    // Agent runtime 会合并扫描两个 workspace skill 根。UI 之前把 `.agents`
    // 当成 `.zcode` 的 fallback，导致同层 `.zcode` 只要有一个技能，`/`、`$` 和设置页
    // 就会整根漏掉 `.agents` 技能，形成“模型可执行但 UI 无法引用”的发现语义分裂。
    roots.push(getWorkspaceZcodeSkillRoot(dir));
    roots.push(getWorkspaceAgentsSkillRoot(dir));
  }
  return roots;
}

async function findWorktreeRoot(workingDirectory: string): Promise<string | null> {
  let current = workingDirectory;
  while (true) {
    if (await exists(join(current, GIT_MARKER))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function dedupeRoots(paths: string[]): string[] {
  const roots = new Set<string>();
  for (const path of paths) {
    roots.add(path);
  }
  return [...roots];
}

function normalizeScanRootPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/, "");
}

/**
 * 去掉会被「已存在」的更深层扫描根完全覆盖的祖先目录。
 * 同一目录被不同路径形式扫到时，同一 SKILL.md 会因路径字符串不同重复出现。
 * 若子目录尚不存在，仍保留父目录以兼容非标准布局。
 */
async function filterNestedScanRoots(paths: string[]): Promise<string[]> {
  const existing = new Set<string>();
  for (const path of paths) {
    if (await exists(path)) {
      existing.add(normalizeScanRootPath(path));
    }
  }
  const normalized = paths.map((path) => normalizeScanRootPath(path));
  return paths.filter((path, index) => {
    const current = normalized[index] ?? normalizeScanRootPath(path);
    if (!existing.has(current)) {
      return true;
    }
    return !normalized.some((other, otherIndex) => {
      if (otherIndex === index || !existing.has(other)) {
        return false;
      }
      return other.startsWith(`${current}/`);
    });
  });
}

export async function dedupeScanRootsByRealpath(paths: string[]): Promise<string[]> {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of await filterNestedScanRoots(paths)) {
    let canonical = normalizeScanRootPath(path);
    if (await exists(path)) {
      canonical = normalizeScanRootPath(await realpath(path).catch(() => path));
    }
    if (seen.has(canonical)) {
      continue;
    }
    seen.add(canonical);
    result.push(path);
  }
  return result;
}
