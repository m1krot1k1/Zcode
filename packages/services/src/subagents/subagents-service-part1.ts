import { access, link, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  createAgentStateId,
  createPluginAgentStateId,
  parsePluginSubagentModelSelectionOverrides,
  DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS,
  ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
  modelSelectionSchema,
  type SubagentRuntimeConfig,
  type AgentCreateParams,
  type AgentDeleteParams,
  type AgentDiagnostic,
  type AgentScope,
  type AgentSummary,
  type AgentUpdateParams,
  type AgentsCapability,
  type AgentsListResult,
  type BuiltInSubagentModelOverrideParams,
  type BuiltInSubagentModelSelectionOverrides,
  type PluginSubagentModelOverrideParams,
  type PluginSubagentModelSelectionOverrides,
  type SubAgentConfig,
  type SubagentsListMode,
  type ZCodeProvider,
} from "@zcode/shared";
import { normalizeSubagentModelSelection } from "./subagentModelSelection.js";
import { serializeSubagentMarkdown, parseSubagentMarkdown } from "./subagentMarkdown.js";
import {
  resolveSubagentStateFile,
  resolveUserHomeDir,
  resolveUserSubagentRoot,
  resolveWorkspaceSubagentRoot,
  resolveZCodeStorageRoot,
  type SubagentStorageOptions,
} from "./subagentStorage.js";
import type { ISubagentsService } from "./subagents.js";
import { atomicWriteText } from "#src/fs/atomicFileUtils.js";
import { maybeThrowInjectedFsFault } from "#src/fs/fsFaultInjection.js";
import {
  migrateUserSubagentMarkdown,
  migrateSubagentStateFile,
  scanOfficialPluginCacheRoots,
} from "@zcode/shared/node";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { createSubagentRuntimeConfigCache } from "./subagentRuntimeConfig.js";

// Часть 1/2 модуля subagents-service: вынесено по лимиту строк.

export const subagentLogger = createServiceLogger("subagents");

export interface AgentsStateFile {
  builtInModelSelectionOverrides: BuiltInSubagentModelSelectionOverrides;
  pluginAgentModelSelectionOverrides: PluginSubagentModelSelectionOverrides;
  disabledAgentIds: string[];
  // 仅供旧版本回滚保留；新版存在选择字段后，禁止再从这两个字段恢复覆盖。
  builtInModelOverrides?: unknown;
  builtInThoughtLevelOverrides?: unknown;
}

export interface InstalledPluginsStateFile {
  plugins?: unknown;
}

export interface PluginConfigSummary {
  enabledPlugins: Record<string, boolean>;
  suppressedBuiltins: string[];
}

export interface InstalledPluginRecord {
  id: string;
  installPath: string;
  name: string;
  scope?: "user" | "workspace";
  projectPath?: string;
}

export interface SubagentsServiceOptions extends SubagentStorageOptions {
  isDesktopRuntime?: boolean;
}

export interface PluginAgentDiscovery {
  profiles: AgentSummary[];
  runtimeAgents: AgentSummary[];
}

export interface AgentProfileRenameJournal {
  version: 1;
  transactionID: string;
  sourceFileName: string;
  targetFileName: string;
  stageFileName: string;
  previousAgentID: string;
  nextAgentID: string;
  sourceHash: string;
  contentHash: string;
  content: string;
  sourceWasDisabled: boolean;
  targetWasDisabled: boolean;
}

export const BUILT_IN_AGENT_NAMES = new Set(["Explore"]);

export const PROFILE_RENAME_JOURNAL_PREFIX = ".zcode-profile-rename-";

export const MAX_PROFILE_RENAME_CONTENT_BYTES = 1024 * 1024;

export const PLUGIN_MANIFEST_PATHS = [
  join(".zcode-plugin", "plugin.json"),
  join(".claude-plugin", "plugin.json"),
  join(".codex-plugin", "plugin.json"),
] as const;

