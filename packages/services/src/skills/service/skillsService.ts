/**
 * skills 服务门面：串行写队列 + 列表/开关/prompt/通用目录/marketplace 操作。
 */
import { cp, mkdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type {
  InstallMarketplaceSkillRequest,
  InstallMarketplaceSkillResult,
  MarketplaceSkillInfo,
  SkillInstallScope,
  SkillScope,
  SkillsCapability,
  SkillsListResult,
  SkillsPromptContext,
  ZCodeProvider,
} from "@zcode/shared";
import type { ISkillsService } from "../skills.js";
import {
  collectInstalledSkillKeys,
  downloadSkillsShSnapshot,
  resolveMarketplaceSkillReference,
  sanitizeMarketplaceDirectoryName,
  searchSkillsSh,
  SkillMarketplaceError,
  toMarketplaceItems,
  writeSkillSnapshotAtomically,
} from "../skillMarketplace.js";
import { SKILL_FILE_NAME } from "../skillDiscoveryWalk.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  normalizeSkillConfigPath,
  readSkillEnabledMap,
  writeSkillEnabledMap,
} from "./cliConfig.js";
import { attachEnabledState, discoverSkills } from "./discovery.js";
import { createSkillMetadataCache } from "./skillMetadataCache.js";
import {
  appendSkillsAuditLog,
  buildActivatedSkillsPromptBlock,
  collectMentionedSkillNames,
} from "./promptContext.js";
import {
  dedupeRoots,
  exists,
  getWorkspaceAgentsSkillRoot,
  getWorkspaceZcodeSkillRoot,
  getUserAgentsSkillRoot,
  getUserZcodeSkillRoot,
  resolveAncestorWorkspaceRoots,
} from "./skillPaths.js";

const logger = createServiceLogger("skills.service");

interface SkillsServiceOptions {
  isDesktopRuntime?: boolean;
}

function resolveCapabilities(options?: SkillsServiceOptions): SkillsCapability {
  const isDesktopRuntime = options?.isDesktopRuntime ?? Boolean(process.env.ZCODE_PROCESS_LABEL);
  if (isDesktopRuntime) {
    return { userScopeAvailable: true };
  }
  return { userScopeAvailable: false, userScopeReason: "desktop_only" };
}

