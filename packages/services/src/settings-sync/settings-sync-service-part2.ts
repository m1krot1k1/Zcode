import type {
  McpServerConfig,
  SettingsSyncClaudeAgentsFileMigrationStatus,
  SettingsSyncCommandSkipReason,
  SettingsSyncMcpServerImportWarning,
  SettingsSyncImportMode,
  SettingsSyncSourceScope,
  } from "@zcode/shared";
import { COMMUNITY_MCP_PRESETS, communityMcpPresetConfig } from "@zcode/shared";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {parse as parseYaml} from "yaml";
import { INLINE_PLUGIN_MARKETPLACE, PRIVATE_MCP_CONFIG_FILE_MODE, SUPPORTED_COMMAND_AGENT_SOURCES, SUPPORTED_PLUGIN_AGENT_SOURCES, SUPPORTED_SKILL_AGENT_SOURCES, collectExistingCommandNameKeys, createDirectorySymlink, findPluginManifestPath, getClaudeUserAgentsFileSourcePath, getClineMcpServersRoot, getUserZcodeAgentsFilePath, getUserZcodeCliConfigPath, getUserZcodeCommandRoot, getUserZcodePluginRoot, getUserZcodeSkillRoot, getWorkspaceZcodeCommandRoot, getWorkspaceZcodeConfigPath, getWorkspaceZcodePluginRoot, getWorkspaceZcodeSkillRoot, isPathWithin, isRecord, isValidUrl, normalizeOpenCodeMcpConfig, pathExists, readLooseSkillName, readLooseSkillVersion, readStringArray, resolveUserHomeDir } from "./settings-sync-service-part1.js";
import type { ClineMcpConfigPathOptions, ClineNpmBinCommand, CommandImportCandidate, CommandImportScope, CommandSourceRoot, McpImportCandidate, PluginImportScope, PluginSourceRoot, SkillImportScope, SkillSourceRoot } from "./settings-sync-service-part1.js";

// Часть 2/5 модуля settings-sync-service: вынесено по лимиту строк.

export async function readJsonFileOrEmpty(filePath: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf-8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function normalizeMcpServerMap(value: unknown): Record<string, McpServerConfig> {
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

export function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

export function normalizeClineMcpOAuthClient(
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

export function prepareMcpConfigForTargetScope(
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

export function parseClineNpmBinCommand(command: string): ClineNpmBinCommand | undefined {
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

export async function findClinePackageForBin(
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

export async function writeJsonFile(
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

export function getClineEditorUserDataRoot({
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

export function resolveTargetRootForScope(
  targetScope: SettingsSyncSourceScope,
  workspacePath: string | undefined,
): string | null {
  if (targetScope === "global") {
    return getUserZcodeSkillRoot();
  }
  return workspacePath ? getWorkspaceZcodeSkillRoot(workspacePath) : null;
}

export function resolveCandidateTargetRoot(
  sourceScope: SkillImportScope,
  workspacePath: string | undefined,
): string | null {
  return sourceScope === "workspace"
    ? workspacePath
      ? getWorkspaceZcodeSkillRoot(workspacePath)
      : null
    : getUserZcodeSkillRoot();
}

export function resolveCommandTargetRootForScope(
  targetScope: SettingsSyncSourceScope,
  workspacePath: string | undefined,
): string | null {
  if (targetScope === "global") {
    return getUserZcodeCommandRoot();
  }
  return workspacePath ? getWorkspaceZcodeCommandRoot(workspacePath) : null;
}

export function resolveCommandCandidateTargetRoot(
  sourceScope: CommandImportScope,
  workspacePath: string | undefined,
): string | null {
  return sourceScope === "workspace"
    ? workspacePath
      ? getWorkspaceZcodeCommandRoot(workspacePath)
      : null
    : getUserZcodeCommandRoot();
}

export function resolvePluginTargetRootForScope(
  targetScope: SettingsSyncSourceScope,
  workspacePath: string | undefined,
): string | null {
  if (targetScope === "global") {
    return getUserZcodePluginRoot();
  }
  return workspacePath ? getWorkspaceZcodePluginRoot(workspacePath) : null;
}

export function resolvePluginCandidateTargetRoot(
  sourceScope: PluginImportScope,
  workspacePath: string | undefined,
): string | null {
  return sourceScope === "workspace"
    ? workspacePath
      ? getWorkspaceZcodePluginRoot(workspacePath)
      : null
    : getUserZcodePluginRoot();
}

export function resolvePluginConfigPathForScope(
  targetScope: SettingsSyncSourceScope,
  workspacePath: string | undefined,
): string | null {
  if (targetScope === "global") {
    return getUserZcodeCliConfigPath();
  }
  return workspacePath ? getWorkspaceZcodeConfigPath(workspacePath) : null;
}

export function resolveMcpConfigPathForScope(
  targetScope: SettingsSyncSourceScope,
  workspacePath: string | undefined,
): string | null {
  if (targetScope === "global") {
    return getUserZcodeCliConfigPath();
  }
  return workspacePath ? getWorkspaceZcodeConfigPath(workspacePath) : null;
}

export async function importSkillDirectory(
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

export async function importPluginDirectory(
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

export function getExternalSkillRoots(workspacePath?: string): SkillSourceRoot[] {
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

export function getExternalCommandRoots(workspacePath?: string): CommandSourceRoot[] {
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

export function getExternalPluginRoots(workspacePath?: string): PluginSourceRoot[] {
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

export async function collectPluginPaths(rootPath: string): Promise<string[]> {
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

export function readSkillMetadataFromMarkdown(
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

export async function readPluginMetadata(pluginPath: string): Promise<{
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

export function readZcodeMcpServers(parsed: Record<string, unknown>): Record<string, McpServerConfig> {
  if (!isRecord(parsed.mcp)) {
    return {};
  }
  return normalizeMcpServerMap(parsed.mcp.servers);
}

export function readWrappedMcpServers(parsed: Record<string, unknown>): Record<string, McpServerConfig> {
  return normalizeMcpServerMap(parsed.mcpServers);
}

export function normalizeClineMcpConfig(config: McpServerConfig): McpServerConfig | null {
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

export async function findPortableClinePreset(
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

export function readOpenCodeMcpServers(parsed: Record<string, unknown>): Record<string, McpServerConfig> {
  const servers = normalizeMcpServerMap(parsed.mcp);
  return Object.fromEntries(
    Object.entries(servers).map(([name, config]) => [name, normalizeOpenCodeMcpConfig(config)]),
  );
}

export function readTomlMcpServers(parsed: Record<string, unknown>): Record<string, McpServerConfig> {
  return normalizeMcpServerMap(parsed.mcp_servers ?? parsed.mcpServers);
}

export async function addPluginDirToConfig(filePath: string, pluginPath: string): Promise<void> {
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

export async function getCommandImportCandidateSkipReason(
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

export async function getClaudeAgentsFileMigrationStatus(): Promise<SettingsSyncClaudeAgentsFileMigrationStatus> {
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