export function createBuiltInAgents(
  modelSelectionOverrides: BuiltInSubagentModelSelectionOverrides = {},
): AgentSummary[] {
  const exploreOverride = modelSelectionOverrides.Explore;
  return [
    {
      id: createAgentStateId({
        name: "Explore",
        scope: "built-in",
        source: "built-in",
      }),
      name: "Explore",
      description: "Read-only search agent for broad fan-out searches.",
      color: "cyan",
      injectAgentsMd: false,
      modelSelection: exploreOverride,
      modelSelectionOverride: exploreOverride,
      systemPrompt: "",
      tools: ["Bash", "Glob", "Grep", "Read", "WebFetch", "WebSearch", "TodoWrite"],
      path: "built-in:Explore",
      scope: "built-in",
      source: "built-in",
      enabled: true,
      readOnly: true,
    },
  ];
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function applyRuntimePrecedence(agents: AgentSummary[]): AgentSummary[] {
  const byName = new Map<string, AgentSummary>();
  for (const agent of agents) {
    byName.set(agent.name, agent);
  }
  return [...byName.values()];
}

export function collectPluginAgentRoots(rootPath: string, manifestAgents: unknown): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  const root = resolve(rootPath);
  const add = (relativePath: string) => {
    const resolved = resolve(root, relativePath.replace(/^\.\//u, ""));
    const relativeToRoot = relative(root, resolved);
    if (relativeToRoot.startsWith("..") || isAbsolute(relativeToRoot)) return;
    if (!seen.has(resolved)) {
      seen.add(resolved);
      roots.push(resolved);
    }
  };
  add("agents");
  if (typeof manifestAgents === "string") add(manifestAgents);
  if (Array.isArray(manifestAgents)) {
    for (const value of manifestAgents) {
      if (typeof value === "string") add(value);
    }
  }
  return roots;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateUserAgentConfig(config: SubAgentConfig): void {
  const trimmedName = config.name.trim();
  const nameRegex = /^[a-zA-Z0-9-]+$/;
  const minNameLength = 3;
  const maxNameLength = 50;
  if (trimmedName.length < minNameLength || trimmedName.length > maxNameLength) {
    throw new Error(`Name must be between ${minNameLength} and ${maxNameLength} characters`);
  }
  if (!nameRegex.test(trimmedName)) {
    throw new Error("Name can only contain letters, numbers, and hyphens");
  }
  if (config.description.trim().length === 0) {
    throw new Error("Description is required");
  }
  if (config.systemPrompt.trim().length === 0) {
    throw new Error("System prompt is required");
  }
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function isProfileLeafName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9-]+\.(?:md|markdown)$/iu.test(value);
}

export async function removeProfileRenameFile(path: string): Promise<void> {
  maybeThrowInjectedFsFault({ operation: "rm", path });
  await rm(path, { force: true });
}

export async function readOptionalText(path: string): Promise<string | undefined> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(`Expected a regular profile file at ${path}`);
  return readFile(path, "utf8");
}

export function isHardLinkUnavailable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EOPNOTSUPP" || code === "ENOTSUP" || code === "ENOSYS";
}

export function normalizeConfig(config: SubAgentConfig): SubAgentConfig {
  return {
    ...config,
    name: config.name.trim(),
    description: config.description.trim(),
    systemPrompt: config.systemPrompt.trim(),
    modelSelection: normalizeSubagentModelSelection(config.modelSelection),
  };
}

export function requireWorkspacePath(workspacePath: string | undefined): string {
  const value = workspacePath?.trim();
  if (!value) throw new Error("Workspace path is required for workspace subagents");
  return value;
}

export function parseSavedAgent(
  content: string,
  path: string,
  scope: "user" | "workspace",
  workspacePath?: string,
): AgentSummary {
  const parsed = parseSubagentMarkdown({
    content,
    path,
    scope,
  });
  if (parsed.diagnostic || !parsed.agent) {
    throw new Error(parsed.diagnostic?.message ?? `Failed to parse saved agent: ${path}`);
  }
  return {
    ...parsed.agent,
    projectPath: scope === "workspace" ? workspacePath : undefined,
  };
}

export function emptyAgentsState(): AgentsStateFile {
  return {
    builtInModelSelectionOverrides: {},
    pluginAgentModelSelectionOverrides: {},
    disabledAgentIds: [],
  };
}

export async function writeAgentStateFile(
  next: AgentsStateFile,
  options?: SubagentStorageOptions,
): Promise<void> {
  const stateFile = await resolveSubagentStateFile(options);
  await mkdir(dirname(stateFile), { recursive: true });
  await atomicWriteText(stateFile, JSON.stringify(next, null, 2));
}

