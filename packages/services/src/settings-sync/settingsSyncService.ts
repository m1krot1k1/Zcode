/* eslint-disable max-lines -- settings-sync 需要集中维护外部 skills/commands/plugins/MCP 扫描、去重和导入状态机，后续按资源类别拆分 */
import type {
  McpServerConfig,
  SettingsSyncAgent,
  SettingsSyncCategory,
  SettingsSyncClaudeAgentsFileCopyResult,
  SettingsSyncClaudeAgentsFileMigrationStatus,
  SettingsSyncCommandImportResult,
  SettingsSyncCommandSkipReason,
  SettingsSyncDiscoveryResult,
  SettingsSyncImportResult,
  SettingsSyncPluginImportResult,
  SettingsSyncPluginSkipReason,
  SettingsSyncMcpServerImportResult,
  SettingsSyncMcpServerImportWarning,
  SettingsSyncMcpServerSkipReason,
  SettingsSyncSelection,
  SettingsSyncImportMode,
  SettingsSyncSkillImportResult,
  SettingsSyncSkillSkipReason,
  SettingsSyncSourceScope,
  SettingsSyncSourceRootSummary,
  SettingsSyncSourceDiagnostic,
  SettingsSyncTaskImportResult,
} from "@zcode/shared";
import { COMMUNITY_MCP_PRESETS, communityMcpPresetConfig } from "@zcode/shared";
import {
  chmod,
  copyFile,
  cp,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { parse as parseToml } from "smol-toml";
import { CommandFileParser } from "../commands/commandFileParser.js";
import type { ISettingService } from "../setting/setting.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { walkSkillMarkdownPaths } from "../skills/skillDiscoveryWalk.js";
import type { ISettingsSyncService } from "./settingsSync.js";

const log = createServiceLogger("settings-sync");

interface SettingsSyncServiceDependencies {
  settingService: ISettingService;
}

type SkillImportScope = "user" | "workspace";

interface SkillImportCandidate {
  agent: SettingsSyncAgent;
  name: string;
  nameKey: string;
  version?: string;
  sourceRootScope: SettingsSyncSourceScope;
  sourceRootPath: string;
  sourcePath: string;
  targetRoot: string;
  targetPath: string;
  scope: SkillImportScope;
}

interface SkillSourceRoot {
  agent: SettingsSyncAgent;
  rootPath: string;
  scope: SkillImportScope;
}

interface ExternalAgentPathSource {
  agent: SettingsSyncAgent;
  projectPath: string[];
  globalPath: string[];
}

type CommandImportScope = "user" | "workspace";

interface CommandImportCandidate {
  agent: SettingsSyncAgent;
  argumentHint?: string;
  description?: string;
  name: string;
  nameKey: string;
  sourcePath: string;
  sourceRelativePath: string;
  sourceRootPath: string;
  sourceRootScope: SettingsSyncSourceScope;
  targetPath: string;
  targetRoot: string;
  scope: CommandImportScope;
}

interface CommandSourceRoot {
  agent: SettingsSyncAgent;
  rootPath: string;
  scope: CommandImportScope;
}

type PluginImportScope = "user" | "workspace";

interface PluginImportCandidate {
  agent: SettingsSyncAgent;
  id: string;
  name: string;
  sourcePath: string;
  sourceRootPath: string;
  sourceRootScope: SettingsSyncSourceScope;
  targetPath: string;
  targetRoot: string;
  version?: string;
}

interface PluginSourceRoot {
  agent: SettingsSyncAgent;
  rootPath: string;
  scope: PluginImportScope;
}

type McpImportScope = "user" | "workspace";
type McpConfigFormat = "mcpServersJson" | "mcpJson" | "codexToml" | "clineMcpJson";

interface McpImportCandidate {
  agent: SettingsSyncAgent;
  name: string;
  nameKey: string;
  config: McpServerConfig;
  sourceRootScope: SettingsSyncSourceScope;
  sourceRootPath: string;
  sourcePath: string;
  requiresOAuthReauthentication?: boolean;
}

interface McpSourceFileReadResult {
  servers: Record<string, McpServerConfig>;
  diagnostics: SettingsSyncSourceDiagnostic[];
  oauthReauthenticationRequiredNames?: string[];
}

interface McpSourceRoot {
  agent: SettingsSyncAgent;
  rootPath: string;
  scope: McpImportScope;
  format: McpConfigFormat;
}

interface ExternalAgentMcpPathSource {
  agent: SettingsSyncAgent;
  projectFiles: string[][];
  globalFiles: string[][];
  resolveGlobalFile?: () => Promise<string>;
  format: McpConfigFormat;
}

const SUPPORTED_SKILL_AGENT_SOURCES: ExternalAgentPathSource[] = [
  { agent: "claudeCode", projectPath: [".claude", "skills"], globalPath: [".claude", "skills"] },
  { agent: "codexCli", projectPath: [".codex", "skills"], globalPath: [".codex", "skills"] },
  {
    agent: "openCode",
    projectPath: [".opencode", "skills"],
    globalPath: [".config", "opencode", "skills"],
  },
  { agent: "openClaw", projectPath: ["skills"], globalPath: [".openclaw", "skills"] },
  { agent: "augment", projectPath: [".augment", "skills"], globalPath: [".augment", "skills"] },
  {
    agent: "continue",
    projectPath: [".continue", "skills"],
    globalPath: [".continue", "skills"],
  },
  { agent: "goose", projectPath: [".goose", "skills"], globalPath: [".config", "goose", "skills"] },
  { agent: "qwenCode", projectPath: [".qwen", "skills"], globalPath: [".qwen", "skills"] },
  { agent: "qode", projectPath: [".qoder", "skills"], globalPath: [".qoder", "skills"] },
  { agent: "qodeCn", projectPath: [".qoder", "skills"], globalPath: [".qoder-cn", "skills"] },
  {
    agent: "windsurf",
    projectPath: [".windsurf", "skills"],
    globalPath: [".codeium", "windsurf", "skills"],
  },
  { agent: "trae", projectPath: [".trae", "skills"], globalPath: [".trae", "skills"] },
  { agent: "traeCn", projectPath: [".trae", "skills"], globalPath: [".trae-cn", "skills"] },
  { agent: "kiroCli", projectPath: [".kiro", "skills"], globalPath: [".kiro", "skills"] },
  { agent: "roo", projectPath: [".roo", "skills"], globalPath: [".roo", "skills"] },
  {
    agent: "codeBuddy",
    projectPath: [".codebuddy", "skills"],
    globalPath: [".codebuddy", "skills"],
  },
];

const SUPPORTED_COMMAND_AGENT_SOURCES: ExternalAgentPathSource[] = [
  {
    agent: "claudeCode",
    projectPath: [".claude", "commands"],
    globalPath: [".claude", "commands"],
  },
  {
    agent: "codexCli",
    projectPath: [".codex", "commands"],
    globalPath: [".codex", "commands"],
  },
  {
    agent: "openCode",
    projectPath: [".opencode", "commands"],
    globalPath: [".config", "opencode", "commands"],
  },
  {
    agent: "openClaw",
    projectPath: ["commands"],
    globalPath: [".openclaw", "commands"],
  },
  {
    agent: "augment",
    projectPath: [".augment", "commands"],
    globalPath: [".augment", "commands"],
  },
  {
    agent: "continue",
    projectPath: [".continue", "commands"],
    globalPath: [".continue", "commands"],
  },
  {
    agent: "goose",
    projectPath: [".goose", "commands"],
    globalPath: [".config", "goose", "commands"],
  },
  {
    agent: "qwenCode",
    projectPath: [".qwen", "commands"],
    globalPath: [".qwen", "commands"],
  },
  {
    agent: "qode",
    projectPath: [".qoder", "commands"],
    globalPath: [".qoder", "commands"],
  },
  {
    agent: "qodeCn",
    projectPath: [".qoder", "commands"],
    globalPath: [".qoder-cn", "commands"],
  },
  {
    agent: "windsurf",
    projectPath: [".windsurf", "commands"],
    globalPath: [".codeium", "windsurf", "commands"],
  },
  {
    agent: "trae",
    projectPath: [".trae", "commands"],
    globalPath: [".trae", "commands"],
  },
  {
    agent: "kiroCli",
    projectPath: [".kiro", "commands"],
    globalPath: [".kiro", "commands"],
  },
  {
    agent: "roo",
    projectPath: [".roo", "commands"],
    globalPath: [".roo", "commands"],
  },
  {
    agent: "codeBuddy",
    projectPath: [".codebuddy", "commands"],
    globalPath: [".codebuddy", "commands"],
  },
];

const SUPPORTED_PLUGIN_AGENT_SOURCES: ExternalAgentPathSource[] = [
  {
    agent: "claudeCode",
    projectPath: [".claude", "plugins"],
    globalPath: [".claude", "plugins"],
  },
  {
    agent: "codexCli",
    projectPath: [".codex", "plugins"],
    globalPath: [".codex", "plugins"],
  },
  {
    agent: "openCode",
    projectPath: [".opencode", "plugins"],
    globalPath: [".config", "opencode", "plugins"],
  },
  {
    agent: "openClaw",
    projectPath: ["plugins"],
    globalPath: [".openclaw", "plugins"],
  },
  {
    agent: "augment",
    projectPath: [".augment", "plugins"],
    globalPath: [".augment", "plugins"],
  },
  {
    agent: "continue",
    projectPath: [".continue", "plugins"],
    globalPath: [".continue", "plugins"],
  },
  {
    agent: "goose",
    projectPath: [".goose", "plugins"],
    globalPath: [".config", "goose", "plugins"],
  },
  {
    agent: "qwenCode",
    projectPath: [".qwen", "plugins"],
    globalPath: [".qwen", "plugins"],
  },
  {
    agent: "qode",
    projectPath: [".qoder", "plugins"],
    globalPath: [".qoder", "plugins"],
  },
  {
    agent: "qodeCn",
    projectPath: [".qoder", "plugins"],
    globalPath: [".qoder-cn", "plugins"],
  },
  {
    agent: "windsurf",
    projectPath: [".windsurf", "plugins"],
    globalPath: [".codeium", "windsurf", "plugins"],
  },
  {
    agent: "trae",
    projectPath: [".trae", "plugins"],
    globalPath: [".trae", "plugins"],
  },
  {
    agent: "kiroCli",
    projectPath: [".kiro", "plugins"],
    globalPath: [".kiro", "plugins"],
  },
  {
    agent: "roo",
    projectPath: [".roo", "plugins"],
    globalPath: [".roo", "plugins"],
  },
  {
    agent: "codeBuddy",
    projectPath: [".codebuddy", "plugins"],
    globalPath: [".codebuddy", "plugins"],
  },
];

const SUPPORTED_MCP_AGENT_SOURCES: ExternalAgentMcpPathSource[] = [
  {
    agent: "cline",
    projectFiles: [],
    globalFiles: [],
    resolveGlobalFile: getClineMcpSettingsPath,
    format: "clineMcpJson",
  },
  {
    agent: "claudeCode",
    projectFiles: [[".claude", "settings.json"], [".mcp.json"]],
    globalFiles: [[".claude", "settings.json"]],
    format: "mcpServersJson",
  },
  {
    agent: "codexCli",
    projectFiles: [[".codex", "config.toml"]],
    globalFiles: [[".codex", "config.toml"]],
    format: "codexToml",
  },
  {
    agent: "openCode",
    projectFiles: [[".opencode", "opencode.json"]],
    globalFiles: [[".config", "opencode", "opencode.json"]],
    format: "mcpJson",
  },
  {
    agent: "openClaw",
    projectFiles: [["settings.json"]],
    globalFiles: [[".openclaw", "settings.json"]],
    format: "mcpServersJson",
  },
  {
    agent: "qwenCode",
    projectFiles: [[".qwen", "settings.json"]],
    globalFiles: [[".qwen", "settings.json"]],
    format: "mcpServersJson",
  },
  {
    agent: "qode",
    projectFiles: [[".qoder", "settings.json"]],
    globalFiles: [[".qoder", "settings.json"]],
    format: "mcpServersJson",
  },
  {
    agent: "qodeCn",
    projectFiles: [[".qoder", "settings.json"]],
    globalFiles: [[".qoder-cn", "settings.json"]],
    format: "mcpServersJson",
  },
  {
    agent: "trae",
    projectFiles: [[".trae", "settings.json"]],
    globalFiles: [[".trae", "settings.json"]],
    format: "mcpServersJson",
  },
  {
    agent: "kiroCli",
    projectFiles: [[".kiro", "settings.json"]],
    globalFiles: [[".kiro", "settings.json"]],
    format: "mcpServersJson",
  },
  {
    agent: "roo",
    projectFiles: [[".roo", "settings.json"]],
    globalFiles: [[".roo", "settings.json"]],
    format: "mcpServersJson",
  },
  {
    agent: "codeBuddy",
    projectFiles: [[".codebuddy", "settings.json"]],
    globalFiles: [[".codebuddy", "settings.json"]],
    format: "mcpServersJson",
  },
  {
    agent: "agents",
    projectFiles: [[".agents", "mcp.json"]],
    globalFiles: [[".agents", "mcp.json"]],
    format: "mcpServersJson",
  },
];

const ZCODE_PLUGIN_MANIFEST_PATH = [".zcode-plugin", "plugin.json"] as const;
const CLAUDE_PLUGIN_MANIFEST_PATH = [".claude-plugin", "plugin.json"] as const;
const CODEX_PLUGIN_MANIFEST_PATH = [".codex-plugin", "plugin.json"] as const;
const INLINE_PLUGIN_MARKETPLACE = "inline";
const PRIVATE_MCP_CONFIG_FILE_MODE = 0o600;

function resolveUserHomeDir(): string {
  const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

const CLINE_SETTINGS_RELATIVE_PATH = ["settings", "cline_mcp_settings.json"] as const;
const CLINE_EXTENSION_ID = "saoudrizwan.claude-dev";
const CLINE_EDITOR_PROFILE_DIRS = ["Code", "Code - Insiders", "Cursor", "VSCodium"] as const;

interface ClineMcpConfigPathOptions {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  platform: NodeJS.Platform;
  exists: (path: string) => boolean;
}

/** Resolve Cline's explicit profile first, then known editor storage, then CLI defaults. */
export function resolveClineMcpConfigPath({
  env,
  homeDir,
  platform,
  exists,
}: ClineMcpConfigPathOptions): string {
  const explicitPath = env.CLINE_MCP_SETTINGS_PATH?.trim();
  if (explicitPath) return explicitPath;

  const dataDir = env.CLINE_DATA_DIR?.trim();
  if (dataDir) return join(dataDir, ...CLINE_SETTINGS_RELATIVE_PATH);

  const clineDir = env.CLINE_DIR?.trim();
  if (clineDir) return join(clineDir, "data", ...CLINE_SETTINGS_RELATIVE_PATH);

  const editorRoot = getClineEditorUserDataRoot({ env, homeDir, platform });
  if (editorRoot) {
    for (const editor of CLINE_EDITOR_PROFILE_DIRS) {
      const candidate = join(
        editorRoot,
        editor,
        "User",
        "globalStorage",
        CLINE_EXTENSION_ID,
        ...CLINE_SETTINGS_RELATIVE_PATH,
      );
      if (exists(candidate)) return candidate;
    }
  }

  return join(homeDir, ".cline", "data", ...CLINE_SETTINGS_RELATIVE_PATH);
}

function getClineEditorUserDataRoot({
  env,
  homeDir,
  platform,
}: Pick<ClineMcpConfigPathOptions, "env" | "homeDir" | "platform">): string | undefined {
  if (platform === "darwin") return join(homeDir, "Library", "Application Support");
  if (platform === "win32") {
    const appData = env.APPDATA?.trim();
    return appData || join(homeDir, "AppData", "Roaming");
  }
  if (platform === "linux") {
    const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
    return xdgConfigHome || join(homeDir, ".config");
  }
  return undefined;
}

function getClineMcpConfigCandidates({
  env,
  homeDir,
  platform,
}: Pick<ClineMcpConfigPathOptions, "env" | "homeDir" | "platform">): string[] {
  const explicitPath = env.CLINE_MCP_SETTINGS_PATH?.trim();
  if (explicitPath) return [explicitPath];
  const dataDir = env.CLINE_DATA_DIR?.trim();
  if (dataDir) return [join(dataDir, ...CLINE_SETTINGS_RELATIVE_PATH)];
  const clineDir = env.CLINE_DIR?.trim();
  if (clineDir) return [join(clineDir, "data", ...CLINE_SETTINGS_RELATIVE_PATH)];

  const editorRoot = getClineEditorUserDataRoot({ env, homeDir, platform });
  const editorCandidates = editorRoot
    ? CLINE_EDITOR_PROFILE_DIRS.map((editor) =>
        join(
          editorRoot,
          editor,
          "User",
          "globalStorage",
          CLINE_EXTENSION_ID,
          ...CLINE_SETTINGS_RELATIVE_PATH,
        ),
      )
    : [];
  return [...editorCandidates, join(homeDir, ".cline", "data", ...CLINE_SETTINGS_RELATIVE_PATH)];
}

export async function selectClineMcpConfigPath(
  candidates: string[],
  inspect: (path: string) => Promise<{ exists: boolean; serverCount: number }>,
): Promise<string> {
  let firstExistingPath: string | undefined;
  for (const candidate of candidates) {
    const profile = await inspect(candidate);
    if (!profile.exists) continue;
    firstExistingPath ??= candidate;
    if (profile.serverCount > 0) return candidate;
  }
  return firstExistingPath ?? candidates.at(-1) ?? "";
}

async function getClineMcpSettingsPath(): Promise<string> {
  // Пустой профиль редактора не должен скрывать заполненный профиль Cline CLI.
  const candidates = getClineMcpConfigCandidates({
    env: process.env,
    homeDir: resolveUserHomeDir(),
    platform: process.platform,
  });
  return selectClineMcpConfigPath(candidates, async (path) => {
    if (!(await pathExists(path))) return { exists: false, serverCount: 0 };
    const profile = await readMcpServersFromSourceFile(path, "clineMcpJson");
    return { exists: true, serverCount: Object.keys(profile.servers).length };
  });
}

function getClineMcpServersRoot(): string {
  const dataDir = process.env.CLINE_DATA_DIR?.trim();
  if (dataDir) return join(resolve(dataDir), "mcp-servers");
  const clineDir = process.env.CLINE_DIR?.trim();
  if (clineDir) return join(resolve(clineDir), "data", "mcp-servers");
  return join(resolveUserHomeDir(), ".cline", "data", "mcp-servers");
}

function getWorkspaceZcodeSkillRoot(workspacePath: string): string {
  return join(workspacePath, ".zcode", "skills");
}

function getUserZcodeSkillRoot(): string {
  return join(resolveUserHomeDir(), ".zcode", "skills");
}

function getWorkspaceZcodeCommandRoot(workspacePath: string): string {
  return join(workspacePath, ".zcode", "commands");
}

function getUserZcodeCommandRoot(): string {
  return join(resolveUserHomeDir(), ".zcode", "commands");
}

function getWorkspaceZcodePluginRoot(workspacePath: string): string {
  return join(workspacePath, ".zcode", "plugins");
}

function getUserZcodePluginRoot(): string {
  return join(resolveUserHomeDir(), ".zcode", "plugins");
}

function getUserZcodeCliConfigPath(): string {
  return join(resolveUserHomeDir(), ".zcode", "cli", "config.json");
}

function getWorkspaceZcodeConfigPath(workspacePath: string): string {
  return join(workspacePath, ".zcode", "config.json");
}

function getClaudeUserAgentsFileSourcePath(): string {
  return join(resolveUserHomeDir(), ".claude", "CLAUDE.md");
}

function getUserZcodeAgentsFilePath(): string {
  return join(resolveUserHomeDir(), ".zcode", "AGENTS.md");
}

function resolveTargetRootForScope(
  targetScope: SettingsSyncSourceScope,
  workspacePath: string | undefined,
): string | null {
  if (targetScope === "global") {
    return getUserZcodeSkillRoot();
  }
  return workspacePath ? getWorkspaceZcodeSkillRoot(workspacePath) : null;
}

function resolveCandidateTargetRoot(
  sourceScope: SkillImportScope,
  workspacePath: string | undefined,
): string | null {
  return sourceScope === "workspace"
    ? workspacePath
      ? getWorkspaceZcodeSkillRoot(workspacePath)
      : null
    : getUserZcodeSkillRoot();
}

function resolveCommandTargetRootForScope(
  targetScope: SettingsSyncSourceScope,
  workspacePath: string | undefined,
): string | null {
  if (targetScope === "global") {
    return getUserZcodeCommandRoot();
  }
  return workspacePath ? getWorkspaceZcodeCommandRoot(workspacePath) : null;
}

function resolveCommandCandidateTargetRoot(
  sourceScope: CommandImportScope,
  workspacePath: string | undefined,
): string | null {
  return sourceScope === "workspace"
    ? workspacePath
      ? getWorkspaceZcodeCommandRoot(workspacePath)
      : null
    : getUserZcodeCommandRoot();
}

function resolvePluginTargetRootForScope(
  targetScope: SettingsSyncSourceScope,
  workspacePath: string | undefined,
): string | null {
  if (targetScope === "global") {
    return getUserZcodePluginRoot();
  }
  return workspacePath ? getWorkspaceZcodePluginRoot(workspacePath) : null;
}

function resolvePluginCandidateTargetRoot(
  sourceScope: PluginImportScope,
  workspacePath: string | undefined,
): string | null {
  return sourceScope === "workspace"
    ? workspacePath
      ? getWorkspaceZcodePluginRoot(workspacePath)
      : null
    : getUserZcodePluginRoot();
}

function resolvePluginConfigPathForScope(
  targetScope: SettingsSyncSourceScope,
  workspacePath: string | undefined,
): string | null {
  if (targetScope === "global") {
    return getUserZcodeCliConfigPath();
  }
  return workspacePath ? getWorkspaceZcodeConfigPath(workspacePath) : null;
}

function resolveMcpConfigPathForScope(
  targetScope: SettingsSyncSourceScope,
  workspacePath: string | undefined,
): string | null {
  if (targetScope === "global") {
    return getUserZcodeCliConfigPath();
  }
  return workspacePath ? getWorkspaceZcodeConfigPath(workspacePath) : null;
}

async function importSkillDirectory(
  sourcePath: string,
  targetPath: string,
  importMode: SettingsSyncImportMode,
): Promise<void> {
  if (importMode === "symlink") {
    await createDirectorySymlink(sourcePath, targetPath);
    return;
  }
  await cp(sourcePath, targetPath, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
}

export function getSkillDirectorySymlinkType(
  platform: NodeJS.Platform | string = process.platform,
): "dir" | "junction" {
  return platform === "win32" ? "junction" : "dir";
}

export function getCommandFileSymlinkType(): "file" {
  return "file";
}

async function createDirectorySymlink(sourcePath: string, targetPath: string): Promise<void> {
  // Windows 创建目录软链需要 junction；其它平台使用 dir。source 使用绝对路径，避免 junction
  // 在不同 cwd 下解析目标不一致。
  await symlink(resolve(sourcePath), targetPath, getSkillDirectorySymlinkType());
}

async function importCommandFile(
  sourcePath: string,
  targetPath: string,
  importMode: SettingsSyncImportMode,
): Promise<void> {
  if (importMode === "symlink") {
    if (process.platform === "win32") {
      // Windows 创建文件级 symlink 需要管理员权限，改用硬链接。
      // 硬链接不需要提权，且文件修改能双向同步。
      // 跨分区（EXDEV）等硬链接失败时回退到复制。
      try {
        await link(resolve(sourcePath), targetPath);
        log.info(undefined, "[importCommandFile] Windows 硬链接创建成功", {
          sourcePath,
          targetPath,
        });
        return;
      } catch (linkError) {
        // 记录硬链接失败原因（EXDEV 跨分区 / EACCES 权限等），便于排查
        const linkErrorCode = (linkError as NodeJS.ErrnoException)?.code;
        log.warn(undefined, "[importCommandFile] Windows 硬链接失败，回退到复制模式", {
          sourcePath,
          targetPath,
          linkErrorCode,
          linkErrorMessage: (linkError as Error)?.message,
        });
      }
    } else {
      // 非 Windows 平台使用 symlink，不需要提权。
      await symlink(resolve(sourcePath), targetPath, getCommandFileSymlinkType());
      return;
    }
  }
  await cp(sourcePath, targetPath, {
    errorOnExist: true,
    force: false,
  });
}

async function importPluginDirectory(
  sourcePath: string,
  targetPath: string,
  importMode: SettingsSyncImportMode,
): Promise<void> {
  if (importMode === "symlink") {
    await createDirectorySymlink(sourcePath, targetPath);
    return;
  }
  await cp(sourcePath, targetPath, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
}

function getExternalSkillRoots(workspacePath?: string): SkillSourceRoot[] {
  const home = resolveUserHomeDir();
  const userRoots: SkillSourceRoot[] = SUPPORTED_SKILL_AGENT_SOURCES.map((source) => ({
    agent: source.agent,
    rootPath: join(home, ...source.globalPath),
    scope: "user",
  }));
  if (!workspacePath) {
    // 全局技能导入不应依赖当前窗口必须打开 workspace。
    return userRoots;
  }
  return [
    ...userRoots,
    ...SUPPORTED_SKILL_AGENT_SOURCES.map((source) => ({
      agent: source.agent,
      rootPath: join(workspacePath, ...source.projectPath),
      scope: "workspace" as const,
    })),
  ];
}

function getExternalCommandRoots(workspacePath?: string): CommandSourceRoot[] {
  const home = resolveUserHomeDir();
  const userRoots: CommandSourceRoot[] = SUPPORTED_COMMAND_AGENT_SOURCES.map((source) => ({
    agent: source.agent,
    rootPath: join(home, ...source.globalPath),
    scope: "user",
  }));
  if (!workspacePath) {
    return userRoots;
  }
  return [
    ...userRoots,
    ...SUPPORTED_COMMAND_AGENT_SOURCES.map((source) => ({
      agent: source.agent,
      rootPath: join(workspacePath, ...source.projectPath),
      scope: "workspace" as const,
    })),
  ];
}

function getExternalPluginRoots(workspacePath?: string): PluginSourceRoot[] {
  const home = resolveUserHomeDir();
  const userRoots: PluginSourceRoot[] = SUPPORTED_PLUGIN_AGENT_SOURCES.map((source) => ({
    agent: source.agent,
    rootPath: join(home, ...source.globalPath),
    scope: "user",
  }));
  if (!workspacePath) {
    return userRoots;
  }
  return [
    ...userRoots,
    ...SUPPORTED_PLUGIN_AGENT_SOURCES.map((source) => ({
      agent: source.agent,
      rootPath: join(workspacePath, ...source.projectPath),
      scope: "workspace" as const,
    })),
  ];
}

async function getExternalMcpRoots(workspacePath?: string): Promise<McpSourceRoot[]> {
  const home = resolveUserHomeDir();
  const userRoots: McpSourceRoot[] = [];
  for (const source of SUPPORTED_MCP_AGENT_SOURCES) {
    const resolvedGlobalFile = source.resolveGlobalFile ? await source.resolveGlobalFile() : undefined;
    for (const rootPath of [
      ...source.globalFiles.map((globalFile) => join(home, ...globalFile)),
      ...(resolvedGlobalFile ? [resolvedGlobalFile] : []),
    ]) {
      userRoots.push({
        agent: source.agent,
        rootPath,
        scope: "user",
        format: source.format,
      });
    }
  }
  if (!workspacePath) {
    return userRoots;
  }
  return [
    ...userRoots,
    ...SUPPORTED_MCP_AGENT_SOURCES.flatMap((source) =>
      source.projectFiles.map((projectFile) => ({
        agent: source.agent,
        rootPath: join(workspacePath, ...projectFile),
        scope: "workspace" as const,
        format: source.format,
      })),
    ),
  ];
}

async function exists(path: string): Promise<boolean> {
  try {
    await readdir(path);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function collectSkillMarkdownPaths(rootPath: string): Promise<string[]> {
  // 复用共享的有界遍历（排除 node_modules 等内容目录、限制深度、软链去重），
  // 与桌面端技能扫描保持一致，避免设置同步在巨型目录上卡死。
  const discovered = new Set<string>();
  for await (const skillPath of walkSkillMarkdownPaths(rootPath)) {
    discovered.add(skillPath);
  }
  return [...discovered].sort((left, right) => left.localeCompare(right));
}

async function collectCommandMarkdownPaths(rootPath: string): Promise<string[]> {
  const discovered = new Set<string>();
  const stack: string[] = [rootPath];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) {
      continue;
    }
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        discovered.add(fullPath);
      }
    }
  }
  return [...discovered].sort((left, right) => left.localeCompare(right));
}

async function findPluginManifestPath(pluginPath: string): Promise<string | null> {
  const zcodeManifestPath = join(pluginPath, ...ZCODE_PLUGIN_MANIFEST_PATH);
  if (await pathExists(zcodeManifestPath)) {
    return zcodeManifestPath;
  }
  const claudeManifestPath = join(pluginPath, ...CLAUDE_PLUGIN_MANIFEST_PATH);
  if (await pathExists(claudeManifestPath)) {
    return claudeManifestPath;
  }
  const codexManifestPath = join(pluginPath, ...CODEX_PLUGIN_MANIFEST_PATH);
  if (await pathExists(codexManifestPath)) {
    return codexManifestPath;
  }
  return null;
}

async function collectPluginPaths(rootPath: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(rootPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const discovered = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }
    if (entry.name.startsWith(".")) {
      continue;
    }
    const pluginPath = join(rootPath, entry.name);
    if (await findPluginManifestPath(pluginPath)) {
      discovered.push(pluginPath);
    }
  }
  return discovered.sort((left, right) => left.localeCompare(right));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSkillNameKey(name: string): string {
  return name.trim().toLowerCase();
}

function stripYamlScalarQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function readLooseSkillName(frontmatterText: string, fallbackName: string): string {
  const match = /^name\s*:\s*(.+)$/m.exec(frontmatterText);
  return stripYamlScalarQuotes(match?.[1] ?? fallbackName) || fallbackName;
}

function readLooseSkillVersion(frontmatterText: string): string | undefined {
  const match = /^version\s*:\s*(.+)$/m.exec(frontmatterText);
  const version = stripYamlScalarQuotes(match?.[1] ?? "");
  return version.length > 0 ? version : undefined;
}

function readSkillMetadataFromMarkdown(
  content: string,
  fallbackName: string,
): { name: string; version?: string } {
  const normalized = content.replace(/\r\n|\r/g, "\n");
  const frontmatterMatch = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  if (!frontmatterMatch) {
    return { name: fallbackName };
  }
  const frontmatterText = frontmatterMatch[1] ?? "";
  try {
    const parsed = parseYaml(frontmatterText);
    if (isRecord(parsed)) {
      const name =
        typeof parsed.name === "string" && parsed.name.trim()
          ? parsed.name.trim()
          : readLooseSkillName(frontmatterText, fallbackName);
      const parsedVersion =
        typeof parsed.version === "string" || typeof parsed.version === "number"
          ? String(parsed.version).trim()
          : "";
      const version = parsedVersion || readLooseSkillVersion(frontmatterText);
      return {
        name,
        ...(version ? { version } : {}),
      };
    }
  } catch {
    const version = readLooseSkillVersion(frontmatterText);
    return {
      name: readLooseSkillName(frontmatterText, fallbackName),
      ...(version ? { version } : {}),
    };
  }
  const version = readLooseSkillVersion(frontmatterText);
  return {
    name: readLooseSkillName(frontmatterText, fallbackName),
    ...(version ? { version } : {}),
  };
}

async function readSkillMetadata(skillPath: string): Promise<{ name: string; version?: string }> {
  const fallbackName = basename(dirname(skillPath));
  try {
    return readSkillMetadataFromMarkdown(await readFile(skillPath, "utf-8"), fallbackName);
  } catch {
    return { name: fallbackName };
  }
}

async function readSkillNameKey(skillPath: string): Promise<string> {
  return normalizeSkillNameKey((await readSkillMetadata(skillPath)).name);
}

async function collectExistingSkillNameKeys(rootPath: string): Promise<Set<string>> {
  const nameKeys = new Set<string>();
  if (!(await exists(rootPath))) {
    return nameKeys;
  }
  for (const skillPath of await collectSkillMarkdownPaths(rootPath)) {
    nameKeys.add(await readSkillNameKey(skillPath));
  }
  return nameKeys;
}

function normalizeCommandNameKey(name: string): string {
  return name.trim().toLowerCase();
}

function getCommandNameFromPath(rootPath: string, filePath: string): string {
  const relativePath = relative(rootPath, filePath).replace(/\.md$/i, "");
  return `/${relativePath
    .split(/[\\/]+/)
    .filter(Boolean)
    .join("/")}`;
}

async function readCommandMetadata(params: { filePath: string; rootPath: string }): Promise<{
  argumentHint?: string;
  description?: string;
  name: string;
}> {
  const name = getCommandNameFromPath(params.rootPath, params.filePath);
  try {
    const content = await readFile(params.filePath, "utf-8");
    const parsed = CommandFileParser.parseCommandFile(content, params.filePath);
    return {
      name,
      ...(parsed?.description ? { description: parsed.description } : {}),
      ...(parsed?.argumentHint ? { argumentHint: parsed.argumentHint } : {}),
    };
  } catch {
    return { name };
  }
}

async function readPluginMetadata(pluginPath: string): Promise<{
  id: string;
  name: string;
  version?: string;
} | null> {
  const manifestPath = await findPluginManifestPath(pluginPath);
  if (!manifestPath) {
    return null;
  }
  try {
    const parsed = JSON.parse(await readFile(manifestPath, "utf-8")) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
    if (name.length === 0) {
      return null;
    }
    const version =
      typeof parsed.version === "string" && parsed.version.trim().length > 0
        ? parsed.version.trim()
        : undefined;
    return {
      id: `${name}@${INLINE_PLUGIN_MARKETPLACE}`,
      name,
      ...(version ? { version } : {}),
    };
  } catch {
    return null;
  }
}

async function collectExistingCommandNameKeys(rootPath: string): Promise<Set<string>> {
  const nameKeys = new Set<string>();
  if (!(await exists(rootPath))) {
    return nameKeys;
  }
  for (const commandPath of await collectCommandMarkdownPaths(rootPath)) {
    nameKeys.add(normalizeCommandNameKey(getCommandNameFromPath(rootPath, commandPath)));
  }
  return nameKeys;
}

async function readJsonFileOrEmpty(filePath: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf-8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeMcpServerNameKey(name: string): string {
  return name.trim().toLowerCase();
}

function normalizeMcpServerMap(value: unknown): Record<string, McpServerConfig> {
  if (!isRecord(value)) {
    return {};
  }
  const servers: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(value)) {
    if (!name.trim() || !isRecord(config)) {
      continue;
    }
    servers[name] = config as McpServerConfig;
  }
  return servers;
}

function stripExternalMcpTimeoutFields(config: McpServerConfig): McpServerConfig {
  const {
    timeout: _timeout,
    startup_timeout_sec: _startupTimeoutSec,
    ...rest
  } = config as Record<string, unknown>;
  return rest as McpServerConfig;
}

function readZcodeMcpServers(parsed: Record<string, unknown>): Record<string, McpServerConfig> {
  if (!isRecord(parsed.mcp)) {
    return {};
  }
  return normalizeMcpServerMap(parsed.mcp.servers);
}

function readWrappedMcpServers(parsed: Record<string, unknown>): Record<string, McpServerConfig> {
  return normalizeMcpServerMap(parsed.mcpServers);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function isValidUrl(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function normalizeClineMcpOAuthClient(
  value: unknown,
): { type: "authorization_code"; clientId: string; clientSecret?: string } | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return null;
  }
  const { clientId, clientSecret } = value;
  if (
    typeof clientId !== "string" ||
    clientId.length === 0 ||
    (clientSecret !== undefined && (typeof clientSecret !== "string" || clientSecret.length === 0))
  ) {
    return null;
  }
  return {
    type: "authorization_code",
    clientId,
    ...(typeof clientSecret === "string" ? { clientSecret } : {}),
  };
}

function normalizeClineMcpConfig(config: McpServerConfig): McpServerConfig | null {
  const raw = config as Record<string, unknown>;
  const transport = isRecord(raw.transport) ? raw.transport : raw;
  const isNestedTransport = transport !== raw;
  // Причина: Cline хранит timeout в секундах. Соблюдаем границы Cline, чтобы ошибочные миллисекунды не отключали сервер.
  const timeoutMs =
    typeof raw.timeout === "number" && Number.isFinite(raw.timeout)
      ? Math.round(Math.min(Math.max(raw.timeout, 1), 3600) * 1000)
      : undefined;
  const rawType = isNestedTransport
    ? transport.type
    : (raw.type ?? (raw.transportType === "http" ? "streamableHttp" : raw.transportType));
  const transportType =
    rawType === undefined
      ? typeof transport.command === "string"
        ? "stdio"
        : isValidUrl(transport.url)
          ? "sse"
          : undefined
      : rawType;

  if (
    (raw.disabled !== undefined && typeof raw.disabled !== "boolean") ||
    (isNestedTransport && typeof transport.type !== "string")
  ) {
    return null;
  }

  const enabled = raw.disabled === true ? false : undefined;
  if (transportType === "stdio") {
    if (
      typeof transport.command !== "string" ||
      transport.command.length === 0 ||
      (transport.args !== undefined &&
        (!Array.isArray(transport.args) ||
          !transport.args.every((item): item is string => typeof item === "string"))) ||
      (transport.cwd !== undefined &&
        (typeof transport.cwd !== "string" || transport.cwd.length === 0)) ||
      (transport.env !== undefined && !isStringRecord(transport.env))
    ) {
      return null;
    }
    return {
      type: "stdio",
      command: transport.command,
      ...(Array.isArray(transport.args) ? { args: transport.args } : {}),
      ...(typeof transport.cwd === "string" ? { cwd: transport.cwd } : {}),
      ...(isStringRecord(transport.env) ? { env: transport.env } : {}),
      ...(enabled === false ? { enabled } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    };
  }

  if (transportType !== "sse" && transportType !== "streamableHttp") {
    return null;
  }
  if (
    !isValidUrl(transport.url) ||
    (transport.headers !== undefined && !isStringRecord(transport.headers))
  ) {
    return null;
  }

  const oauthClient = normalizeClineMcpOAuthClient(raw.oauthClient);
  if (raw.oauthClient !== undefined && oauthClient === null) {
    return null;
  }
  return {
    type: transportType === "sse" ? "sse" : "http",
    url: transport.url,
    ...(isStringRecord(transport.headers) ? { headers: transport.headers } : {}),
    ...(oauthClient ? { oauth: oauthClient } : {}),
    ...(enabled === false ? { enabled } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

function readClineMcpServers(
  parsed: Record<string, unknown>,
  sourcePath: string,
): McpSourceFileReadResult {
  if (!isRecord(parsed.mcpServers)) {
    return {
      servers: {},
      diagnostics: [{ path: sourcePath, code: "invalidConfig" }],
    };
  }

  const servers: Record<string, McpServerConfig> = {};
  const oauthReauthenticationRequiredNames: string[] = [];
  let invalidEntryCount = 0;
  for (const [name, config] of Object.entries(parsed.mcpServers)) {
    if (!name.trim() || !isRecord(config)) {
      invalidEntryCount += 1;
      continue;
    }
    const normalized = normalizeClineMcpConfig(config as McpServerConfig);
    if (!normalized) {
      invalidEntryCount += 1;
      continue;
    }
    servers[name] = normalized;
    // 修复依据：Cline 的 oauth 是本地会话状态；只记录服务器名用于提示重新授权，不读取或搬运其中的值。
    if (isRecord(config.oauth) && Object.keys(config.oauth).length > 0) {
      oauthReauthenticationRequiredNames.push(name);
    }
  }

  return {
    servers,
    ...(oauthReauthenticationRequiredNames.length > 0
      ? { oauthReauthenticationRequiredNames }
      : {}),
    diagnostics:
      invalidEntryCount > 0
        ? [{ path: sourcePath, code: "invalidEntries", count: invalidEntryCount }]
        : [],
  };
}

function prepareMcpConfigForTargetScope(
  candidate: McpImportCandidate,
  targetScope: SettingsSyncSourceScope,
): { config: McpServerConfig; warnings?: SettingsSyncMcpServerImportWarning[] } {
  const config: McpServerConfig = { ...candidate.config };
  if (candidate.agent !== "cline" || targetScope !== "project") {
    return {
      config,
      ...(candidate.requiresOAuthReauthentication
        ? { warnings: ["clineOAuthReauthenticationRequired"] }
        : {}),
    };
  }

  let secretsOmitted = false;
  if (config.env && Object.keys(config.env).length > 0) {
    delete config.env;
    secretsOmitted = true;
  }
  if (config.headers && Object.keys(config.headers).length > 0) {
    delete config.headers;
    secretsOmitted = true;
  }
  if (
    config.oauth &&
    typeof config.oauth.clientSecret === "string" &&
    config.oauth.clientSecret.length > 0
  ) {
    const oauthConfig = { ...config.oauth };
    delete (oauthConfig as { clientSecret?: string }).clientSecret;
    config.oauth = oauthConfig;
    secretsOmitted = true;
  }

  const warnings: SettingsSyncMcpServerImportWarning[] = [];
  if (secretsOmitted) warnings.push("secretsOmittedForProjectScope");
  if (candidate.requiresOAuthReauthentication) {
    warnings.push("clineOAuthReauthenticationRequired");
  }
  return { config, ...(warnings.length > 0 ? { warnings } : {}) };
}

interface ClineNpmBinCommand {
  commandPath: string;
  commandName: string;
  installRoot: string;
}

function parseClineNpmBinCommand(command: string): ClineNpmBinCommand | undefined {
  if (!isAbsolute(command)) return undefined;
  const commandPath = resolve(command);
  const binDirectory = dirname(commandPath);
  const nodeModulesDirectory = dirname(binDirectory);
  const installRoot = dirname(nodeModulesDirectory);
  if (
    basename(binDirectory) !== ".bin" ||
    basename(nodeModulesDirectory) !== "node_modules" ||
    basename(dirname(installRoot)) !== "mcp-servers" ||
    basename(installRoot).length === 0
  ) {
    return undefined;
  }
  return { commandPath, commandName: basename(commandPath), installRoot };
}

function isPathWithin(parentPath: string, childPath: string): boolean {
  const pathFromParent = relative(parentPath, childPath);
  return (
    pathFromParent === "" ||
    (!isAbsolute(pathFromParent) &&
      pathFromParent !== ".." &&
      !pathFromParent.startsWith(`..${sep}`))
  );
}

async function findClinePackageForBin(
  command: ClineNpmBinCommand,
  configuredMcpServersRoot: string,
): Promise<{ name: string; version: string } | undefined> {
  try {
    const linkInfo = await lstat(command.commandPath);
    if (!linkInfo.isSymbolicLink()) return undefined;
    const realMcpServersRoot = await realpath(configuredMcpServersRoot);
    const realInstallRoot = await realpath(command.installRoot);
    const resolvedCommand = await realpath(command.commandPath);
    // Причина: похожий абсолютный путь сам по себе не доказывает, что пакет принадлежит Cline.
    // Сверяем реальную ссылку с настроенной папкой Cline, чтобы не переписывать чужие команды.
    if (
      dirname(realInstallRoot) !== realMcpServersRoot ||
      !isPathWithin(realInstallRoot, resolvedCommand)
    ) {
      return undefined;
    }

    const nodeModulesDirectory = join(realInstallRoot, "node_modules");
    let packageDirectory = dirname(resolvedCommand);
    while (isPathWithin(nodeModulesDirectory, packageDirectory)) {
      const packagePath = join(packageDirectory, "package.json");
      try {
        const parsed = JSON.parse(await readFile(packagePath, "utf-8")) as Record<string, unknown>;
        const name = typeof parsed.name === "string" ? parsed.name : undefined;
        const version = typeof parsed.version === "string" ? parsed.version : undefined;
        const bin = parsed.bin;
        const declaredBin =
          typeof bin === "string"
            ? basename(name ?? "") === command.commandName
              ? bin
              : undefined
            : isRecord(bin) && typeof bin[command.commandName] === "string"
              ? (bin[command.commandName] as string)
              : undefined;
        if (name && version && declaredBin) {
          const resolvedDeclaredBin = await realpath(resolve(packageDirectory, declaredBin));
          if (resolvedDeclaredBin === resolvedCommand) return { name, version };
        }
      } catch {
        // Проверяем следующий родительский package.json; конфиг импорта не должен падать из-за метаданных.
      }

      const parentDirectory = dirname(packageDirectory);
      if (parentDirectory === packageDirectory) break;
      packageDirectory = parentDirectory;
    }
  } catch {
    // Отсутствующая команда или повреждённая ссылка не должны блокировать импорт Cline.
  }
  return undefined;
}

async function findPortableClinePreset(
  config: McpServerConfig,
): Promise<McpServerConfig | undefined> {
  if (
    config.type !== "stdio" ||
    typeof config.command !== "string" ||
    (config.args?.length ?? 0) > 0 ||
    config.cwd !== undefined
  ) {
    return undefined;
  }
  const command = parseClineNpmBinCommand(config.command);
  if (!command) return undefined;
  const installedPackage = await findClinePackageForBin(command, getClineMcpServersRoot());
  if (!installedPackage) return undefined;
  const preset = COMMUNITY_MCP_PRESETS.find(
    (entry) =>
      entry.kind === "stdio" &&
      entry.packageName === installedPackage.name &&
      entry.version === installedPackage.version,
  );
  if (!preset || preset.kind !== "stdio") return undefined;

  const portableConfig = communityMcpPresetConfig(preset);
  return {
    ...portableConfig,
    ...(config.enabled === false ? { enabled: false } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.env && Object.keys(config.env).length > 0 ? { env: { ...config.env } } : {}),
  };
}

async function prepareClineMcpConfigForTargetScope(
  candidate: McpImportCandidate,
  targetScope: SettingsSyncSourceScope,
): Promise<{ config: McpServerConfig; warnings?: SettingsSyncMcpServerImportWarning[] }> {
  const command =
    candidate.agent === "cline" &&
    candidate.config.type === "stdio" &&
    typeof candidate.config.command === "string"
      ? parseClineNpmBinCommand(candidate.config.command)
      : undefined;
  const portablePresetConfig =
    command && candidate.agent === "cline"
      ? await findPortableClinePreset(candidate.config)
      : undefined;
  const prepared = prepareMcpConfigForTargetScope(
    candidate.agent === "cline" && portablePresetConfig
      ? { ...candidate, config: portablePresetConfig }
      : candidate,
    targetScope,
  );
  const warnings = [...(prepared.warnings ?? [])];
  if (portablePresetConfig) warnings.push("clinePortablePresetApplied");
  else if (command) warnings.push("clineCommandMayNotBePortable");
  return { config: prepared.config, ...(warnings.length > 0 ? { warnings } : {}) };
}

function readOpenCodeMcpServers(parsed: Record<string, unknown>): Record<string, McpServerConfig> {
  const servers = normalizeMcpServerMap(parsed.mcp);
  return Object.fromEntries(
    Object.entries(servers).map(([name, config]) => [name, normalizeOpenCodeMcpConfig(config)]),
  );
}

function normalizeOpenCodeMcpConfig(config: McpServerConfig): McpServerConfig {
  const rawCommand = (config as Record<string, unknown>).command;
  if (Array.isArray(rawCommand)) {
    const [firstCommand, ...args] = rawCommand.filter(
      (item): item is string => typeof item === "string",
    );
    if (firstCommand) {
      const { command: _command, type, ...rest } = config;
      return {
        ...rest,
        command: firstCommand,
        args,
        ...(type === "local" ? { type: "stdio" } : type === "remote" ? { type: "http" } : {}),
      };
    }
  }
  if (config.type === "local" && typeof rawCommand === "string" && rawCommand.trim()) {
    return {
      ...config,
      type: "stdio",
      command: rawCommand.trim(),
    };
  }
  return config;
}

function readTomlMcpServers(parsed: Record<string, unknown>): Record<string, McpServerConfig> {
  return normalizeMcpServerMap(parsed.mcp_servers ?? parsed.mcpServers);
}

async function readMcpServersFromSourceFile(
  filePath: string,
  format: McpConfigFormat,
): Promise<McpSourceFileReadResult> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    return {
      servers: {},
      diagnostics: format === "clineMcpJson" ? [{ path: filePath, code: "unreadable" }] : [],
    };
  }

  if (format === "clineMcpJson") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return {
        servers: {},
        diagnostics: [{ path: filePath, code: "invalidConfig" }],
      };
    }
    if (!isRecord(parsed)) {
      return {
        servers: {},
        diagnostics: [{ path: filePath, code: "invalidConfig" }],
      };
    }
    return readClineMcpServers(parsed, filePath);
  }

  try {
    if (format === "codexToml") {
      return {
        servers: readTomlMcpServers(parseToml(raw) as Record<string, unknown>),
        diagnostics: [],
      };
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return { servers: {}, diagnostics: [] };
    }
    switch (format) {
      case "mcpJson":
        return { servers: readOpenCodeMcpServers(parsed), diagnostics: [] };
      default:
        return { servers: readWrappedMcpServers(parsed), diagnostics: [] };
    }
  } catch {
    return { servers: {}, diagnostics: [] };
  }
}

async function collectExistingMcpServerNameKeys(
  targetScope: SettingsSyncSourceScope,
  workspacePath: string | undefined,
): Promise<Set<string>> {
  const nameKeys = new Set<string>();
  const targetConfigPath = resolveMcpConfigPathForScope(targetScope, workspacePath);
  if (targetConfigPath) {
    for (const name of Object.keys(
      readZcodeMcpServers(await readJsonFileOrEmpty(targetConfigPath)),
    )) {
      nameKeys.add(normalizeMcpServerNameKey(name));
    }
  }
  return nameKeys;
}

async function addMcpServerToZcodeConfig(
  filePath: string,
  name: string,
  config: McpServerConfig,
): Promise<void> {
  const parsed = await readJsonFileOrEmpty(filePath);
  const currentMcp = isRecord(parsed.mcp) ? parsed.mcp : {};
  const servers = readZcodeMcpServers(parsed);
  await writeJsonFile(
    filePath,
    {
      ...parsed,
      mcp: {
        ...currentMcp,
        servers: {
          ...servers,
          [name]: config,
        },
      },
    },
    { privateFile: true },
  );
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

async function writeJsonFile(
  filePath: string,
  value: Record<string, unknown>,
  options?: { privateFile?: boolean },
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const privateFile = options?.privateFile === true;
  if (privateFile) {
    try {
      await chmod(filePath, PRIVATE_MCP_CONFIG_FILE_MODE);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  await writeFile(
    filePath,
    `${JSON.stringify(value, null, 2)}\n`,
    privateFile ? { encoding: "utf-8", mode: PRIVATE_MCP_CONFIG_FILE_MODE } : "utf-8",
  );
  if (privateFile) {
    await chmod(filePath, PRIVATE_MCP_CONFIG_FILE_MODE);
  }
}

async function addPluginDirToConfig(filePath: string, pluginPath: string): Promise<void> {
  const parsed = await readJsonFileOrEmpty(filePath);
  const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
  const dirs = readStringArray(plugins.dirs);
  const resolvedPluginPath = resolve(pluginPath);
  if (dirs.map((item) => resolve(item)).includes(resolvedPluginPath)) {
    return;
  }
  await writeJsonFile(filePath, {
    ...parsed,
    plugins: {
      ...plugins,
      dirs: [...dirs, resolvedPluginPath],
    },
  });
}

async function collectConfiguredPluginIds(configPath: string): Promise<Set<string>> {
  const parsed = await readJsonFileOrEmpty(configPath);
  const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
  const ids = new Set<string>();
  for (const pluginPath of readStringArray(plugins.dirs)) {
    const metadata = await readPluginMetadata(resolve(pluginPath));
    if (metadata) {
      ids.add(metadata.id.toLowerCase());
    }
  }
  return ids;
}

async function isSkillImportCandidateImportable(
  candidate: SkillImportCandidate,
  existingNameKeysByTargetRoot: Map<string, Set<string>>,
): Promise<boolean> {
  return (
    (await getSkillImportCandidateSkipReason(candidate, existingNameKeysByTargetRoot)) === undefined
  );
}

async function getSkillImportCandidateSkipReason(
  candidate: SkillImportCandidate,
  existingNameKeysByTargetRoot: Map<string, Set<string>>,
): Promise<SettingsSyncSkillSkipReason | undefined> {
  if (await exists(candidate.targetPath)) {
    return "targetExists";
  }
  let existingNameKeys = existingNameKeysByTargetRoot.get(candidate.targetRoot);
  if (!existingNameKeys) {
    existingNameKeys = await collectExistingSkillNameKeys(candidate.targetRoot);
    existingNameKeysByTargetRoot.set(candidate.targetRoot, existingNameKeys);
  }
  return existingNameKeys.has(candidate.nameKey) ? "sameNameExists" : undefined;
}

async function getCommandImportCandidateSkipReason(
  candidate: CommandImportCandidate,
  existingNameKeysByTargetRoot: Map<string, Set<string>>,
): Promise<SettingsSyncCommandSkipReason | undefined> {
  if (await pathExists(candidate.targetPath)) {
    return "targetExists";
  }
  let existingNameKeys = existingNameKeysByTargetRoot.get(candidate.targetRoot);
  if (!existingNameKeys) {
    existingNameKeys = await collectExistingCommandNameKeys(candidate.targetRoot);
    existingNameKeysByTargetRoot.set(candidate.targetRoot, existingNameKeys);
  }
  return existingNameKeys.has(candidate.nameKey) ? "sameNameExists" : undefined;
}

async function isCommandImportCandidateImportable(
  candidate: CommandImportCandidate,
  existingNameKeysByTargetRoot: Map<string, Set<string>>,
): Promise<boolean> {
  return (
    (await getCommandImportCandidateSkipReason(candidate, existingNameKeysByTargetRoot)) ===
    undefined
  );
}

async function getPluginImportCandidateSkipReason(
  candidate: PluginImportCandidate,
  existingPluginIdsByConfigPath: Map<string, Set<string>>,
  workspacePath: string | undefined,
  targetScope: SettingsSyncSourceScope = candidate.sourceRootScope,
): Promise<SettingsSyncPluginSkipReason | undefined> {
  if (await pathExists(candidate.targetPath)) {
    return "targetExists";
  }
  const configPath = resolvePluginConfigPathForScope(targetScope, workspacePath);
  if (!configPath) {
    return "targetExists";
  }
  let existingPluginIds = existingPluginIdsByConfigPath.get(configPath);
  if (!existingPluginIds) {
    existingPluginIds = await collectConfiguredPluginIds(configPath);
    existingPluginIdsByConfigPath.set(configPath, existingPluginIds);
  }
  return existingPluginIds.has(candidate.id.toLowerCase()) ? "sameNameExists" : undefined;
}

async function isPluginImportCandidateImportable(
  candidate: PluginImportCandidate,
  existingPluginIdsByConfigPath: Map<string, Set<string>>,
  workspacePath: string | undefined,
  targetScope: SettingsSyncSourceScope = candidate.sourceRootScope,
): Promise<boolean> {
  return (
    (await getPluginImportCandidateSkipReason(
      candidate,
      existingPluginIdsByConfigPath,
      workspacePath,
      targetScope,
    )) === undefined
  );
}

async function getMcpImportCandidateSkipReason(
  candidate: McpImportCandidate,
  existingNameKeysByTargetScope: Map<SettingsSyncSourceScope, Set<string>>,
  workspacePath: string | undefined,
  targetScope: SettingsSyncSourceScope = candidate.sourceRootScope,
): Promise<SettingsSyncMcpServerSkipReason | undefined> {
  let existingNameKeys = existingNameKeysByTargetScope.get(targetScope);
  if (!existingNameKeys) {
    existingNameKeys = await collectExistingMcpServerNameKeys(targetScope, workspacePath);
    existingNameKeysByTargetScope.set(targetScope, existingNameKeys);
  }
  return existingNameKeys.has(candidate.nameKey) ? "sameNameExists" : undefined;
}

async function isMcpImportCandidateImportable(
  candidate: McpImportCandidate,
  existingNameKeysByTargetScope: Map<SettingsSyncSourceScope, Set<string>>,
  workspacePath: string | undefined,
  targetScope: SettingsSyncSourceScope = candidate.sourceRootScope,
): Promise<boolean> {
  return (
    (await getMcpImportCandidateSkipReason(
      candidate,
      existingNameKeysByTargetScope,
      workspacePath,
      targetScope,
    )) === undefined
  );
}

async function buildSourceRootSummaries(
  candidates: SkillImportCandidate[],
): Promise<SettingsSyncSourceRootSummary[]> {
  const existingNameKeysByTargetRoot = new Map<string, Set<string>>();
  const grouped = new Map<string, SkillImportCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.sourceRootScope}:${candidate.sourceRootPath}`;
    grouped.set(key, [...(grouped.get(key) ?? []), candidate]);
  }

  const summaries: SettingsSyncSourceRootSummary[] = [];
  for (const groupCandidates of grouped.values()) {
    const firstCandidate = groupCandidates[0];
    if (!firstCandidate) {
      continue;
    }
    let importableCount = 0;
    const skills = [];
    for (const candidate of groupCandidates) {
      const skipReason = await getSkillImportCandidateSkipReason(
        candidate,
        existingNameKeysByTargetRoot,
      );
      const importable = skipReason === undefined;
      if (importable) {
        importableCount += 1;
      }
      skills.push({
        name: candidate.name,
        path: candidate.sourcePath,
        importable,
        ...(skipReason ? { skipReason } : {}),
        ...(candidate.version ? { version: candidate.version } : {}),
      });
    }
    summaries.push({
      scope: firstCandidate.sourceRootScope,
      path: firstCandidate.sourceRootPath,
      discoveredCount: groupCandidates.length,
      importableCount,
      skippedCount: groupCandidates.length - importableCount,
      skills: skills.sort((left, right) => left.name.localeCompare(right.name)),
    });
  }

  return summaries.sort((left, right) => {
    const byScope = left.scope.localeCompare(right.scope);
    return byScope !== 0 ? byScope : left.path.localeCompare(right.path);
  });
}

async function buildCommandSourceRootSummaries(
  candidates: CommandImportCandidate[],
): Promise<SettingsSyncSourceRootSummary[]> {
  const existingNameKeysByTargetRoot = new Map<string, Set<string>>();
  const grouped = new Map<string, CommandImportCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.sourceRootScope}:${candidate.sourceRootPath}`;
    grouped.set(key, [...(grouped.get(key) ?? []), candidate]);
  }

  const summaries: SettingsSyncSourceRootSummary[] = [];
  for (const groupCandidates of grouped.values()) {
    const firstCandidate = groupCandidates[0];
    if (!firstCandidate) {
      continue;
    }
    let importableCount = 0;
    const commands = [];
    for (const candidate of groupCandidates) {
      const skipReason = await getCommandImportCandidateSkipReason(
        candidate,
        existingNameKeysByTargetRoot,
      );
      const importable = skipReason === undefined;
      if (importable) {
        importableCount += 1;
      }
      commands.push({
        name: candidate.name,
        path: candidate.sourcePath,
        importable,
        ...(skipReason ? { skipReason } : {}),
        ...(candidate.description ? { description: candidate.description } : {}),
        ...(candidate.argumentHint ? { argumentHint: candidate.argumentHint } : {}),
      });
    }
    summaries.push({
      scope: firstCandidate.sourceRootScope,
      path: firstCandidate.sourceRootPath,
      discoveredCount: groupCandidates.length,
      importableCount,
      skippedCount: groupCandidates.length - importableCount,
      commands: commands.sort((left, right) => left.name.localeCompare(right.name)),
    });
  }

  return summaries.sort((left, right) => {
    const byScope = left.scope.localeCompare(right.scope);
    return byScope !== 0 ? byScope : left.path.localeCompare(right.path);
  });
}

async function buildPluginSourceRootSummaries(
  candidates: PluginImportCandidate[],
  workspacePath: string | undefined,
): Promise<SettingsSyncSourceRootSummary[]> {
  const existingPluginIdsByConfigPath = new Map<string, Set<string>>();
  const grouped = new Map<string, PluginImportCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.sourceRootScope}:${candidate.sourceRootPath}`;
    grouped.set(key, [...(grouped.get(key) ?? []), candidate]);
  }

  const summaries: SettingsSyncSourceRootSummary[] = [];
  for (const groupCandidates of grouped.values()) {
    const firstCandidate = groupCandidates[0];
    if (!firstCandidate) {
      continue;
    }
    let importableCount = 0;
    const plugins = [];
    for (const candidate of groupCandidates) {
      const skipReason = await getPluginImportCandidateSkipReason(
        candidate,
        existingPluginIdsByConfigPath,
        workspacePath,
      );
      const importable = skipReason === undefined;
      if (importable) {
        importableCount += 1;
      }
      plugins.push({
        name: candidate.name,
        path: candidate.sourcePath,
        importable,
        ...(skipReason ? { skipReason } : {}),
        ...(candidate.version ? { version: candidate.version } : {}),
      });
    }
    summaries.push({
      scope: firstCandidate.sourceRootScope,
      path: firstCandidate.sourceRootPath,
      discoveredCount: groupCandidates.length,
      importableCount,
      skippedCount: groupCandidates.length - importableCount,
      plugins: plugins.sort((left, right) => left.name.localeCompare(right.name)),
    });
  }

  return summaries.sort((left, right) => {
    const byScope = left.scope.localeCompare(right.scope);
    return byScope !== 0 ? byScope : left.path.localeCompare(right.path);
  });
}

async function buildMcpSourceRootSummaries(
  candidates: McpImportCandidate[],
  workspacePath: string | undefined,
): Promise<SettingsSyncSourceRootSummary[]> {
  const existingNameKeysByTargetScope = new Map<SettingsSyncSourceScope, Set<string>>();
  const grouped = new Map<string, McpImportCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.sourceRootScope}:${candidate.sourceRootPath}`;
    grouped.set(key, [...(grouped.get(key) ?? []), candidate]);
  }

  const summaries: SettingsSyncSourceRootSummary[] = [];
  for (const groupCandidates of grouped.values()) {
    const firstCandidate = groupCandidates[0];
    if (!firstCandidate) {
      continue;
    }
    let importableCount = 0;
    const mcpServers = [];
    for (const candidate of groupCandidates) {
      const skipReason = await getMcpImportCandidateSkipReason(
        candidate,
        existingNameKeysByTargetScope,
        workspacePath,
      );
      const importable = skipReason === undefined;
      if (importable) {
        importableCount += 1;
      }
      mcpServers.push({
        name: candidate.name,
        path: candidate.sourcePath,
        importable,
        ...(skipReason ? { skipReason } : {}),
      });
    }
    summaries.push({
      scope: firstCandidate.sourceRootScope,
      path: firstCandidate.sourceRootPath,
      discoveredCount: groupCandidates.length,
      importableCount,
      skippedCount: groupCandidates.length - importableCount,
      mcpServers: mcpServers.sort((left, right) => left.name.localeCompare(right.name)),
    });
  }

  return summaries.sort((left, right) => {
    const byScope = left.scope.localeCompare(right.scope);
    return byScope !== 0 ? byScope : left.path.localeCompare(right.path);
  });
}

async function collectSkillImportCandidates(
  workspacePath?: string,
): Promise<SkillImportCandidate[]> {
  const candidates: SkillImportCandidate[] = [];
  const seenSourcePaths = new Set<string>();
  for (const root of getExternalSkillRoots(workspacePath)) {
    if (!(await exists(root.rootPath))) {
      continue;
    }
    for (const skillPath of await collectSkillMarkdownPaths(root.rootPath)) {
      if (seenSourcePaths.has(skillPath)) {
        continue;
      }
      seenSourcePaths.add(skillPath);
      const sourceDir = dirname(skillPath);
      const targetRoot = resolveCandidateTargetRoot(root.scope, workspacePath);
      if (!targetRoot) {
        continue;
      }
      const skillMetadata = await readSkillMetadata(skillPath);
      candidates.push({
        agent: root.agent,
        name: skillMetadata.name,
        nameKey: normalizeSkillNameKey(skillMetadata.name),
        ...(skillMetadata.version ? { version: skillMetadata.version } : {}),
        sourceRootScope: root.scope === "workspace" ? "project" : "global",
        sourceRootPath: root.rootPath,
        sourcePath: sourceDir,
        targetRoot,
        targetPath: join(targetRoot, basename(sourceDir)),
        scope: root.scope,
      });
    }
  }
  return candidates;
}

async function collectCommandImportCandidates(
  workspacePath?: string,
): Promise<CommandImportCandidate[]> {
  const candidates: CommandImportCandidate[] = [];
  const seenSourcePaths = new Set<string>();
  for (const root of getExternalCommandRoots(workspacePath)) {
    if (!(await exists(root.rootPath))) {
      continue;
    }
    for (const commandPath of await collectCommandMarkdownPaths(root.rootPath)) {
      if (seenSourcePaths.has(commandPath)) {
        continue;
      }
      seenSourcePaths.add(commandPath);
      const targetRoot = resolveCommandCandidateTargetRoot(root.scope, workspacePath);
      if (!targetRoot) {
        continue;
      }
      const metadata = await readCommandMetadata({
        filePath: commandPath,
        rootPath: root.rootPath,
      });
      const sourceRelativePath = relative(root.rootPath, commandPath);
      candidates.push({
        agent: root.agent,
        name: metadata.name,
        nameKey: normalizeCommandNameKey(metadata.name),
        ...(metadata.description ? { description: metadata.description } : {}),
        ...(metadata.argumentHint ? { argumentHint: metadata.argumentHint } : {}),
        sourceRootScope: root.scope === "workspace" ? "project" : "global",
        sourceRootPath: root.rootPath,
        sourcePath: commandPath,
        sourceRelativePath,
        targetRoot,
        targetPath: join(targetRoot, sourceRelativePath),
        scope: root.scope,
      });
    }
  }
  return candidates;
}

async function collectPluginImportCandidates(
  workspacePath?: string,
): Promise<PluginImportCandidate[]> {
  const candidates: PluginImportCandidate[] = [];
  const seenSourcePaths = new Set<string>();
  for (const root of getExternalPluginRoots(workspacePath)) {
    if (!(await exists(root.rootPath))) {
      continue;
    }
    for (const pluginPath of await collectPluginPaths(root.rootPath)) {
      if (seenSourcePaths.has(pluginPath)) {
        continue;
      }
      seenSourcePaths.add(pluginPath);
      const targetRoot = resolvePluginCandidateTargetRoot(root.scope, workspacePath);
      if (!targetRoot) {
        continue;
      }
      const metadata = await readPluginMetadata(pluginPath);
      if (!metadata) {
        continue;
      }
      candidates.push({
        agent: root.agent,
        id: metadata.id,
        name: metadata.name,
        ...(metadata.version ? { version: metadata.version } : {}),
        sourceRootScope: root.scope === "workspace" ? "project" : "global",
        sourceRootPath: root.rootPath,
        sourcePath: pluginPath,
        targetRoot,
        targetPath: join(targetRoot, basename(pluginPath)),
      });
    }
  }
  return candidates;
}

async function scanMcpImportSources(workspacePath?: string): Promise<{
  candidates: McpImportCandidate[];
  diagnostics: SettingsSyncSourceDiagnostic[];
  roots: McpSourceRoot[];
}> {
  const candidates: McpImportCandidate[] = [];
  const diagnostics: SettingsSyncSourceDiagnostic[] = [];
  const seenSourceNames = new Set<string>();
  const roots = await getExternalMcpRoots(workspacePath);
  for (const root of roots) {
    if (!(await pathExists(root.rootPath))) {
      continue;
    }
    const readResult = await readMcpServersFromSourceFile(root.rootPath, root.format);
    diagnostics.push(...readResult.diagnostics);
    for (const [name, config] of Object.entries(readResult.servers)) {
      const sourcePath = `${root.rootPath}#${name}`;
      const seenKey = `${root.agent}:${sourcePath}`;
      if (seenSourceNames.has(seenKey)) {
        continue;
      }
      seenSourceNames.add(seenKey);
      candidates.push({
        agent: root.agent,
        name,
        nameKey: normalizeMcpServerNameKey(name),
        config: stripExternalMcpTimeoutFields(config),
        sourceRootScope: root.scope === "workspace" ? "project" : "global",
        sourceRootPath: root.rootPath,
        sourcePath,
        ...(readResult.oauthReauthenticationRequiredNames?.includes(name)
          ? { requiresOAuthReauthentication: true }
          : {}),
      });
    }
  }
  return { candidates, diagnostics, roots };
}

async function collectMcpImportCandidates(workspacePath?: string): Promise<McpImportCandidate[]> {
  return (await scanMcpImportSources(workspacePath)).candidates;
}

async function buildSkillsDiscovery(workspacePath?: string): Promise<SettingsSyncDiscoveryResult> {
  const candidates = await collectSkillImportCandidates(workspacePath);
  const agents: SettingsSyncDiscoveryResult["agents"] = [];
  for (const { agent } of SUPPORTED_SKILL_AGENT_SOURCES) {
    const agentCandidates = candidates.filter((candidate) => candidate.agent === agent);
    const discoveredCount = agentCandidates.length;
    const sourcePaths = [
      ...new Set(agentCandidates.map((candidate) => candidate.sourceRootPath)),
    ].sort((left, right) => left.localeCompare(right));
    const sourceRoots = await buildSourceRootSummaries(agentCandidates);
    let importableCount = 0;
    const existingNameKeysByTargetRoot = new Map<string, Set<string>>();
    for (const candidate of agentCandidates) {
      if (await isSkillImportCandidateImportable(candidate, existingNameKeysByTargetRoot)) {
        importableCount += 1;
      }
    }
    agents.push({
      agent,
      discovered: discoveredCount > 0,
      categories: [
        {
          category: "skills",
          discoveredCount,
          importableCount,
          skippedCount: discoveredCount - importableCount,
          sourcePaths,
          sourceRoots,
          selectedByDefault: importableCount > 0,
        },
      ],
    });
  }
  return {
    agents: agents.filter((agent) => agent.discovered),
  };
}

async function buildCommandsDiscovery(
  workspacePath?: string,
): Promise<SettingsSyncDiscoveryResult> {
  const candidates = await collectCommandImportCandidates(workspacePath);
  const agents: SettingsSyncDiscoveryResult["agents"] = [];
  for (const { agent } of SUPPORTED_COMMAND_AGENT_SOURCES) {
    const agentCandidates = candidates.filter((candidate) => candidate.agent === agent);
    const discoveredCount = agentCandidates.length;
    const sourcePaths = [
      ...new Set(agentCandidates.map((candidate) => candidate.sourceRootPath)),
    ].sort((left, right) => left.localeCompare(right));
    const sourceRoots = await buildCommandSourceRootSummaries(agentCandidates);
    let importableCount = 0;
    const existingNameKeysByTargetRoot = new Map<string, Set<string>>();
    for (const candidate of agentCandidates) {
      if (await isCommandImportCandidateImportable(candidate, existingNameKeysByTargetRoot)) {
        importableCount += 1;
      }
    }
    agents.push({
      agent,
      discovered: discoveredCount > 0,
      categories: [
        {
          category: "commands",
          discoveredCount,
          importableCount,
          skippedCount: discoveredCount - importableCount,
          sourcePaths,
          sourceRoots,
          selectedByDefault: false,
        },
      ],
    });
  }
  return {
    agents: agents.filter((agent) => agent.discovered),
  };
}

async function buildPluginsDiscovery(workspacePath?: string): Promise<SettingsSyncDiscoveryResult> {
  const candidates = await collectPluginImportCandidates(workspacePath);
  const agents: SettingsSyncDiscoveryResult["agents"] = [];
  for (const { agent } of SUPPORTED_PLUGIN_AGENT_SOURCES) {
    const agentCandidates = candidates.filter((candidate) => candidate.agent === agent);
    const discoveredCount = agentCandidates.length;
    const sourcePaths = [
      ...new Set(agentCandidates.map((candidate) => candidate.sourceRootPath)),
    ].sort((left, right) => left.localeCompare(right));
    const sourceRoots = await buildPluginSourceRootSummaries(agentCandidates, workspacePath);
    let importableCount = 0;
    const existingPluginIdsByConfigPath = new Map<string, Set<string>>();
    for (const candidate of agentCandidates) {
      if (
        await isPluginImportCandidateImportable(
          candidate,
          existingPluginIdsByConfigPath,
          workspacePath,
        )
      ) {
        importableCount += 1;
      }
    }
    agents.push({
      agent,
      discovered: discoveredCount > 0,
      categories: [
        {
          category: "plugins",
          discoveredCount,
          importableCount,
          skippedCount: discoveredCount - importableCount,
          sourcePaths,
          sourceRoots,
          selectedByDefault: false,
        },
      ],
    });
  }
  return {
    agents: agents.filter((agent) => agent.discovered),
  };
}

async function buildMcpDiscovery(workspacePath?: string): Promise<SettingsSyncDiscoveryResult> {
  const scan = await scanMcpImportSources(workspacePath);
  const candidates = scan.candidates;
  const sourceRootsByPath = new Map(scan.roots.map((root) => [root.rootPath, root]));
  const agents: SettingsSyncDiscoveryResult["agents"] = [];
  for (const { agent } of SUPPORTED_MCP_AGENT_SOURCES) {
    const agentCandidates = candidates.filter((candidate) => candidate.agent === agent);
    const discoveredCount = agentCandidates.length;
    const sourcePaths = [
      ...new Set(
        [
          ...agentCandidates.map((candidate) => candidate.sourceRootPath),
          ...scan.diagnostics.map((diagnostic) => diagnostic.path),
        ].filter((path) => {
          const source = sourceRootsByPath.get(path);
          return source?.agent === agent;
        }),
      ),
    ].sort((left, right) => left.localeCompare(right));
    const sourceRoots = await buildMcpSourceRootSummaries(agentCandidates, workspacePath);
    let importableCount = 0;
    const existingNameKeysByTargetScope = new Map<SettingsSyncSourceScope, Set<string>>();
    for (const candidate of agentCandidates) {
      if (
        await isMcpImportCandidateImportable(
          candidate,
          existingNameKeysByTargetScope,
          workspacePath,
        )
      ) {
        importableCount += 1;
      }
    }
    const sourceDiagnostics = scan.diagnostics.filter(
      (diagnostic) => sourceRootsByPath.get(diagnostic.path)?.agent === agent,
    );
    agents.push({
      agent,
      discovered: discoveredCount > 0 || sourcePaths.length > 0,
      categories: [
        {
          category: "mcpServers",
          discoveredCount,
          importableCount,
          skippedCount: discoveredCount - importableCount,
          sourcePaths,
          sourceRoots,
          ...(sourceDiagnostics.length > 0 ? { diagnostics: sourceDiagnostics } : {}),
          selectedByDefault: false,
        },
      ],
    });
  }
  return {
    agents: agents.filter((agent) => agent.discovered),
  };
}

async function importSkillsForAgent(
  workspacePath: string | undefined,
  agent: SettingsSyncAgent,
  sourceScope?: SettingsSyncSourceScope,
  targetScope?: SettingsSyncSourceScope,
  importMode: SettingsSyncImportMode = "symlink",
  skillPaths?: string[],
): Promise<SettingsSyncTaskImportResult> {
  const selectedSkillPaths = skillPaths ? new Set(skillPaths) : null;
  const candidates = (await collectSkillImportCandidates(workspacePath)).filter(
    (candidate) =>
      candidate.agent === agent &&
      (!sourceScope || candidate.sourceRootScope === sourceScope) &&
      (!selectedSkillPaths || selectedSkillPaths.has(candidate.sourcePath)),
  );
  let importedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  const skillResults: SettingsSyncSkillImportResult[] = [];
  const existingNameKeysByTargetRoot = new Map<string, Set<string>>();

  for (const candidate of candidates) {
    const selectedTargetRoot = targetScope
      ? resolveTargetRootForScope(targetScope, workspacePath)
      : candidate.targetRoot;
    if (!selectedTargetRoot) {
      skippedCount += 1;
      skillResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "skipped",
        skipReason: "targetExists",
        ...(candidate.version ? { version: candidate.version } : {}),
      });
      continue;
    }
    const targetCandidate = {
      ...candidate,
      targetRoot: selectedTargetRoot,
      targetPath: join(selectedTargetRoot, basename(candidate.sourcePath)),
    };
    const skipReason = await getSkillImportCandidateSkipReason(
      targetCandidate,
      existingNameKeysByTargetRoot,
    );
    if (skipReason) {
      skippedCount += 1;
      skillResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "skipped",
        skipReason,
        ...(candidate.version ? { version: candidate.version } : {}),
      });
      continue;
    }
    try {
      await mkdir(dirname(targetCandidate.targetPath), { recursive: true });
      await importSkillDirectory(candidate.sourcePath, targetCandidate.targetPath, importMode);
      importedCount += 1;
      const existingNameKeys = existingNameKeysByTargetRoot.get(targetCandidate.targetRoot);
      if (existingNameKeys) {
        existingNameKeys.add(candidate.nameKey);
      }
      skillResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "imported",
        ...(candidate.version ? { version: candidate.version } : {}),
      });
    } catch {
      failedCount += 1;
      skillResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "failed",
        ...(candidate.version ? { version: candidate.version } : {}),
      });
    }
  }

  return {
    agent,
    category: "skills",
    status: failedCount > 0 ? "failed" : importedCount > 0 ? "success" : "skipped",
    importedCount,
    skippedCount,
    failedCount,
    skillResults,
  };
}