export function createSkillsService(options?: SkillsServiceOptions): ISkillsService {
  // 技能状态写与 marketplace 安装共用一个串行队列；Promise<unknown> 允许链上返回安装结果。
  let writeQueue: Promise<unknown> = Promise.resolve();
  // Один metadata-кеш на сервис: `list` и `setEnabled` разделяют разбор `_meta.json`.
  // Кешируется только `_meta.json`; тело SKILL.md, enabled-map и plugin state читаются
  // на каждый вызов (см. docs/specs/skill-catalog-cache.md).
  const metadataCache = createSkillMetadataCache();

  return {
    async list(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      provider?: ZCodeProvider;
    }): Promise<SkillsListResult> {
      const capability = resolveCapabilities(options);
      const provider = "glm";
      const { skills: discovered, diagnostics } = await discoverSkills(
        {
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
          includeUserSkills: capability.userScopeAvailable,
          provider,
        },
        { metadataCache },
      );
      const enabledByPath = await readSkillEnabledMap();
      return {
        skills: attachEnabledState(discovered, enabledByPath),
        capability,
        diagnostics,
      };
    },

    async setEnabled(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      provider?: ZCodeProvider;
      scope?: SkillScope;
      skillId: string;
      enabled: boolean;
    }): Promise<void> {
      const runUpdate = async () => {
        const provider = "glm";
        const capability = resolveCapabilities(options);
        const { skills } = await discoverSkills(
          {
            workspacePath: params.workspacePath,
            workspaceIdentity: params.workspaceIdentity,
            includeUserSkills: capability.userScopeAvailable,
            provider,
          },
          { metadataCache },
        );
        const skill = skills.find((item) => item.id === params.skillId);
        if (!skill) {
          throw new Error(`Skill not found: ${params.skillId}`);
        }
        const enabledByPath = await readSkillEnabledMap();
        enabledByPath[normalizeSkillConfigPath(skill.path)] = params.enabled;
        await writeSkillEnabledMap(enabledByPath);
      };

      const queued = writeQueue.then(runUpdate, runUpdate);
      writeQueue = queued.catch(() => {});
      await queued;
    },

    async buildPromptContext(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      provider?: ZCodeProvider;
      prompt: string;
    }): Promise<SkillsPromptContext> {
      const mentionedSkillNames = collectMentionedSkillNames(params.prompt);
      if (mentionedSkillNames.size === 0) {
        return { prompt: params.prompt, activatedSkillNames: [] };
      }

      const { skills } = await this.list({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        provider: params.provider,
      });
      const activatedSkills = skills.filter(
        (skill) => skill.enabled && mentionedSkillNames.has(skill.name),
      );
      if (activatedSkills.length === 0) {
        return { prompt: params.prompt, activatedSkillNames: [] };
      }

      const activatedSkillNames = activatedSkills.map((skill) => skill.name);
      // 技能目录是可见资源，但不能在每次 session 发送时全量注入。
      // 只有用户在 prompt 中显式提到且当前启用的技能才进入上下文，避免技能状态从 UI 列表泄漏到 agent 核心 session。
      await appendSkillsAuditLog({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        activatedSkillNames,
      });
      return {
        prompt: `${params.prompt}\n\n${buildActivatedSkillsPromptBlock(activatedSkills)}`,
        activatedSkillNames,
      };
    },

    async copyToCommon(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      skillId: string;
    }): Promise<{ newPath: string }> {
      // 从所有 provider 扫描结果中找目标 skill（list 已经扫过全量路径）
      const { skills } = await this.list({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
      const skill = skills.find((s) => s.id === params.skillId);
      if (!skill) {
        throw new Error(`Skill not found: ${params.skillId}`);
      }
      const sourceDir = dirname(skill.path);
      // 通用目录根据 skill 原 scope 确定 user 还是 workspace 级
      const commonRoot =
        skill.scope === "workspace"
          ? getWorkspaceZcodeSkillRoot(params.workspacePath)
          : getUserZcodeSkillRoot();
      const targetDir = join(commonRoot, basename(sourceDir));
      // 不覆盖已有目录
      if (await exists(targetDir)) {
        throw new Error(`通用目录已存在同名技能: ${basename(sourceDir)}`);
      }
      await mkdir(commonRoot, { recursive: true });
      await cp(sourceDir, targetDir, { recursive: true });
      return { newPath: join(targetDir, SKILL_FILE_NAME) };
    },

    async removeFromCommon(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      skillId: string;
    }): Promise<void> {
      const { skills } = await this.list({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
      const skill = skills.find((s) => s.id === params.skillId);
      if (!skill) {
        throw new Error(`Skill not found: ${params.skillId}`);
      }
      const normalizedPath = skill.path.replaceAll("\\", "/").toLowerCase();
      const userCommonRoot = getUserZcodeSkillRoot().replaceAll("\\", "/").toLowerCase();
      const workspaceCommonRoot = getWorkspaceZcodeSkillRoot(params.workspacePath)
        .replaceAll("\\", "/")
        .toLowerCase();
      const inUserCommon = normalizedPath.includes(`${userCommonRoot}/`);
      const inWorkspaceCommon = normalizedPath.includes(`${workspaceCommonRoot}/`);
      if (!inUserCommon && !inWorkspaceCommon) {
        throw new Error("该技能不在通用目录中");
      }
      await rm(dirname(skill.path), { recursive: true, force: true });
    },

    async deleteSkill(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      skillId: string;
    }): Promise<void> {
      const { skills } = await this.list({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      });
      const skill = skills.find((s) => s.id === params.skillId);
      if (!skill) {
        throw new Error(`Skill not found: ${params.skillId}`);
      }
      // plugin 作用域的技能由其所属插件管理，应通过卸载插件移除，这里拒绝单独删除。
      if (skill.scope === "plugin") {
        throw new Error("插件提供的技能不可单独删除，请卸载对应插件");
      }

      // 用发现阶段命中的原始路径（sourcePath，未 realpath）定位技能目录项。
      // 软链导入的技能 skill.path 是 realpath 后的目标文件，dirname 会指向目标目录；
      // sourcePath 才指向 `~/.zcode/skills/<name>` 下的目录项本身。
      const skillDir = dirname(skill.sourcePath ?? skill.path);
      const skillLeafName = basename(skillDir);
      // 只解析父目录，不解析叶子本身：
      // - 叶子若是软链（正常导入场景），保持不解析，删除时才只删链接、不动目标；
      // - 父目录 realpath 后，任何“软链/junction 祖先”都会被展开到真实位置，
      //   随后越界校验就能拦住“经由祖先软链删到受控根之外”的数据丢失路径。
      const canonicalParent = await realpath(dirname(skillDir)).catch(() => null);
      if (!canonicalParent) {
        throw new Error(`该技能不可删除: ${skill.path}`);
      }

      // 安全护栏：删除是 `rm -rf` 目录的破坏性操作，仅允许命中受控技能根。
      // 收集工作区各层级（沿 worktree 向上）的 .zcode/skills 与 .agents/skills，外加用户级两根。
      const allowedRootCandidates = await resolveAncestorWorkspaceRoots(params.workspacePath);
      allowedRootCandidates.push(getUserZcodeSkillRoot());
      allowedRootCandidates.push(getUserAgentsSkillRoot());

      // 用 realpath 后的父目录与 realpath 后的根比较：父目录必须落在（或等于）某个受控根内。
      // 两侧都 realpath，`/tmp`→`/private/tmp` 这类系统软链会在两侧抵消，不会误判越界。
      let contained = false;
      for (const root of allowedRootCandidates) {
        const canonicalRoot = await realpath(root).catch(() => root);
        const relativePath = relative(canonicalRoot, canonicalParent);
        // 父目录等于根（叶子直接位于根下）也是合法的常见场景，故允许 "".
        if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
          contained = true;
          break;
        }
      }

      if (!contained) {
        throw new Error(`该技能不可删除: ${skill.path}`);
      }
      // 删除 `<真实父目录>/<叶子名>`：父目录已是真实路径，不会经由祖先软链穿越；
      // 叶子仍是原目录项，是软链就只删链接、是普通目录就整目录删除。
      await rm(join(canonicalParent, skillLeafName), {
        recursive: true,
        force: true,
      });
    },

    async searchMarketplace(
      query: string,
      context?: { workspacePath?: string; workspaceIdentity?: string },
    ): Promise<MarketplaceSkillInfo[]> {
      const normalizedQuery = query.trim();
      // 空查询不触网：UI 初始态只是本地输入，不应产生网络流量。
      if (normalizedQuery.length === 0) {
        return [];
      }
      const entries = await searchSkillsSh(normalizedQuery);
      const capability = resolveCapabilities(options);
      // 与 list 共用同一套根目录解析：workspace 沿 worktree 向上收集两个技能根，
      // user 级只在 desktop-capable runtime 下参与 installed 判定。
      const roots = context?.workspacePath
        ? await resolveAncestorWorkspaceRoots(context.workspacePath)
        : [];
      if (capability.userScopeAvailable) {
        roots.push(getUserZcodeSkillRoot(), getUserAgentsSkillRoot());
      }
      const installedKeys = await collectInstalledSkillKeys(dedupeRoots(roots));
      return toMarketplaceItems(entries, installedKeys);
    },

    async installMarketplaceSkill(
      request: InstallMarketplaceSkillRequest,
    ): Promise<InstallMarketplaceSkillResult> {
      if (!request || typeof request.name !== "string" || !request.name.trim()) {
        throw new SkillMarketplaceError("invalid_input", "skill name is required");
      }
      const scope: SkillInstallScope = request.scope ?? "workspace";
      if (scope !== "workspace" && scope !== "user") {
        throw new SkillMarketplaceError(
          "invalid_input",
          `unsupported skill scope: ${String(scope)}`,
        );
      }
      const workspacePath = request.workspacePath?.trim();
      if (scope === "workspace" && !workspacePath) {
        throw new SkillMarketplaceError(
          "invalid_input",
          "workspacePath is required for workspace-scoped marketplace install",
        );
      }
      const runInstall = async (): Promise<InstallMarketplaceSkillResult> => {
        const reference = await resolveMarketplaceSkillReference(request.name);
        const directoryName = sanitizeMarketplaceDirectoryName(reference.skillId);
        const snapshot = await downloadSkillsShSnapshot(reference);
        const root =
          scope === "user" ? getUserAgentsSkillRoot() : getWorkspaceAgentsSkillRoot(workspacePath!);
        const written = await writeSkillSnapshotAtomically({
          root,
          directoryName,
          reference,
          scope,
          snapshot,
        });
        logger.info(undefined, "marketplace skill installed", {
          name: written.installedName,
          source: reference.source,
          skillId: reference.skillId,
          scope,
        });
        return { name: written.installedName, scope, path: written.path };
      };
      // 与 setEnabled 共用写队列：同一技能的并发安装/覆盖必须串行，避免 rename 竞争。
      const queued = writeQueue.then(runInstall, runInstall);
      writeQueue = queued.catch(() => {});
      try {
        return await queued;
      } catch (error) {
        logger.warn(undefined, "marketplace skill install failed", {
          name: request.name,
          scope,
          code: error instanceof SkillMarketplaceError ? error.code : "unknown",
        });
        throw error;
      }
    },
  };
}