export async function collectAgentMarkdownPaths(rootPath: string, recursive = false): Promise<string[]> {
  if (!(await exists(rootPath))) {
    return [];
  }

  const rootStat = await lstat(rootPath).catch(() => undefined);
  if (!rootStat?.isDirectory()) {
    return [];
  }

  const result: string[] = [];
  const entries = await readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(rootPath, entry.name);
    if (entry.isDirectory()) {
      // 自定义 profile 只支持第一层；插件保留已有递归发现规则。
      if (recursive) result.push(...(await collectAgentMarkdownPaths(entryPath, true)));
      continue;
    }
    if (entry.isFile() && /\.(md|markdown)$/iu.test(entry.name)) {
      result.push(entryPath);
    }
  }
  return result.sort((left, right) => left.localeCompare(right));
}

export function resolveCapabilities(options?: SubagentsServiceOptions): AgentsCapability {
  const isDesktopRuntime = options?.isDesktopRuntime ?? Boolean(process.env.ZCODE_PROCESS_LABEL);
  if (isDesktopRuntime) {
    return { userScopeAvailable: true };
  }
  return { userScopeAvailable: false, userScopeReason: "desktop_only" };
}

export function attachEnabledState(agents: AgentSummary[], state: AgentsStateFile): AgentSummary[] {
  const disabledSet = new Set(state.disabledAgentIds);
  return agents.map((agent) => ({
    ...agent,
    enabled: agent.scope === "user" ? !disabledSet.has(agent.id) : true,
  }));
}

export async function readPluginConfig(options?: SubagentStorageOptions): Promise<PluginConfigSummary> {
  try {
    const configPath = join(resolveUserHomeDir(options), ".zcode", "cli", "config.json");
    const raw = await readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return { enabledPlugins: {}, suppressedBuiltins: [] };
    const plugins = isRecord(parsed.plugins) ? parsed.plugins : {};
    const enabledPlugins = isRecord(plugins.enabledPlugins) ? plugins.enabledPlugins : {};
    return {
      enabledPlugins: Object.fromEntries(
        Object.entries(enabledPlugins).filter(
          (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
        ),
      ),
      suppressedBuiltins: Array.isArray(plugins.suppressedBuiltins)
        ? plugins.suppressedBuiltins.filter((id): id is string => typeof id === "string")
        : [],
    };
  } catch {
    return { enabledPlugins: {}, suppressedBuiltins: [] };
  }
}

export function isInstalledPluginRecord(value: unknown): value is InstalledPluginRecord {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.installPath === "string" &&
    typeof value.name === "string"
  );
}

export async function readPluginManifest(rootPath: string): Promise<Record<string, unknown> | null> {
  for (const relativePath of PLUGIN_MANIFEST_PATHS) {
    try {
      const raw = await readFile(join(rootPath, relativePath), "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (isRecord(parsed)) return parsed;
    } catch {
      // Try the next supported manifest path.
    }
  }
  return null;
}

export function applyPluginAgentOverrides(agent: AgentSummary, state: AgentsStateFile): AgentSummary {
  const override = state.pluginAgentModelSelectionOverrides[agent.id];
  // 插件文件只提供默认值；覆盖替换整份选择，不能混入原模型的档位。
  return {
    ...agent,
    defaultModelSelection: agent.modelSelection,
    ...(override ? { modelSelection: override, modelSelectionOverride: override } : {}),
  };
}

export function normalizeBuiltInSelectionOverrides(
  structured: unknown,
): BuiltInSubagentModelSelectionOverrides {
  const result: BuiltInSubagentModelSelectionOverrides = {};
  const structuredRecord = isRecord(structured) ? structured : {};
  const generalPurpose = modelSelectionSchema.safeParse(structuredRecord["general-purpose"]).data;
  const explore = modelSelectionSchema.safeParse(structuredRecord.Explore).data;
  if (generalPurpose) result["general-purpose"] = generalPurpose;
  if (explore) result.Explore = explore;
  return result;
}

export function assertNotBuiltInName(name: string): void {
  if (BUILT_IN_AGENT_NAMES.has(name.trim())) {
    throw new Error(`Agent name "${name.trim()}" is reserved by a built-in agent`);
  }
}

export function parseAgentProfileRenameJournal(
  value: unknown,
  expectedTransactionID: string,
): AgentProfileRenameJournal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Agent profile rename journal is not an object");
  }
  const record = value as Partial<AgentProfileRenameJournal>;
  if (
    record.version !== 1 ||
    record.transactionID !== expectedTransactionID ||
    !isProfileLeafName(record.sourceFileName) ||
    !isProfileLeafName(record.targetFileName) ||
    record.sourceFileName === record.targetFileName ||
    typeof record.stageFileName !== "string" ||
    record.stageFileName !== `${record.targetFileName}.${expectedTransactionID}.pending` ||
    typeof record.previousAgentID !== "string" ||
    !record.previousAgentID ||
    typeof record.nextAgentID !== "string" ||
    !record.nextAgentID ||
    typeof record.content !== "string" ||
    Buffer.byteLength(record.content, "utf8") > MAX_PROFILE_RENAME_CONTENT_BYTES ||
    typeof record.sourceHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.sourceHash) ||
    typeof record.contentHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.contentHash) ||
    sha256(record.content) !== record.contentHash ||
    typeof record.sourceWasDisabled !== "boolean" ||
    typeof record.targetWasDisabled !== "boolean"
  ) {
    throw new Error("Agent profile rename journal failed validation");
  }
  return record as AgentProfileRenameJournal;
}