async function importCommandsForAgent(
  workspacePath: string | undefined,
  agent: SettingsSyncAgent,
  sourceScope?: SettingsSyncSourceScope,
  targetScope?: SettingsSyncSourceScope,
  importMode: SettingsSyncImportMode = "symlink",
  commandPaths?: string[],
): Promise<SettingsSyncTaskImportResult> {
  const selectedCommandPaths = commandPaths ? new Set(commandPaths) : null;
  const candidates = (await collectCommandImportCandidates(workspacePath)).filter(
    (candidate) =>
      candidate.agent === agent &&
      (!sourceScope || candidate.sourceRootScope === sourceScope) &&
      (!selectedCommandPaths || selectedCommandPaths.has(candidate.sourcePath)),
  );
  let importedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  const commandResults: SettingsSyncCommandImportResult[] = [];
  const existingNameKeysByTargetRoot = new Map<string, Set<string>>();

  for (const candidate of candidates) {
    const selectedTargetRoot = targetScope
      ? resolveCommandTargetRootForScope(targetScope, workspacePath)
      : candidate.targetRoot;
    if (!selectedTargetRoot) {
      skippedCount += 1;
      commandResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "skipped",
        skipReason: "targetExists",
      });
      continue;
    }
    const targetCandidate = {
      ...candidate,
      targetRoot: selectedTargetRoot,
      targetPath: join(selectedTargetRoot, candidate.sourceRelativePath),
    };
    const skipReason = await getCommandImportCandidateSkipReason(
      targetCandidate,
      existingNameKeysByTargetRoot,
    );
    if (skipReason) {
      skippedCount += 1;
      commandResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "skipped",
        skipReason,
      });
      continue;
    }
    try {
      await mkdir(dirname(targetCandidate.targetPath), { recursive: true });
      await importCommandFile(candidate.sourcePath, targetCandidate.targetPath, importMode);
      importedCount += 1;
      const existingNameKeys = existingNameKeysByTargetRoot.get(targetCandidate.targetRoot);
      if (existingNameKeys) {
        existingNameKeys.add(candidate.nameKey);
      }
      commandResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "imported",
      });
    } catch {
      failedCount += 1;
      commandResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "failed",
      });
    }
  }

  return {
    agent,
    category: "commands",
    status: failedCount > 0 ? "failed" : importedCount > 0 ? "success" : "skipped",
    importedCount,
    skippedCount,
    failedCount,
    commandResults,
  };
}

