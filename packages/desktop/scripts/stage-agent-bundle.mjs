// Agent bundle 的暂存动作：把 apps/zcode-cli/packages/cli/dist/zcode.cjs 放进
// bundled-agents/<平台>/glm，并写 meta。
//
// dev 与打包**必须**用同一份暂存实现。
// 只有打包链（prepare-agent-node-bundle.mjs）会暂存是不够的，dev 链
// （scripts/build-desktop-agent-cli.mjs）不会；而 dev 未打包时的 agent 二进制由
// desktopRuntimeEnv.ts 的 resolveBundledZCodeAgentBinaryPath() 解析，候选**只有**
// bundled-agents/，没有 cli/dist/。于是 dev 一直跑着上一次打包时留下的那份 ——
// 实测陈旧 3 天，任何 agent CLI 侧改动在 dev 里静默不生效，排查时会把「改动没生效」
// 误判成「代码没起作用」。两边共用这一份，dev 与打包不可能再各自漂移。
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, resolve } from "node:path";

export const AGENT_BUNDLE_SOURCE_RELATIVE =
  "apps/zcode-cli/packages/cli/dist/zcode.cjs";
export const BUNDLED_SKILL_PACK_SOURCE_RELATIVE =
  "apps/zcode-cli/packages/bundled-skills";
export const BUNDLED_SKILL_PACK_REQUIRED_PATHS = [
  "skills/dynamic-workflows/SKILL.md",
  "skills/dynamic-workflows/patterns.md",
  "skills/dynamic-workflows/examples.md",
  "skills/zcode-swarm/SKILL.md",
  "skills/zcode-verification/SKILL.md",
  "skills/zcode-systematic-debugging/SKILL.md",
  "skills/zcode-test-driven-development/SKILL.md",
  "skills/anti-loop/SKILL.md",
  "skills/self-improvement/SKILL.md",
  "skills/code-craft/SKILL.md",
  "skills/reference-first/SKILL.md",
  "skills/task-planning/SKILL.md",
  "skills/execution-patterns/SKILL.md",
  "skills/reviewer/SKILL.md",
  "skills/completion-gate/SKILL.md",
  "skills/research/SKILL.md",
  "skills/domain-modeling/SKILL.md",
  "skills/ui-craft/SKILL.md",
  "skills/merge-conflict-resolution/SKILL.md",
  "skills/handoff/SKILL.md",
  "skills/performance-tuning/SKILL.md",
  "skills/mcp-authoring/SKILL.md",
  "rules/00-evidence.mdc",
  "rules/01-delegation.mdc",
  "rules/02-verification.mdc",
  "rules/03-context.mdc",
  "rules/04-model-identity.mdc",
  "rules/05-code-and-ui-craft.mdc",
  "rules/06-progress.mdc",
];
const excludedBundledSkillAssetNames = new Set([
  ".DS_Store",
  ".venv",
  "__pycache__",
  "node_modules",
]);

function shouldCopyBundledSkillAsset(sourcePath) {
  const name = basename(sourcePath);
  return !excludedBundledSkillAssetNames.has(name) && !name.endsWith(".pyc");
}

export function resolveAgentBundlePaths({ repoRoot, platformKey }) {
  const glmDir = resolve(
    repoRoot,
    "packages",
    "desktop",
    "bundled-agents",
    platformKey,
    "glm",
  );
  return {
    cliBundlePath: resolve(repoRoot, AGENT_BUNDLE_SOURCE_RELATIVE),
    glmDir,
    stagedBundlePath: resolve(glmDir, "zcode.cjs"),
    stagedMetaPath: resolve(glmDir, ".node-bundle-meta.json"),
  };
}

/**
 * 干净重建 glm 目录再拷贝。清空是刻意的：electron-builder 整目录拷贝
 * bundled-agents/<平台>/glm → resources/glm，本地工作树里上一次构建残留的原生二进制
 * （zcode-agent / zcode-acp 等）和旧 meta 会被一并打进安装包（CI 干净检出不会有，本地会）。
 */
export function stageAgentBundle({ repoRoot, platformKey, log = console.log }) {
  const { cliBundlePath, glmDir, stagedBundlePath, stagedMetaPath } =
    resolveAgentBundlePaths({
      repoRoot,
      platformKey,
    });
  if (!existsSync(cliBundlePath)) {
    throw new Error(
      `[stage:agent-bundle] agent bundle 源产物不存在：${cliBundlePath}`,
    );
  }
  rmSync(glmDir, { recursive: true, force: true });
  mkdirSync(glmDir, { recursive: true });
  copyFileSync(cliBundlePath, stagedBundlePath);
  const meta = {
    runtime: "electron-node",
    entry: "zcode.cjs",
    platform: platformKey,
    source: AGENT_BUNDLE_SOURCE_RELATIVE,
  };
  writeFileSync(stagedMetaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  stageBundledSkillPack({ repoRoot, glmDir, log });
  log(`[stage:agent-bundle] staged ${stagedBundlePath}`);
  return { stagedBundlePath, stagedMetaPath };
}

/**
 * Keep bundled skills beside the staged agent entrypoint. stageAgentBundle clears glmDir,
 * so the skill pack must be restored in the same operation before the runtime is launched.
 */
export function stageBundledSkillPack({ repoRoot, glmDir, log = console.log }) {
  const sourceRoot = resolve(repoRoot, BUNDLED_SKILL_PACK_SOURCE_RELATIVE);
  const targetRoot = resolve(glmDir, "packages", "bundled-skills");
  if (!existsSync(sourceRoot)) {
    throw new Error(
      `[stage:agent-bundle] bundled skill pack source does not exist: ${sourceRoot}`,
    );
  }

  mkdirSync(targetRoot, { recursive: true });
  for (const entryName of ["README.md", "skills", "rules"]) {
    const sourcePath = resolve(sourceRoot, entryName);
    if (existsSync(sourcePath)) {
      cpSync(sourcePath, resolve(targetRoot, entryName), {
        recursive: true,
        filter: shouldCopyBundledSkillAsset,
      });
    }
  }

  const missingPaths = BUNDLED_SKILL_PACK_REQUIRED_PATHS.filter(
    (relativePath) =>
      !existsSync(resolve(targetRoot, ...relativePath.split("/"))),
  );
  if (missingPaths.length > 0) {
    throw new Error(
      `[stage:agent-bundle] bundled skill pack is incomplete at ${targetRoot}: ${missingPaths.join(", ")}`,
    );
  }
  log(`[stage:agent-bundle] staged bundled skill pack ${targetRoot}`);
  return { stagedSkillPackPath: targetRoot };
}
