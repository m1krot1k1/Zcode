/* eslint-disable max-lines */
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

const subagentLogger = createServiceLogger("subagents");

interface AgentsStateFile {
  builtInModelSelectionOverrides: BuiltInSubagentModelSelectionOverrides;
  pluginAgentModelSelectionOverrides: PluginSubagentModelSelectionOverrides;
  disabledAgentIds: string[];
  // 仅供旧版本回滚保留；新版存在选择字段后，禁止再从这两个字段恢复覆盖。
  builtInModelOverrides?: unknown;
  builtInThoughtLevelOverrides?: unknown;
}

interface InstalledPluginsStateFile {
  plugins?: unknown;
}

interface PluginConfigSummary {
  enabledPlugins: Record<string, boolean>;
  suppressedBuiltins: string[];
}

interface InstalledPluginRecord {
  id: string;
  installPath: string;
  name: string;
  scope?: "user" | "workspace";
  projectPath?: string;
}

interface SubagentsServiceOptions extends SubagentStorageOptions {
  isDesktopRuntime?: boolean;
}

interface PluginAgentDiscovery {
  profiles: AgentSummary[];
  runtimeAgents: AgentSummary[];
}

interface AgentProfileRenameJournal {
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

const BUILT_IN_AGENT_NAMES = new Set(["Explore"]);
const PROFILE_RENAME_JOURNAL_PREFIX = ".zcode-profile-rename-";
const MAX_PROFILE_RENAME_CONTENT_BYTES = 1024 * 1024;
const PLUGIN_MANIFEST_PATHS = [
  join(".zcode-plugin", "plugin.json"),
  join(".claude-plugin", "plugin.json"),
  join(".codex-plugin", "plugin.json"),
] as const;

function createBuiltInAgents(
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

function emptyAgentsState(): AgentsStateFile {
  return {
    builtInModelSelectionOverrides: {},
    pluginAgentModelSelectionOverrides: {},
    disabledAgentIds: [],
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readAgentStateFile(options?: SubagentsServiceOptions): Promise<AgentsStateFile> {
  return readAgentStateAtPath(await resolveSubagentStateFile(options));
}

async function readAgentStateAtPath(stateFile: string): Promise<AgentsStateFile> {
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

async function writeAgentStateFile(
  next: AgentsStateFile,
  options?: SubagentStorageOptions,
): Promise<void> {
  const stateFile = await resolveSubagentStateFile(options);
  await mkdir(dirname(stateFile), { recursive: true });
  await atomicWriteText(stateFile, JSON.stringify(next, null, 2));
}

async function discoverFileAgents(params: {
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

async function collectAgentMarkdownPaths(rootPath: string, recursive = false): Promise<string[]> {
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

function resolveCapabilities(options?: SubagentsServiceOptions): AgentsCapability {
  const isDesktopRuntime = options?.isDesktopRuntime ?? Boolean(process.env.ZCODE_PROCESS_LABEL);
  if (isDesktopRuntime) {
    return { userScopeAvailable: true };
  }
  return { userScopeAvailable: false, userScopeReason: "desktop_only" };
}

function attachEnabledState(agents: AgentSummary[], state: AgentsStateFile): AgentSummary[] {
  const disabledSet = new Set(state.disabledAgentIds);
  return agents.map((agent) => ({
    ...agent,
    enabled: agent.scope === "user" ? !disabledSet.has(agent.id) : true,
  }));
}

function applyRuntimePrecedence(agents: AgentSummary[]): AgentSummary[] {
  const byName = new Map<string, AgentSummary>();
  for (const agent of agents) {
    byName.set(agent.name, agent);
  }
  return [...byName.values()];
}

async function discoverPluginAgents(params: {
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

async function readPluginConfig(options?: SubagentStorageOptions): Promise<PluginConfigSummary> {
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

/** 内置插件没有安装记录，只扫描 installed 文件会漏掉；缓存只补缺失身份，不能复活禁用/卸载插件。 */
async function readEnabledPluginRecords(
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

async function readInstalledPluginRecords(
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

function isInstalledPluginRecord(value: unknown): value is InstalledPluginRecord {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.installPath === "string" &&
    typeof value.name === "string"
  );
}

async function collectPluginAgentMarkdownPaths(rootPath: string): Promise<string[]> {
  const manifest = await readPluginManifest(rootPath);
  const roots = collectPluginAgentRoots(rootPath, manifest?.agents);
  const paths = await Promise.all(roots.map((root) => collectAgentMarkdownPaths(root, true)));
  return paths.flat().sort((left, right) => left.localeCompare(right));
}

async function readPluginManifest(rootPath: string): Promise<Record<string, unknown> | null> {
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

function collectPluginAgentRoots(rootPath: string, manifestAgents: unknown): string[] {
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

function applyPluginAgentOverrides(agent: AgentSummary, state: AgentsStateFile): AgentSummary {
  const override = state.pluginAgentModelSelectionOverrides[agent.id];
  // 插件文件只提供默认值；覆盖替换整份选择，不能混入原模型的档位。
  return {
    ...agent,
    defaultModelSelection: agent.modelSelection,
    ...(override ? { modelSelection: override, modelSelectionOverride: override } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBuiltInSelectionOverrides(
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

export function createSubagentsService(options?: SubagentsServiceOptions): ISubagentsService & {
  /** Host 启动/重启 Agent 前准备配置，不暴露为 Renderer RPC。 */
  prepareRuntimeState(workspace?: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<void>;
  readRuntimeConfig(workspace: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<SubagentRuntimeConfig>;
  disposeAll(): Promise<void>;
} {
  let writeQueue = Promise.resolve();
  let disposed = false;
  const storageOptions: SubagentsServiceOptions = {
    homeDir: options?.homeDir,
  };

  const runtimeConfig = createSubagentRuntimeConfigCache({
    readUserRoot: () => resolveUserSubagentRoot(storageOptions),
    readStatePath: () => resolveSubagentStateFile(storageOptions),
    readState: readAgentStateAtPath,
  });
  function enqueue<T>(run: () => Promise<T>): Promise<T> {
    const queued = writeQueue.then(run, run);
    writeQueue = queued.then(
      () => {},
      () => {},
    );
    return queued;
  }
  function mutate<T>(run: () => Promise<T>): Promise<T> {
    return enqueue(async () => {
      if (disposed) throw new Error("Subagents service is disposed");
      return run();
    });
  }
  async function recoverProfileRoots(workspacePath?: string): Promise<void> {
    await recoverAgentProfileRenames(
      await resolveUserSubagentRoot(storageOptions),
      "user",
      storageOptions,
    );
    if (workspacePath) {
      await recoverAgentProfileRenames(
        resolveWorkspaceSubagentRoot(workspacePath),
        "workspace",
        storageOptions,
      );
    }
  }
  const service = {
    readRuntimeConfig: (workspace: { workspacePath: string; workspaceIdentity?: string }) =>
      enqueue(async () => {
        await recoverProfileRoots(workspace.workspacePath);
        return runtimeConfig.read(workspace);
      }),
    disposeAll() {
      disposed = true;
      return runtimeConfig.dispose();
    },
    async prepareRuntimeState(workspace?: { workspacePath: string; workspaceIdentity?: string }) {
      return enqueue(async () => {
        await recoverProfileRoots(workspace?.workspacePath);
        const markdownMigration = await migrateUserSubagentMarkdown(
          await resolveUserSubagentRoot(storageOptions),
        );
        for (const failure of markdownMigration.failures)
          subagentLogger.warn(undefined, "用户 Subagent Markdown 迁移失败，保留原文件", failure);
        // state 的迁移由缓存读取入口统一执行，IO 失败同样发布回退，不能提前阻断 CLI 启动。
        await runtimeConfig.prepare(workspace);
      });
    },

    async list(params: {
      workspacePath: string;
      workspaceIdentity?: string;
      provider?: ZCodeProvider;
      mode?: SubagentsListMode;
    }): Promise<AgentsListResult> {
      const capability = resolveCapabilities(options);
      const mode = params.mode ?? "allRuntimeScopes";
      const diagnostics: AgentDiagnostic[] = [];
      let includeUserAgents = capability.userScopeAvailable;
      let includeWorkspaceAgents = mode === "allRuntimeScopes";
      if (includeUserAgents) {
        try {
          await recoverAgentProfileRenames(
            await resolveUserSubagentRoot(storageOptions),
            "user",
            storageOptions,
          );
        } catch (error) {
          includeUserAgents = false;
          diagnostics.push({
            code: "agent_read_failed",
            message: `Agent profile recovery failed: ${String(error)}`,
          });
        }
      }
      if (includeWorkspaceAgents) {
        try {
          await recoverAgentProfileRenames(
            resolveWorkspaceSubagentRoot(params.workspacePath),
            "workspace",
            storageOptions,
          );
        } catch (error) {
          includeWorkspaceAgents = false;
          diagnostics.push({
            code: "agent_read_failed",
            message: `Agent profile recovery failed: ${String(error)}`,
          });
        }
      }
      if (includeUserAgents) {
        const migration = await migrateUserSubagentMarkdown(
          await resolveUserSubagentRoot(storageOptions),
        );
        for (const failure of migration.failures)
          diagnostics.push({
            code: "agent_read_failed",
            message: "Subagent Markdown migration failed; original file preserved",
            path: failure.path,
          });
      }
      const state = await readAgentStateFile(storageOptions);
      const builtInAgents = createBuiltInAgents(state.builtInModelSelectionOverrides);
      const fileAgents = await discoverFileAgents({
        diagnostics,
        includeUserAgents,
        includeWorkspaceAgents,
        storageOptions,
        workspacePath: params.workspacePath,
      });
      const sortedUserAgents = fileAgents
        .filter((agent) => agent.scope === "user")
        .sort((left, right) => left.name.localeCompare(right.name));
      const sortedWorkspaceAgents = fileAgents
        .filter((agent) => agent.scope === "workspace")
        .sort((left, right) => left.name.localeCompare(right.name));
      // 用户页不能读项目 profile，但仍需展示本地插件的只读覆盖入口；不能把两者一并剪掉。
      const pluginAgentDiscovery = await discoverPluginAgents({
        diagnostics,
        state,
        reservedNames: [
          ...builtInAgents.map((agent) => agent.name),
          ...sortedUserAgents.map((agent) => agent.name),
          ...sortedWorkspaceAgents.map((agent) => agent.name),
        ],
        storageOptions,
      });
      const discoveredAgents =
        mode === "settingsUserOnly"
          ? [...builtInAgents, ...sortedUserAgents]
          : applyRuntimePrecedence([
              ...builtInAgents,
              ...sortedUserAgents,
              ...sortedWorkspaceAgents,
              ...pluginAgentDiscovery.runtimeAgents,
            ]);
      const agents = attachEnabledState(discoveredAgents, state);

      return {
        agents,
        userAgents: agents.filter((agent) => agent.source === "user"),
        pluginAgents: attachEnabledState(pluginAgentDiscovery.profiles, state),
        capability,
        diagnostics,
      };
    },

    async setEnabled(params: { agentId: string; enabled: boolean }): Promise<void> {
      const runUpdate = async () => {
        const state = await readAgentStateFile(storageOptions);
        const previous = new Set(state.disabledAgentIds);
        if (params.enabled) {
          previous.delete(params.agentId);
        } else {
          previous.add(params.agentId);
        }
        state.disabledAgentIds = [...previous].sort();
        await writeAgentStateFile(state, storageOptions);
      };

      await mutate(runUpdate);
    },

    async setBuiltInModelOverride(params: BuiltInSubagentModelOverrideParams): Promise<void> {
      const runUpdate = async () => {
        const state = await readAgentStateFile(storageOptions);
        const builtInModelSelectionOverrides = {
          ...state.builtInModelSelectionOverrides,
        };
        const modelSelection = normalizeSubagentModelSelection(params.modelSelection);
        if (modelSelection) {
          builtInModelSelectionOverrides[params.agentName] = modelSelection;
        } else {
          delete builtInModelSelectionOverrides[params.agentName];
        }
        await writeAgentStateFile(
          {
            ...state,
            builtInModelSelectionOverrides,
          },
          storageOptions,
        );
      };

      await mutate(runUpdate);
    },

    async setPluginAgentModelOverride(params: PluginSubagentModelOverrideParams): Promise<void> {
      if (!params.agentId.startsWith("plugin:") || params.agentId.trim() !== params.agentId)
        throw new Error("无效插件 Subagent 身份");
      const runUpdate = async () => {
        const state = await readAgentStateFile(storageOptions);
        const overrides = { ...state.pluginAgentModelSelectionOverrides };
        const selection = normalizeSubagentModelSelection(params.modelSelection);
        if (selection) overrides[params.agentId] = selection;
        else delete overrides[params.agentId];
        await writeAgentStateFile(
          { ...state, pluginAgentModelSelectionOverrides: overrides },
          storageOptions,
        );
      };
      await mutate(runUpdate);
    },

    async getPrimaryUserAgentsDirectory(_params: { provider: ZCodeProvider }): Promise<{
      path: string;
    }> {
      const path = await resolveUserSubagentRoot(storageOptions);
      await mkdir(path, { recursive: true });
      return { path };
    },

    async createAgent(params: AgentCreateParams): Promise<{ agent: AgentSummary }> {
      validateUserAgentConfig(params.config);
      assertNotBuiltInName(params.config.name);

      const scope = params.scope ?? "user";
      const agentDir =
        scope === "workspace"
          ? resolveWorkspaceSubagentRoot(requireWorkspacePath(params.workspacePath))
          : await resolveUserSubagentRoot(storageOptions);
      const filePath = join(agentDir, `${params.config.name.trim().toLowerCase()}.md`);
      await mkdir(agentDir, { recursive: true });
      if (await exists(filePath)) {
        throw new Error(`Agent file "${basename(filePath)}" already exists`);
      }

      const content = serializeSubagentMarkdown(normalizeConfig(params.config));
      const agent = parseSavedAgent(content, filePath, scope, params.workspacePath);
      // 先验证即将写入的 Markdown 可解析，避免 serializer 回归时把坏 profile 落盘。
      await writeFile(filePath, content, { encoding: "utf-8", flag: "wx" });
      return { agent };
    },

    async updateAgent(params: AgentUpdateParams): Promise<{ agent: AgentSummary }> {
      validateUserAgentConfig(params.config);
      assertNotBuiltInName(params.config.name);

      const scope = params.scope ?? "user";
      const agentDir =
        scope === "workspace"
          ? resolveWorkspaceSubagentRoot(requireWorkspacePath(params.workspacePath))
          : await resolveUserSubagentRoot(storageOptions);
      const filePath = join(agentDir, `${params.config.name.trim().toLowerCase()}.md`);
      await mkdir(agentDir, { recursive: true });
      await recoverAgentProfileRenames(agentDir, scope, storageOptions);

      if (params.oldFilePath && params.oldFilePath !== filePath && (await exists(filePath))) {
        throw new Error(`Agent file "${basename(filePath)}" already exists`);
      }

      const content = serializeSubagentMarkdown(normalizeConfig(params.config));
      const agent = parseSavedAgent(content, filePath, scope, params.workspacePath);
      if (params.oldFilePath && resolve(params.oldFilePath) !== resolve(filePath)) {
        if (resolve(dirname(params.oldFilePath)) !== resolve(agentDir)) {
          throw new Error("Agent profile rename must stay within its current ZCode profile root");
        }
        const sourceContent = await readOptionalText(params.oldFilePath);
        if (sourceContent === undefined)
          throw new Error("Agent profile changed before rename; reload the profile and retry");
        const parsedSource = parseSubagentMarkdown({
          content: sourceContent,
          path: params.oldFilePath,
          scope,
        });
        const workspaceCompatibilityID =
          scope === "workspace" && params.workspacePath && parsedSource.agent
            ? `workspace:${params.workspacePath}:${parsedSource.agent.name.trim().toLowerCase()}`
            : undefined;
        // 旧 Host 对 workspace profile 暴露的是 path-scoped ID；重命名校验应接受该兼容 ID，
        // 但必须同时核对文件中的名称，不能因路径大小写或缓存 ID 形式差异误拒绝真实 profile。
        if (
          !parsedSource.agent ||
          (parsedSource.agent.id !== params.agentId && workspaceCompatibilityID !== params.agentId)
        ) {
          throw new Error(
            "Agent profile identity changed before rename; reload the profile and retry",
          );
        }
        const state = await readAgentStateFile(storageOptions);
        const transactionID = randomUUID();
        const journal: AgentProfileRenameJournal = {
          version: 1,
          transactionID,
          sourceFileName: basename(params.oldFilePath),
          targetFileName: basename(filePath),
          stageFileName: `${basename(filePath)}.${transactionID}.pending`,
          previousAgentID: params.agentId,
          nextAgentID: agent.id,
          sourceHash: sha256(sourceContent),
          contentHash: sha256(content),
          content,
          sourceWasDisabled: state.disabledAgentIds.includes(params.agentId),
          targetWasDisabled: state.disabledAgentIds.includes(agent.id),
        };
        const journalPath = join(agentDir, `${PROFILE_RENAME_JOURNAL_PREFIX}${transactionID}.json`);
        await atomicWriteText(journalPath, JSON.stringify(journal));
        await recoverAgentProfileRenames(agentDir, scope, storageOptions);
        return { agent };
      }
      // 旧实现直接覆盖 Markdown；进程退出或磁盘失败时 watcher 可能读到半份 profile，
      // 且旧配置无法恢复。先 parse，再同目录临时文件 + rename 原子替换。
      await atomicWriteText(filePath, content);
      return { agent };
    },

    async deleteAgent(params: AgentDeleteParams): Promise<void> {
      await rm(params.filePath, { force: true });

      const state = await readAgentStateFile(storageOptions);
      const disabledSet = new Set(state.disabledAgentIds);
      disabledSet.delete(params.agentId);
      state.disabledAgentIds = [...disabledSet].sort();
      await writeAgentStateFile(state, storageOptions);
    },
  };
  return {
    ...service,
    createAgent: (params: AgentCreateParams) => mutate(() => service.createAgent(params)),
    updateAgent: (params: AgentUpdateParams) => mutate(() => service.updateAgent(params)),
    deleteAgent: (params: AgentDeleteParams) => mutate(() => service.deleteAgent(params)),
  };
}

function validateUserAgentConfig(config: SubAgentConfig): void {
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

function assertNotBuiltInName(name: string): void {
  if (BUILT_IN_AGENT_NAMES.has(name.trim())) {
    throw new Error(`Agent name "${name.trim()}" is reserved by a built-in agent`);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isProfileLeafName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9-]+\.(?:md|markdown)$/iu.test(value);
}

async function removeProfileRenameFile(path: string): Promise<void> {
  maybeThrowInjectedFsFault({ operation: "rm", path });
  await rm(path, { force: true });
}

function parseAgentProfileRenameJournal(
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

async function readOptionalText(path: string): Promise<string | undefined> {
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

async function rollbackProfileRename(
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

function isHardLinkUnavailable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EOPNOTSUPP" || code === "ENOTSUP" || code === "ENOSYS";
}

async function setRenameDisabledState(
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

async function recoverAgentProfileRenames(
  rootPath: string,
  scope: "user" | "workspace",
  options: SubagentStorageOptions | undefined,
): Promise<void> {
  const entries = await readdir(rootPath, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) =>
      // case-insensitive root 在 macOS/Windows 上可能被暂时替换成普通文件；
      // это тот же отсутствующий профильный каталог, который watcher публикует как пустой.
      ["ENOENT", "ENOTDIR"].includes(error.code ?? "") ? [] : Promise.reject(error),
  );
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      !entry.name.startsWith(PROFILE_RENAME_JOURNAL_PREFIX) ||
      !entry.name.endsWith(".json")
    )
      continue;
    const transactionID = entry.name.slice(PROFILE_RENAME_JOURNAL_PREFIX.length, -".json".length);
    if (!/^[0-9a-f-]{36}$/iu.test(transactionID))
      throw new Error("Invalid profile rename journal filename");
    const journalPath = join(rootPath, entry.name);
    let journal: AgentProfileRenameJournal;
    try {
      journal = parseAgentProfileRenameJournal(
        JSON.parse(await readFile(journalPath, "utf8")),
        transactionID,
      );
    } catch (error) {
      throw new Error(
        `Unable to recover agent profile rename journal ${entry.name}: ${String(error)}`,
      );
    }
    const sourcePath = join(rootPath, journal.sourceFileName);
    const targetPath = join(rootPath, journal.targetFileName);
    const stagePath = join(rootPath, journal.stageFileName);
    const targetContent = await readOptionalText(targetPath);
    if (targetContent !== undefined && targetContent !== journal.content) {
      throw new Error(
        `Agent profile rename destination already contains different content: ${journal.targetFileName}`,
      );
    }
    const stageContent = await readOptionalText(stagePath);
    if (stageContent !== undefined && stageContent !== journal.content) {
      throw new Error(
        `Agent profile rename staging file contains different content: ${journal.stageFileName}`,
      );
    }
    if (targetContent === undefined && stageContent === undefined)
      await atomicWriteText(stagePath, journal.content);
    await setRenameDisabledState(journal, options, "prepare");
    if (targetContent === undefined) {
      maybeThrowInjectedFsFault({ operation: "rename", path: targetPath });
      try {
        // Same-directory link is atomic and fails with EEXIST rather than replacing a concurrent destination.
        await link(stagePath, targetPath);
      } catch (error) {
        if (!isHardLinkUnavailable(error)) throw error;
        await rollbackProfileRename(journalPath, stagePath, targetPath, journal, options);
        throw new Error(
          `This filesystem cannot safely publish an agent profile rename (${String((error as NodeJS.ErrnoException).code)})`,
        );
      }
      await removeProfileRenameFile(stagePath);
    } else if (stageContent !== undefined) {
      await removeProfileRenameFile(stagePath);
    }
    let preservedSourceAgentID: string | undefined;
    const sourceContent = await readOptionalText(sourcePath);
    if (sourceContent !== undefined) {
      if (sha256(sourceContent) === journal.sourceHash) {
        await removeProfileRenameFile(sourcePath);
      } else {
        const parsedSource = parseSubagentMarkdown({
          content: sourceContent,
          path: sourcePath,
          scope,
        });
        if (parsedSource.agent?.id === journal.nextAgentID) {
          await rollbackProfileRename(journalPath, stagePath, targetPath, journal, options);
          throw new Error(
            "Agent profile source now has the destination identity; resolve this conflict manually",
          );
        }
        if (parsedSource.agent?.id) preservedSourceAgentID = parsedSource.agent.id;
      }
    }
    await setRenameDisabledState(journal, options, "finish", preservedSourceAgentID);
    await removeProfileRenameFile(journalPath);
  }
}

function normalizeConfig(config: SubAgentConfig): SubAgentConfig {
  return {
    ...config,
    name: config.name.trim(),
    description: config.description.trim(),
    systemPrompt: config.systemPrompt.trim(),
    modelSelection: normalizeSubagentModelSelection(config.modelSelection),
  };
}

function requireWorkspacePath(workspacePath: string | undefined): string {
  const value = workspacePath?.trim();
  if (!value) throw new Error("Workspace path is required for workspace subagents");
  return value;
}

function parseSavedAgent(
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