async function importPluginsForAgent(
  workspacePath: string | undefined,
  agent: SettingsSyncAgent,
  sourceScope?: SettingsSyncSourceScope,
  targetScope?: SettingsSyncSourceScope,
  importMode: SettingsSyncImportMode = "symlink",
  pluginPaths?: string[],
): Promise<SettingsSyncTaskImportResult> {
  const selectedPluginPaths = pluginPaths ? new Set(pluginPaths) : null;
  const candidates = (await collectPluginImportCandidates(workspacePath)).filter(
    (candidate) =>
      candidate.agent === agent &&
      (!sourceScope || candidate.sourceRootScope === sourceScope) &&
      (!selectedPluginPaths || selectedPluginPaths.has(candidate.sourcePath)),
  );
  let importedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  const pluginResults: SettingsSyncPluginImportResult[] = [];
  const existingPluginIdsByConfigPath = new Map<string, Set<string>>();

  for (const candidate of candidates) {
    const selectedTargetScope = targetScope ?? candidate.sourceRootScope;
    const selectedTargetRoot = resolvePluginTargetRootForScope(selectedTargetScope, workspacePath);
    const selectedConfigPath = resolvePluginConfigPathForScope(selectedTargetScope, workspacePath);
    if (!selectedTargetRoot || !selectedConfigPath) {
      skippedCount += 1;
      pluginResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "skipped",
        skipReason: "targetExists",
        ...(candidate.version ? { version: candidate.version } : {}),
      });
      continue;
    }
    const targetCandidate = {
      ...candidate,
      targetRoot: selectedTargetRoot,
      targetPath: join(selectedTargetRoot, basename(candidate.sourcePath)),
    };
    const skipReason = await getPluginImportCandidateSkipReason(
      targetCandidate,
      existingPluginIdsByConfigPath,
      workspacePath,
      selectedTargetScope,
    );
    if (skipReason) {
      skippedCount += 1;
      pluginResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "skipped",
        skipReason,
        ...(candidate.version ? { version: candidate.version } : {}),
      });
      continue;
    }
    try {
      await mkdir(dirname(targetCandidate.targetPath), { recursive: true });
      await importPluginDirectory(candidate.sourcePath, targetCandidate.targetPath, importMode);
      await addPluginDirToConfig(selectedConfigPath, targetCandidate.targetPath);
      importedCount += 1;
      const existingPluginIds = existingPluginIdsByConfigPath.get(selectedConfigPath);
      if (existingPluginIds) {
        existingPluginIds.add(candidate.id.toLowerCase());
      }
      pluginResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "imported",
        ...(candidate.version ? { version: candidate.version } : {}),
      });
    } catch {
      failedCount += 1;
      pluginResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "failed",
        ...(candidate.version ? { version: candidate.version } : {}),
      });
    }
  }

  return {
    agent,
    category: "plugins",
    status: failedCount > 0 ? "failed" : importedCount > 0 ? "success" : "skipped",
    importedCount,
    skippedCount,
    failedCount,
    pluginResults,
  };
}

