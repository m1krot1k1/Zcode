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

// Часть 1/5 модуля settings-sync-service: вынесено по лимиту строк.

export const log = createServiceLogger("settings-sync");

export interface SettingsSyncServiceDependencies {
  settingService: ISettingService;
}

export type SkillImportScope = "user" | "workspace";

export interface ExternalAgentPathSource {
  agent: SettingsSyncAgent;
  projectPath: string[];
  globalPath: string[];
}

export type CommandImportScope = "user" | "workspace";

export type PluginImportScope = "user" | "workspace";

export interface PluginImportCandidate {
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

export type McpImportScope = "user" | "workspace";

export type McpConfigFormat = "mcpServersJson" | "mcpJson" | "codexToml" | "clineMcpJson";

export interface McpImportCandidate {
  agent: SettingsSyncAgent;
  name: string;
  nameKey: string;
  config: McpServerConfig;
  sourceRootScope: SettingsSyncSourceScope;
  sourceRootPath: string;
  sourcePath: string;
  requiresOAuthReauthentication?: boolean;
}

export interface McpSourceFileReadResult {
  servers: Record<string, McpServerConfig>;
  diagnostics: SettingsSyncSourceDiagnostic[];
  oauthReauthenticationRequiredNames?: string[];
}

export const ZCODE_PLUGIN_MANIFEST_PATH = [".zcode-plugin", "plugin.json"] as const;

export const CLAUDE_PLUGIN_MANIFEST_PATH = [".claude-plugin", "plugin.json"] as const;

export const CODEX_PLUGIN_MANIFEST_PATH = [".codex-plugin", "plugin.json"] as const;

export const INLINE_PLUGIN_MARKETPLACE = "inline";

export const PRIVATE_MCP_CONFIG_FILE_MODE = 0o600;

export function resolveUserHomeDir(): string {
  const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

export const CLINE_SETTINGS_RELATIVE_PATH = ["settings", "cline_mcp_settings.json"] as const;

export const CLINE_EXTENSION_ID = "saoudrizwan.claude-dev";

export const CLINE_EDITOR_PROFILE_DIRS = ["Code", "Code - Insiders", "Cursor", "VSCodium"] as const;

export function getWorkspaceZcodeSkillRoot(workspacePath: string): string {
  return join(workspacePath, ".zcode", "skills");
}

export function getWorkspaceZcodeCommandRoot(workspacePath: string): string {
  return join(workspacePath, ".zcode", "commands");
}

export function getWorkspaceZcodePluginRoot(workspacePath: string): string {
  return join(workspacePath, ".zcode", "plugins");
}

export function getWorkspaceZcodeConfigPath(workspacePath: string): string {
  return join(workspacePath, ".zcode", "config.json");
}

export function getSkillDirectorySymlinkType(
  platform: NodeJS.Platform | string = process.platform,
): "dir" | "junction" {
  return platform === "win32" ? "junction" : "dir";
}

export function getCommandFileSymlinkType(): "file" {
  return "file";
}

export async function exists(path: string): Promise<boolean> {
  try {
    await readdir(path);
    return true;
  } catch {
    return false;
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

export async function collectSkillMarkdownPaths(rootPath: string): Promise<string[]> {
  // 复用共享的有界遍历（排除 node_modules 等内容目录、限制深度、软链去重），
  // 与桌面端技能扫描保持一致，避免设置同步在巨型目录上卡死。
  const discovered = new Set<string>();
  for await (const skillPath of walkSkillMarkdownPaths(rootPath)) {
    discovered.add(skillPath);
  }
  return [...discovered].sort((left, right) => left.localeCompare(right));
}

export async function collectCommandMarkdownPaths(rootPath: string): Promise<string[]> {
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeSkillNameKey(name: string): string {
  return name.trim().toLowerCase();
}

export function stripYamlScalarQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function normalizeCommandNameKey(name: string): string {
  return name.trim().toLowerCase();
}

export function getCommandNameFromPath(rootPath: string, filePath: string): string {
  const relativePath = relative(rootPath, filePath).replace(/\.md$/i, "");
  return `/${relativePath
    .split(/[\\/]+/)
    .filter(Boolean)
    .join("/")}`;
}

export function normalizeMcpServerNameKey(name: string): string {
  return name.trim().toLowerCase();
}

export function stripExternalMcpTimeoutFields(config: McpServerConfig): McpServerConfig {
  const {
    timeout: _timeout,
    startup_timeout_sec: _startupTimeoutSec,
    ...rest
  } = config as Record<string, unknown>;
  return rest as McpServerConfig;
}

export function isValidUrl(value: unknown): value is string {
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

export interface ClineNpmBinCommand {
  commandPath: string;
  commandName: string;
  installRoot: string;
}

export function isPathWithin(parentPath: string, childPath: string): boolean {
  const pathFromParent = relative(parentPath, childPath);
  return (
    pathFromParent === "" ||
    (!isAbsolute(pathFromParent) &&
      pathFromParent !== ".." &&
      !pathFromParent.startsWith(`..${sep}`))
  );
}

export function normalizeOpenCodeMcpConfig(config: McpServerConfig): McpServerConfig {
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

export function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function shouldScanSkills(request: {
  categories?: SettingsSyncCategory[];
  intent?: "firstRun" | "manualImport";
}): boolean {
  return request.intent === "manualImport" && request.categories?.includes("skills") === true;
}

export function shouldScanCommands(request: {
  categories?: SettingsSyncCategory[];
  intent?: "firstRun" | "manualImport";
}): boolean {
  return request.intent === "manualImport" && request.categories?.includes("commands") === true;
}

export function shouldScanPlugins(request: {
  categories?: SettingsSyncCategory[];
  intent?: "firstRun" | "manualImport";
}): boolean {
  return request.intent === "manualImport" && request.categories?.includes("plugins") === true;
}

export function shouldScanMcpServers(request: {
  categories?: SettingsSyncCategory[];
  intent?: "firstRun" | "manualImport";
}): boolean {
  return request.intent === "manualImport" && request.categories?.includes("mcpServers") === true;
}

export interface SkillImportCandidate {
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

export interface SkillSourceRoot {
  agent: SettingsSyncAgent;
  rootPath: string;
  scope: SkillImportScope;
}

export interface CommandImportCandidate {
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

export interface CommandSourceRoot {
  agent: SettingsSyncAgent;
  rootPath: string;
  scope: CommandImportScope;
}

export interface PluginSourceRoot {
  agent: SettingsSyncAgent;
  rootPath: string;
  scope: PluginImportScope;
}

export interface McpSourceRoot {
  agent: SettingsSyncAgent;
  rootPath: string;
  scope: McpImportScope;
  format: McpConfigFormat;
}

export interface ExternalAgentMcpPathSource {
  agent: SettingsSyncAgent;
  projectFiles: string[][];
  globalFiles: string[][];
  resolveGlobalFile?: () => Promise<string>;
  format: McpConfigFormat;
}

export const SUPPORTED_SKILL_AGENT_SOURCES: ExternalAgentPathSource[] = [
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

export const SUPPORTED_COMMAND_AGENT_SOURCES: ExternalAgentPathSource[] = [
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

export const SUPPORTED_PLUGIN_AGENT_SOURCES: ExternalAgentPathSource[] = [
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

export interface ClineMcpConfigPathOptions {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  platform: NodeJS.Platform;
  exists: (path: string) => boolean;
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

export function getClineMcpServersRoot(): string {
  const dataDir = process.env.CLINE_DATA_DIR?.trim();
  if (dataDir) return join(resolve(dataDir), "mcp-servers");
  const clineDir = process.env.CLINE_DIR?.trim();
  if (clineDir) return join(resolve(clineDir), "data", "mcp-servers");
  return join(resolveUserHomeDir(), ".cline", "data", "mcp-servers");
}

export function getUserZcodeSkillRoot(): string {
  return join(resolveUserHomeDir(), ".zcode", "skills");
}

export function getUserZcodeCommandRoot(): string {
  return join(resolveUserHomeDir(), ".zcode", "commands");
}

export function getUserZcodePluginRoot(): string {
  return join(resolveUserHomeDir(), ".zcode", "plugins");
}

export function getUserZcodeCliConfigPath(): string {
  return join(resolveUserHomeDir(), ".zcode", "cli", "config.json");
}

export function getClaudeUserAgentsFileSourcePath(): string {
  return join(resolveUserHomeDir(), ".claude", "CLAUDE.md");
}

export function getUserZcodeAgentsFilePath(): string {
  return join(resolveUserHomeDir(), ".zcode", "AGENTS.md");
}

export async function createDirectorySymlink(sourcePath: string, targetPath: string): Promise<void> {
  // Windows 创建目录软链需要 junction；其它平台使用 dir。source 使用绝对路径，避免 junction
  // 在不同 cwd 下解析目标不一致。
  await symlink(resolve(sourcePath), targetPath, getSkillDirectorySymlinkType());
}

export async function importCommandFile(
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

export async function findPluginManifestPath(pluginPath: string): Promise<string | null> {
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

export function readLooseSkillName(frontmatterText: string, fallbackName: string): string {
  const match = /^name\s*:\s*(.+)$/m.exec(frontmatterText);
  return stripYamlScalarQuotes(match?.[1] ?? fallbackName) || fallbackName;
}

export function readLooseSkillVersion(frontmatterText: string): string | undefined {
  const match = /^version\s*:\s*(.+)$/m.exec(frontmatterText);
  const version = stripYamlScalarQuotes(match?.[1] ?? "");
  return version.length > 0 ? version : undefined;
}

export async function readCommandMetadata(params: { filePath: string; rootPath: string }): Promise<{
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

export async function collectExistingCommandNameKeys(rootPath: string): Promise<Set<string>> {
  const nameKeys = new Set<string>();
  if (!(await exists(rootPath))) {
    return nameKeys;
  }
  for (const commandPath of await collectCommandMarkdownPaths(rootPath)) {
    nameKeys.add(normalizeCommandNameKey(getCommandNameFromPath(rootPath, commandPath)));
  }
  return nameKeys;
}