export async function readAgentStateAtPath(stateFile: string): Promise<AgentsStateFile> {
  await migrateSubagentStateFile(stateFile);
  try {
    const raw = await readFile(stateFile, "utf-8");
    const parsed = JSON.parse(raw) as {
      builtInModelSelectionOverrides?: unknown;
      pluginAgentModelSelectionOverrides?: unknown;
      builtInModelOverrides?: unknown;
      builtInThoughtLevelOverrides?: unknown;
      disabledAgentIds?: unknown;
    };
    const selections = normalizeBuiltInSelectionOverrides(parsed.builtInModelSelectionOverrides);
    return {
      ...parsed,
      builtInModelSelectionOverrides: selections,
      pluginAgentModelSelectionOverrides: parsePluginSubagentModelSelectionOverrides(
        parsed.pluginAgentModelSelectionOverrides,
      ),
      disabledAgentIds: Array.isArray(parsed.disabledAgentIds)
        ? parsed.disabledAgentIds.filter(
            (id): id is string => typeof id === "string" && id.trim().length > 0,
          )
        : [],
    };
  } catch (error) {
    // 文件缺失/损坏沿用既有空覆盖语义；IO 失败不能伪装为空配置并重新启用已禁用 agent。
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT")
      return emptyAgentsState();
    throw error;
  }
}

export async function discoverFileAgents(params: {
  diagnostics: AgentDiagnostic[];
  includeUserAgents: boolean;
  includeWorkspaceAgents: boolean;
  storageOptions?: SubagentStorageOptions;
  workspacePath: string;
}): Promise<AgentSummary[]> {
  const roots: Array<{ scope: AgentScope; rootPath: string }> = [];
  if (params.includeUserAgents) {
    roots.push({
      scope: "user",
      rootPath: await resolveUserSubagentRoot(params.storageOptions),
    });
  }
  if (params.includeWorkspaceAgents) {
    roots.push({
      scope: "workspace",
      rootPath: resolveWorkspaceSubagentRoot(params.workspacePath),
    });
  }

  const agents: AgentSummary[] = [];
  for (const root of roots) {
    for (const agentPath of await collectAgentMarkdownPaths(root.rootPath)) {
      try {
        const markdown = await readFile(agentPath, "utf-8");
        const parsed = parseSubagentMarkdown({
          content: markdown,
          path: agentPath,
          scope: root.scope,
        });
        if (parsed.diagnostic) {
          params.diagnostics.push(parsed.diagnostic);
          continue;
        }
        if (parsed.agent) {
          agents.push({
            ...parsed.agent,
            projectPath: root.scope === "workspace" ? params.workspacePath : undefined,
          });
        }
      } catch {
        params.diagnostics.push({
          code: "agent_read_failed",
          message: `Failed to read agent Markdown: ${agentPath}`,
          path: agentPath,
        });
      }
    }
  }

  return agents;
}