async function importMcpServersForAgent(
  workspacePath: string | undefined,
  agent: SettingsSyncAgent,
  sourceScope?: SettingsSyncSourceScope,
  targetScope?: SettingsSyncSourceScope,
  mcpServerPaths?: string[],
): Promise<SettingsSyncTaskImportResult> {
  const selectedMcpServerPaths = mcpServerPaths ? new Set(mcpServerPaths) : null;
  const candidates = (await collectMcpImportCandidates(workspacePath)).filter(
    (candidate) =>
      candidate.agent === agent &&
      (!sourceScope || candidate.sourceRootScope === sourceScope) &&
      (!selectedMcpServerPaths || selectedMcpServerPaths.has(candidate.sourcePath)),
  );
  let importedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  const mcpServerResults: SettingsSyncMcpServerImportResult[] = [];
  const existingNameKeysByTargetScope = new Map<SettingsSyncSourceScope, Set<string>>();

  for (const candidate of candidates) {
    const selectedTargetScope = targetScope ?? candidate.sourceRootScope;
    const selectedConfigPath = resolveMcpConfigPathForScope(selectedTargetScope, workspacePath);
    if (!selectedConfigPath) {
      skippedCount += 1;
      mcpServerResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "skipped",
        skipReason: "sameNameExists",
      });
      continue;
    }
    const skipReason = await getMcpImportCandidateSkipReason(
      candidate,
      existingNameKeysByTargetScope,
      workspacePath,
      selectedTargetScope,
    );
    if (skipReason) {
      skippedCount += 1;
      mcpServerResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "skipped",
        skipReason,
      });
      continue;
    }
    try {
      const prepared = await prepareClineMcpConfigForTargetScope(candidate, selectedTargetScope);
      await addMcpServerToZcodeConfig(selectedConfigPath, candidate.name, prepared.config);
      importedCount += 1;
      const existingNameKeys = existingNameKeysByTargetScope.get(selectedTargetScope);
      if (existingNameKeys) {
        existingNameKeys.add(candidate.nameKey);
      }
      mcpServerResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "imported",
        ...(prepared.warnings ? { warnings: prepared.warnings } : {}),
      });
    } catch {
      failedCount += 1;
      mcpServerResults.push({
        name: candidate.name,
        path: candidate.sourcePath,
        sourceScope: candidate.sourceRootScope,
        status: "failed",
      });
    }
  }

  return {
    agent,
    category: "mcpServers",
    status: failedCount > 0 ? "failed" : importedCount > 0 ? "success" : "skipped",
    importedCount,
    skippedCount,
    failedCount,
    mcpServerResults,
  };
}

