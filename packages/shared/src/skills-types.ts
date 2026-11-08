export type SkillScope = "workspace" | "user" | "plugin";

export interface SkillMetadata {
  slug?: string;
  version?: string;
  ownerId?: string;
  publishedAt?: number;
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  body: string;
  path: string;
  /**
   * 发现阶段命中的原始 SKILL.md 路径（未经 realpath 解析）。
   * 软链导入的技能里 `path` 是 realpath 后的目标文件，`sourcePath` 才指向 `~/.zcode/skills/<name>` 下的链接本体，
   * 删除时必须用它才能只删链接、不动目标。普通技能与 `path` 相同。
   */
  sourcePath?: string;
  scope: SkillScope;
  enabled: boolean;
  /** plugin scope 时为来源插件名；其它 scope 留空。 */
  pluginName?: string;
  /** plugin scope 时为来源插件完整 ID（name@marketplace）；旧 payload 可缺省。 */
  pluginId?: string;
  metadata?: SkillMetadata;
}

export interface SkillsCapability {
  userScopeAvailable: boolean;
  userScopeReason?: "desktop_only";
}

export type SkillDiagnosticSeverity = "warning" | "error";

/** 与 zcode-cli `SkillDiagnosticCode` 同步。变动时一并改 apps/zcode-cli/packages/contracts/src/skills/index.ts。 */
export type SkillDiagnosticCode =
  | "skill_root_not_found"
  | "skill_scan_failed"
  | "skill_read_failed"
  | "skill_missing_frontmatter"
  | "skill_invalid_frontmatter"
  | "skill_missing_name"
  | "skill_invalid_name"
  | "skill_missing_description"
  | "skill_description_too_long"
  | "skill_unknown_frontmatter"
  | "skill_duplicate_name"
  | "skill_too_large"
  | "skill_not_found";

export interface SkillDiagnostic {
  code: SkillDiagnosticCode;
  severity: SkillDiagnosticSeverity;
  message: string;
  path?: string;
  skillName?: string;
}

export interface SkillsListResult {
  skills: SkillSummary[];
  capability: SkillsCapability;
  diagnostics: SkillDiagnostic[];
}

export interface SkillsPromptContext {
  prompt: string;
  activatedSkillNames: string[];
}

/** skills.sh 安装范围：写入工作区 `.agents/skills` 或用户 `~/.agents/skills`。 */
export type SkillInstallScope = "workspace" | "user";

/** skills.sh 搜索结果条目。`source` 为 `owner/repo`；安装引用为 `source/skillId`。 */
export interface MarketplaceSkillInfo {
  /** 展示名称；可能包含空格/冒号，不能直接作为安装引用。 */
  name: string;
  /** skills.sh 技能 slug；安装时与 source 组成 `owner/repo/skillId`。 */
  skillId: string;
  source: string;
  /** Actual skills.sh install count; omitted when the source does not provide a valid count. */
  installs?: number;
  installed: boolean;
}

/**
 * 安装请求。`name` 接受 `owner/repo/skillId`（搜索结果 `source` + `name`）或裸技能名
 * （裸名通过 skills.sh 搜索解析唯一来源）。
 *
 * `workspacePath`/`workspaceIdentity` 是兼容扩展：服务进程没有唯一的活动工作区，
 * workspace scope 必须由调用方提供路径，否则无法判断写入哪个工作区。
 */
export interface InstallMarketplaceSkillRequest {
  name: string;
  scope: SkillInstallScope;
  workspacePath?: string;
  workspaceIdentity?: string;
}

export interface InstallMarketplaceSkillResult {
  /** SKILL.md frontmatter 中的实际名称；缺失时回退为目录名。 */
  name: string;
  scope: SkillInstallScope;
  path: string;
}

/**
 * @deprecated 使用 `MarketplaceSkillInfo`。保留仅为并行 UI 分支迁移期的导入兼容。
 */
export interface SkillMarketplaceItem extends MarketplaceSkillInfo {
  id: string;
}

/** @deprecated 使用 `MarketplaceSkillInfo[]`。 */
export interface SkillMarketplaceSearchResult {
  query: string;
  total: number;
  items: SkillMarketplaceItem[];
}

/** @deprecated 使用 `InstallMarketplaceSkillRequest`。 */
export type SkillMarketplaceInstallInput = InstallMarketplaceSkillRequest;

/** @deprecated 使用 `InstallMarketplaceSkillResult`。 */
export type SkillMarketplaceInstallResult = InstallMarketplaceSkillResult;
