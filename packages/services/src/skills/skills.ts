import type {
  ZCodeProvider,
  SkillsPromptContext,
  SkillsListResult,
  MarketplaceSkillInfo,
  InstallMarketplaceSkillRequest,
  InstallMarketplaceSkillResult,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface ISkillsService {
  list(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
  }): Promise<SkillsListResult>;
  setEnabled(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
    scope?: "workspace" | "user" | "plugin";
    skillId: string;
    enabled: boolean;
  }): Promise<void>;
  buildPromptContext(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
    prompt: string;
  }): Promise<SkillsPromptContext>;
  /** 将指定 skill 复制到通用目录（.zcode/skills），成功后返回新 skill 的路径。 */
  copyToCommon(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    skillId: string;
  }): Promise<{ newPath: string }>;
  /** 从通用目录中移除指定 skill（仅当 skill 位于 .zcode/skills 时有效）。 */
  removeFromCommon(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    skillId: string;
  }): Promise<void>;
  /**
   * 删除本地技能（仅 workspace/user 作用域；plugin 作用域拒绝）。
   * 删除技能所在目录，仅允许命中 .zcode/skills 或 .agents/skills 根，越界则拒绝。
   */
  deleteSkill(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    skillId: string;
  }): Promise<void>;
  /**
   * 搜索 skills.sh 公共目录。空 query 直接返回空结果，不发起网络请求。
   * `context.workspacePath` 是兼容扩展，用于把 `installed` 限定到指定工作区；
   * 未提供时只对照用户级技能目录。
   */
  searchMarketplace(
    query: string,
    context?: { workspacePath?: string; workspaceIdentity?: string },
  ): Promise<MarketplaceSkillInfo[]>;
  /**
   * 安装 skills.sh 快照到 `<workspace>/.agents/skills/<name>` 或
   * `~/.agents/skills/<name>`。快照是不可信输入：只允许相对路径，限制大小，
   * 且绝不执行下载内容。返回 SKILL.md 中实际声明的名称；成功安装还会创建同名
   * user-scope 专用 agent（见 `docs/specs/2026-11-20-skill-installed-agents.md`）。
   */
  installMarketplaceSkill(
    request: InstallMarketplaceSkillRequest,
  ): Promise<InstallMarketplaceSkillResult>;
}

export const ISkillsService = createServiceDescriptor<ISkillsService>(ServiceChannels.Skills);