function shouldScanSkills(request: {
  categories?: SettingsSyncCategory[];
  intent?: "firstRun" | "manualImport";
}): boolean {
  return request.intent === "manualImport" && request.categories?.includes("skills") === true;
}

function shouldScanCommands(request: {
  categories?: SettingsSyncCategory[];
  intent?: "firstRun" | "manualImport";
}): boolean {
  return request.intent === "manualImport" && request.categories?.includes("commands") === true;
}

function shouldScanPlugins(request: {
  categories?: SettingsSyncCategory[];
  intent?: "firstRun" | "manualImport";
}): boolean {
  return request.intent === "manualImport" && request.categories?.includes("plugins") === true;
}

function shouldScanMcpServers(request: {
  categories?: SettingsSyncCategory[];
  intent?: "firstRun" | "manualImport";
}): boolean {
  return request.intent === "manualImport" && request.categories?.includes("mcpServers") === true;
}

async function getClaudeAgentsFileMigrationStatus(): Promise<SettingsSyncClaudeAgentsFileMigrationStatus> {
  const sourcePath = getClaudeUserAgentsFileSourcePath();
  const sourceExists = await pathExists(sourcePath);
  const targetPath = getUserZcodeAgentsFilePath();
  const targetExists = await pathExists(targetPath);

  return {
    sourcePath,
    targetPath,
    sourceExists,
    targetExists,
    supported: sourceExists,
    ...(sourceExists ? {} : { unavailableReason: "missingSource" as const }),
  };
}