export async function readInstalledPluginRecords(
  pluginStorageRoot: string,
): Promise<InstalledPluginRecord[]> {
  try {
    const raw = await readFile(join(pluginStorageRoot, "installed_plugins.json"), "utf-8");
    const parsed = JSON.parse(raw) as InstalledPluginsStateFile;
    if (!Array.isArray(parsed.plugins)) return [];
    return parsed.plugins.filter(isInstalledPluginRecord);
  } catch {
    return [];
  }
}

export async function collectPluginAgentMarkdownPaths(rootPath: string): Promise<string[]> {
  const manifest = await readPluginManifest(rootPath);
  const roots = collectPluginAgentRoots(rootPath, manifest?.agents);
  const paths = await Promise.all(roots.map((root) => collectAgentMarkdownPaths(root, true)));
  return paths.flat().sort((left, right) => left.localeCompare(right));
}

export async function readAgentStateFile(options?: SubagentsServiceOptions): Promise<AgentsStateFile> {
  return readAgentStateAtPath(await resolveSubagentStateFile(options));
}

/** 内置插件没有安装记录，只扫描 installed 文件会漏掉；缓存只补缺失身份，不能复活禁用/卸载插件。 */
export async function readEnabledPluginRecords(
  pluginStorageRoot: string,
  config: PluginConfigSummary,
): Promise<InstalledPluginRecord[]> {
  const installed = await readInstalledPluginRecords(pluginStorageRoot);
  const records = installed.filter(
    (record) =>
      config.enabledPlugins[record.id] === true &&
      // 卸载抑制优先于遗留的安装/启用记录，不能只在缓存兜底时检查而复活官方插件。
      !(
        record.id.endsWith(`@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID}`) &&
        config.suppressedBuiltins.includes(record.id)
      ),
  );
  const seenIds = new Set(installed.map((record) => record.id));
  for (const cacheRoot of await scanOfficialPluginCacheRoots(pluginStorageRoot)) {
    const id = `${cacheRoot.name}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID}`;
    if (seenIds.has(id) || config.suppressedBuiltins.includes(id)) continue;
    const enabled = config.enabledPlugins[id] ?? DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS.has(id);
    if (!enabled) continue;
    for (const versionRoot of cacheRoot.versionRoots) {
      const manifest = await readPluginManifest(versionRoot);
      if (manifest?.name !== cacheRoot.name) continue;
      records.push({ id, installPath: versionRoot, name: cacheRoot.name, scope: "user" });
      seenIds.add(id);
      break;
    }
  }
  return records;
}

