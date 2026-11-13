import type {
  McpServerConfig,
  SettingsSyncAgent,
  SettingsSyncClaudeAgentsFileCopyResult,
  SettingsSyncCommandImportResult,
  SettingsSyncDiscoveryResult,
  SettingsSyncPluginSkipReason,
  SettingsSyncMcpServerImportWarning,
  SettingsSyncMcpServerSkipReason,
  SettingsSyncImportMode,
  SettingsSyncSourceScope,
  SettingsSyncSourceRootSummary,
  SettingsSyncTaskImportResult,
} from "@zcode/shared";
import {
  copyFile,
  mkdir,
  readFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { CLINE_EDITOR_PROFILE_DIRS, CLINE_EXTENSION_ID, CLINE_SETTINGS_RELATIVE_PATH, SUPPORTED_COMMAND_AGENT_SOURCES, collectCommandMarkdownPaths, collectSkillMarkdownPaths, exists, getClaudeUserAgentsFileSourcePath, getUserZcodeAgentsFilePath, importCommandFile, isRecord, normalizeCommandNameKey, normalizeMcpServerNameKey, normalizeSkillNameKey, pathExists, readCommandMetadata, readStringArray, resolveUserHomeDir, selectClineMcpConfigPath } from "./settings-sync-service-part1.js";
import type { ClineMcpConfigPathOptions, CommandImportCandidate, McpConfigFormat, McpImportCandidate, McpSourceFileReadResult, PluginImportCandidate, SkillImportCandidate } from "./settings-sync-service-part1.js";
import { collectPluginPaths, findPortableClinePreset, getClineEditorUserDataRoot, getCommandImportCandidateSkipReason, getExternalCommandRoots, getExternalPluginRoots, getExternalSkillRoots, normalizeClineMcpConfig, parseClineNpmBinCommand, prepareMcpConfigForTargetScope, readJsonFileOrEmpty, readOpenCodeMcpServers, readPluginMetadata, readSkillMetadataFromMarkdown, readTomlMcpServers, readWrappedMcpServers, readZcodeMcpServers, resolveCandidateTargetRoot, resolveCommandCandidateTargetRoot, resolveCommandTargetRootForScope, resolveMcpConfigPathForScope, resolvePluginCandidateTargetRoot, resolvePluginConfigPathForScope, writeJsonFile } from "./settings-sync-service-part2.js";

// Часть 3/5 модуля settings-sync-service: вынесено по лимиту строк.

export async function copyClaudeAgentsFileToZcodeAgentsFile(params: {
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

export function getClineMcpConfigCandidates({
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

export async function readSkillMetadata(skillPath: string): Promise<{ name: string; version?: string }> {
  const fallbackName = basename(dirname(skillPath));
  try {
    return readSkillMetadataFromMarkdown(await readFile(skillPath, "utf-8"), fallbackName);
  } catch {
    return { name: fallbackName };
  }
}

export function readClineMcpServers(
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

export async function prepareClineMcpConfigForTargetScope(
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

export async function collectExistingMcpServerNameKeys(
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

export async function addMcpServerToZcodeConfig(
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

export async function collectConfiguredPluginIds(configPath: string): Promise<Set<string>> {
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

export async function isCommandImportCandidateImportable(
  candidate: CommandImportCandidate,
  existingNameKeysByTargetRoot: Map<string, Set<string>>,
): Promise<boolean> {
  return (
    (await getCommandImportCandidateSkipReason(candidate, existingNameKeysByTargetRoot)) ===
    undefined
  );
}

export async function buildCommandSourceRootSummaries(
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

export async function collectCommandImportCandidates(
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

export async function collectPluginImportCandidates(
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

export async function readSkillNameKey(skillPath: string): Promise<string> {
  return normalizeSkillNameKey((await readSkillMetadata(skillPath)).name);
}

export async function readMcpServersFromSourceFile(
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

export async function getPluginImportCandidateSkipReason(
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

export async function getMcpImportCandidateSkipReason(
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

export async function collectSkillImportCandidates(
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

export async function buildCommandsDiscovery(
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

export async function importCommandsForAgent(
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

export async function getClineMcpSettingsPath(): Promise<string> {
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

export async function collectExistingSkillNameKeys(rootPath: string): Promise<Set<string>> {
  const nameKeys = new Set<string>();
  if (!(await exists(rootPath))) {
    return nameKeys;
  }
  for (const skillPath of await collectSkillMarkdownPaths(rootPath)) {
    nameKeys.add(await readSkillNameKey(skillPath));
  }
  return nameKeys;
}