async function copyClaudeAgentsFileToZcodeAgentsFile(params: {
  overwrite?: boolean;
}): Promise<SettingsSyncClaudeAgentsFileCopyResult> {
  const sourcePath = getClaudeUserAgentsFileSourcePath();
  const targetPath = getUserZcodeAgentsFilePath();
  const sourceExists = await pathExists(sourcePath);
  const targetExists = await pathExists(targetPath);

  if (!sourceExists) {
    return {
      sourcePath,
      targetPath,
      status: "skipped",
      overwritten: false,
      skippedReason: "missingSource",
    };
  }

  if (targetExists && params.overwrite !== true) {
    return {
      sourcePath,
      targetPath,
      status: "skipped",
      overwritten: false,
      skippedReason: "targetExists",
    };
  }

  await mkdir(dirname(targetPath), { recursive: true });
  await copyFile(sourcePath, targetPath);

  return {
    sourcePath,
    targetPath,
    status: "copied",
    overwritten: targetExists,
  };
}

export function createSettingsSyncService(
  dependencies: SettingsSyncServiceDependencies,
): ISettingsSyncService {
  function buildEmptyDiscoveryResult(): SettingsSyncDiscoveryResult {
    return {
      agents: [],
    };
  }

  return {
    async getClaudeAgentsFileMigrationStatus(
      request,
    ): Promise<SettingsSyncClaudeAgentsFileMigrationStatus> {
      void request.workspaceIdentity;
      void request.workspacePath;
      return getClaudeAgentsFileMigrationStatus();
    },

    async copyClaudeAgentsFileToZcodeAgentsFile(
      request = {},
    ): Promise<SettingsSyncClaudeAgentsFileCopyResult> {
      const result = await copyClaudeAgentsFileToZcodeAgentsFile({
        overwrite: request.overwrite,
      });
      log.info("[settings-sync] Claude AGENTS.md migration completed", {
        workspacePath: request.workspacePath,
        workspaceIdentity: request.workspaceIdentity,
        sourcePath: result.sourcePath,
        targetPath: result.targetPath,
        status: result.status,
        overwritten: result.overwritten,
        skippedReason: result.skippedReason,
      });
      return result;
    },

    async detect(request): Promise<SettingsSyncDiscoveryResult> {
      if (shouldScanSkills(request)) {
        return buildSkillsDiscovery(request.workspacePath);
      }
      if (shouldScanCommands(request)) {
        return buildCommandsDiscovery(request.workspacePath);
      }
      if (shouldScanPlugins(request)) {
        return buildPluginsDiscovery(request.workspacePath);
      }
      if (shouldScanMcpServers(request)) {
        return buildMcpDiscovery(request.workspacePath);
      }
      return buildEmptyDiscoveryResult();
    },

    async importSelected(request: {
      workspacePath?: string;
      workspaceIdentity?: string;
      selections: SettingsSyncSelection[];
    }): Promise<SettingsSyncImportResult> {
      const taskResults: SettingsSyncTaskImportResult[] = [];
      for (const selection of request.selections) {
        if (selection.category === "skills") {
          taskResults.push(
            await importSkillsForAgent(
              request.workspacePath,
              selection.agent,
              selection.sourceScope,
              selection.targetScope,
              selection.importMode,
              selection.skillPaths,
            ),
          );
          continue;
        }
        if (selection.category === "commands") {
          taskResults.push(
            await importCommandsForAgent(
              request.workspacePath,
              selection.agent,
              selection.sourceScope,
              selection.targetScope,
              selection.importMode,
              selection.commandPaths,
            ),
          );
          continue;
        }
        if (selection.category === "plugins") {
          taskResults.push(
            await importPluginsForAgent(
              request.workspacePath,
              selection.agent,
              selection.sourceScope,
              selection.targetScope,
              selection.importMode,
              selection.pluginPaths,
            ),
          );
          continue;
        }
        if (selection.category === "mcpServers") {
          taskResults.push(
            await importMcpServersForAgent(
              request.workspacePath,
              selection.agent,
              selection.sourceScope,
              selection.targetScope,
              selection.mcpServerPaths,
            ),
          );
          continue;
        }
        taskResults.push({
          agent: selection.agent,
          category: selection.category,
          status: "skipped",
          importedCount: 0,
          skippedCount: 1,
          failedCount: 0,
        });
      }
      return {
        successCount: taskResults.reduce((sum, result) => sum + result.importedCount, 0),
        skippedCount: taskResults.reduce((sum, result) => sum + result.skippedCount, 0),
        failedCount: taskResults.reduce((sum, result) => sum + result.failedCount, 0),
        taskResults,
      };
    },

    async getFirstRunPromptState() {
      const settings = await dependencies.settingService.get();
      return {
        handled: settings.settingsSyncFirstRunPromptHandled === true,
      };
    },

    async markFirstRunPromptHandled(): Promise<void> {
      await dependencies.settingService.update({
        // 这里记录的是“首启导入提示是否已经被消费”，不是“导入是否成功”。
        // 如果把“用户点击跳过”遗漏掉，下次启动还会重复弹窗，造成首启流程打扰感。
        settingsSyncFirstRunPromptHandled: true,
      });
    },
  };
}