export async function discoverPluginAgents(params: {
  diagnostics: AgentDiagnostic[];
  state: AgentsStateFile;
  reservedNames: Iterable<string>;
  storageOptions?: SubagentStorageOptions;
}): Promise<PluginAgentDiscovery> {
  const storageRoot = await resolveZCodeStorageRoot(params.storageOptions);
  const cliStorageRoot = basename(storageRoot) === "cli" ? storageRoot : join(storageRoot, "cli");
  const pluginConfig = await readPluginConfig(params.storageOptions);
  const records = await readEnabledPluginRecords(join(cliStorageRoot, "plugins"), pluginConfig);
  const parsedAgents: Array<{
    agent: AgentSummary;
    bareName: string;
    pluginName: string;
  }> = [];

  for (const record of records) {
    for (const agentPath of await collectPluginAgentMarkdownPaths(record.installPath)) {
      try {
        const markdown = await readFile(agentPath, "utf-8");
        const parsed = parseSubagentMarkdown({
          content: markdown,
          path: agentPath,
          scope: record.scope === "workspace" ? "workspace" : "user",
        });
        if (parsed.diagnostic) {
          params.diagnostics.push(parsed.diagnostic);
          continue;
        }
        if (parsed.agent) {
          const id = createPluginAgentStateId(record.id, parsed.agent.name);
          parsedAgents.push({
            agent: applyPluginAgentOverrides(
              {
                ...parsed.agent,
                id,
                name: `${record.name}:${parsed.agent.name}`,
                readOnly: true,
                source: "plugin",
                pluginId: record.id,
                pluginName: record.name,
                projectPath: record.scope === "workspace" ? record.projectPath : undefined,
              },
              params.state,
            ),
            bareName: parsed.agent.name,
            pluginName: record.name,
          });
        }
      } catch {
        params.diagnostics.push({
          code: "agent_read_failed",
          message: `Failed to read plugin agent Markdown: ${agentPath}`,
          path: agentPath,
        });
      }
    }
  }

  const reservedNames = new Set([...BUILT_IN_AGENT_NAMES, ...params.reservedNames]);
  const bareNameCounts = new Map<string, number>();
  for (const parsed of parsedAgents) {
    bareNameCounts.set(parsed.bareName, (bareNameCounts.get(parsed.bareName) ?? 0) + 1);
  }

  const profiles: AgentSummary[] = [];
  const runtimeAgents: AgentSummary[] = [];
  for (const parsed of parsedAgents) {
    profiles.push(parsed.agent);
    runtimeAgents.push(parsed.agent);
    if (bareNameCounts.get(parsed.bareName) === 1 && !reservedNames.has(parsed.bareName)) {
      runtimeAgents.push({
        ...parsed.agent,
        id: createPluginAgentStateId(`${parsed.agent.id}:alias`, parsed.bareName),
        name: parsed.bareName,
      });
    } else if (reservedNames.has(parsed.bareName)) {
      params.diagnostics.push({
        code: "agent_ambiguous_name",
        message: `Plugin agent bare name conflicts with an existing profile; use ${parsed.pluginName}:${parsed.bareName}`,
        path: parsed.agent.path,
      });
    } else if ((bareNameCounts.get(parsed.bareName) ?? 0) > 1) {
      params.diagnostics.push({
        code: "agent_ambiguous_name",
        message: `Plugin agent bare name is ambiguous; use ${parsed.pluginName}:${parsed.bareName}`,
        path: parsed.agent.path,
      });
    }
  }

  return {
    // 裸名称只是同一插件 agent 的运行时调用别名，不能进入一文件一条的 UI 资源投影。
    profiles: profiles.sort((left, right) => left.name.localeCompare(right.name)),
    runtimeAgents: runtimeAgents.sort((left, right) => left.name.localeCompare(right.name)),
  };
}

export async function rollbackProfileRename(
  journalPath: string,
  stagePath: string,
  targetPath: string,
  journal: AgentProfileRenameJournal,
  options: SubagentStorageOptions | undefined,
): Promise<void> {
  const targetContent = await readOptionalText(targetPath);
  if (targetContent !== undefined && targetContent !== journal.content) {
    throw new Error(
      "Cannot roll back profile rename because the destination changed during recovery",
    );
  }
  if (targetContent !== undefined) await removeProfileRenameFile(targetPath);
  await removeProfileRenameFile(stagePath);
  const state = await readAgentStateFile(options);
  const disabled = new Set(state.disabledAgentIds);
  if (journal.targetWasDisabled) disabled.add(journal.nextAgentID);
  else disabled.delete(journal.nextAgentID);
  const nextDisabled = [...disabled].sort();
  if (
    nextDisabled.length !== state.disabledAgentIds.length ||
    !nextDisabled.every((id, index) => id === state.disabledAgentIds[index])
  ) {
    await writeAgentStateFile({ ...state, disabledAgentIds: nextDisabled }, options);
  }
  await removeProfileRenameFile(journalPath);
}

export async function setRenameDisabledState(
  journal: AgentProfileRenameJournal,
  options: SubagentStorageOptions | undefined,
  phase: "prepare" | "finish",
  preservedSourceAgentID?: string,
): Promise<void> {
  const state = await readAgentStateFile(options);
  const disabled = new Set(state.disabledAgentIds);
  if (phase === "prepare") {
    // 新 ID 在旧文件删除前保持关闭，避免 watcher 短暂加载两个同名 profile。
    disabled.add(journal.nextAgentID);
  } else {
    disabled.delete(journal.previousAgentID);
    if (journal.sourceWasDisabled || journal.targetWasDisabled) disabled.add(journal.nextAgentID);
    else disabled.delete(journal.nextAgentID);
    if (preservedSourceAgentID) disabled.add(preservedSourceAgentID);
  }
  const nextDisabled = [...disabled].sort();
  if (
    nextDisabled.length === state.disabledAgentIds.length &&
    nextDisabled.every((id, index) => id === state.disabledAgentIds[index])
  )
    return;
  await writeAgentStateFile({ ...state, disabledAgentIds: nextDisabled }, options);
}
