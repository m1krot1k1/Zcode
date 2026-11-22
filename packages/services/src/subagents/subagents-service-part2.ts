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
import { PROFILE_RENAME_JOURNAL_PREFIX, applyRuntimePrecedence, assertNotBuiltInName, attachEnabledState, createBuiltInAgents, discoverFileAgents, discoverPluginAgents, exists, isHardLinkUnavailable, normalizeConfig, parseAgentProfileRenameJournal, parseSavedAgent, readAgentStateAtPath, readAgentStateFile, readOptionalText, removeProfileRenameFile, requireWorkspacePath, resolveCapabilities, rollbackProfileRename, setRenameDisabledState, sha256, subagentLogger, validateUserAgentConfig, writeAgentStateFile } from "./subagents-service-part1.js";
import type { AgentProfileRenameJournal, SubagentsServiceOptions } from "./subagents-service-part1.js";

// Часть 2/2 модуля subagents-service: вынесено по лимиту строк.

export async function recoverAgentProfileRenames(
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
