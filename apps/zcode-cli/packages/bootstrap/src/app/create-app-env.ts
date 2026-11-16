import { join } from "node:path";
import { resolvePath } from "@zcode/adapters/config";
import { buildPluginReferenceCatalog } from "@zcode/core";
import type { AgentRuntimeConfig } from "@zcode/core";
import type { McpServerConfig, PluginLoadOutcome, SessionStorePort } from "@zcode/contracts";
import { resolveZCodeRuntimeEnv } from "@zcode/shared";

import { subagentProfilesFromSnapshot } from "../runtime-subagents/index.js";
import {
  loadPluginAgentTemplates,
  loadZCodeAgentProfiles,
  resolvePluginAgentProfiles,
} from "../subagents.js";
import { resolveBundledSkillRoots } from "./bundled-skills.js";
import { CliDefaultSelection } from "./cli-default-selection.js";
import type { CreateAppDeps, CreateAppState } from "./create-app-contracts.js";
import {
  createNodeReplBrowserBroker,
  injectNodeReplBrowserBroker,
  type NodeReplBrowserBroker,
} from "./node-repl-browser-broker.js";
import { resolveBuiltInNodeReplMcpServers } from "./built-in-node-repl.js";
import {
  asLocalSettingStore,
  openStartupSessionStore,
  readProjectPermissionMode,
} from "./session-store.js";
import { getCliStorageRoot, getModelIoDir, getPluginStorageRoot, projectIdFromDirectory } from "./paths.js";
import { createPluginRuntimeCatalog } from "./plugin-runtime-catalog.js";
import { resolvePluginRuntimeFeatures } from "./plugin-runtime-features.js";
import {
  readMcpProjectTrustRecords,
  resolveAppRuntimeConfig,
  resolveMcpTrustIdentity,
  runtimeConfigLogContext,
  type ProjectMcpTrustSnapshot,
} from "./runtime-config.js";
import { resolveStartupPlugins } from "./startup-marks.js";
import type { ZCodeAppOptions } from "./types.js";

type PluginTemplates = ReturnType<typeof loadPluginAgentTemplates>;
type LocalSettingStore = ReturnType<typeof asLocalSettingStore>;

/** Результат стадии окружения: конфиг, плагины, subagent-профили и storage-владельцы. */
export interface AppEnvironment {
  storageRoot: string;
  cliStorageRoot: string;
  modelIoDir: string;
  pluginOutcome: PluginLoadOutcome;
  pluginCatalog: ReturnType<typeof createPluginRuntimeCatalog>;
  pluginTemplates: PluginTemplates;
  bundledSkillRoots: ReturnType<typeof resolveBundledSkillRoots>;
  sessionStore: SessionStorePort;
  ownsSessionStore: boolean;
  localSettingStore: LocalSettingStore;
  projectID: ReturnType<typeof projectIdFromDirectory>;
  mcpProjectTrustIdentity: string;
  configuredMcpServers: Record<string, McpServerConfig>;
  runtimeConfig: AgentRuntimeConfig;
  untrustedProjectMcpServers: Set<string>;
  browserControlPort: ZCodeAppOptions["browserControlPort"];
  pluginReferenceCatalog: ReturnType<typeof buildPluginReferenceCatalog>;
  cliDefaultSelection: CliDefaultSelection | undefined;
}

export async function prepareAppEnvironment(
  deps: CreateAppDeps,
  state: CreateAppState,
): Promise<AppEnvironment> {
  const { options, logger, startupTimer, configResult, traceContext, workingDirectory } = deps;
  const storageRoot = resolvePath(configResult.config.storage.dir);
  const cliStorageRoot = getCliStorageRoot(storageRoot);
  const modelIoDir = getModelIoDir(
    cliStorageRoot,
    resolveZCodeRuntimeEnv(options.env ?? process.env) === "development",
  );
  // 初始化与父轮必须使用同一 Host 来源，避免 CLI storage.dir 的另一份定义在首轮消失。
  const hostSubagentSnapshot = await options.readSubagentRuntimeConfig?.({
    signal: new AbortController().signal,
    traceContext,
  });
  const zcodeSubagentProfileOutcome = hostSubagentSnapshot
    ? subagentProfilesFromSnapshot(hostSubagentSnapshot)
    : await loadZCodeAgentProfiles({
        logger,
        storageRoot,
        workingDirectory,
        additionalDirectories: options.additionalDirectories,
      });
  const zcodeSubagentProfiles = zcodeSubagentProfileOutcome.profiles;
  const pluginOutcome = resolveStartupPlugins({
    cliStorageRoot,
    configResult,
    env: options.env,
    logger,
    options,
    startupTimer,
    workingDirectory,
  });
  // 随 CLI 内置的技能包（dynamic-workflows 等）：不属于任何插件，用户无法停用或卸载。
  const bundledSkillRoots = resolveBundledSkillRoots({ cliStorageRoot, logger });
  const pluginStorageRoot =
    options.pluginStorageRoot ?? getPluginStorageRoot(cliStorageRoot);
  const pluginCatalog = createPluginRuntimeCatalog({
    initial: pluginOutcome,
    env: options.env,
    includeVisualize: options.includeVisualize,
    logger,
    officialPluginRoots: options.officialPluginRoots,
    pluginStorageRoot,
    ...(options.projectConfigPath ? { projectConfigPath: options.projectConfigPath } : {}),
    ...(options.skipUserConfig === undefined ? { skipUserConfig: options.skipUserConfig } : {}),
    ...(options.userConfigPath ? { userConfigPath: options.userConfigPath } : {}),
    workingDirectory,
  });
  const pluginTemplates = loadPluginAgentTemplates({ logger, plugins: pluginOutcome.plugins });
  const pluginSubagentProfiles =
    hostSubagentSnapshot?.kind === "built-in-fallback"
      ? []
      : resolvePluginAgentProfiles(
          {
            logger,
            plugins: pluginOutcome.plugins,
            reservedProfileNames: zcodeSubagentProfiles.map((profile) => profile.name),
            modelSelectionOverrides:
              zcodeSubagentProfileOutcome.pluginAgentModelSelectionOverrides,
          },
          pluginTemplates,
        ).profiles;
  const pluginRuntimeFeatures = resolvePluginRuntimeFeatures(pluginOutcome);
  const builtInMcpServers = resolveBuiltInNodeReplMcpServers({
    pluginOutcome,
    workingDirectory,
  });
  // 用户目录已在 loader 前完成原地迁移；不能给项目/插件旧身份加内存兼容旁路。
  const subagentProfiles = [...zcodeSubagentProfiles, ...pluginSubagentProfiles];
  const ownsSessionStore = options.sessionStore === undefined;
  const sessionStore =
    options.sessionStore ?? (await openStartupSessionStore(configResult, startupTimer));
  const localSettingStore = asLocalSettingStore(sessionStore);
  const projectID = projectIdFromDirectory(workingDirectory);
  const persistedMode = options.runtimeConfig?.mode
    ? undefined
    : readProjectPermissionMode(localSettingStore, projectID);
  // project-scope MCP 默认 untrusted：审批记录在启动边界一次性读出，之后只由显式
  // connect 追加。读失败/文件损坏由 readMcpProjectTrustRecords 收口为空集（fail closed）。
  const mcpProjectTrustIdentity = resolveMcpTrustIdentity({
    workspaceIdentity: options.runtimeConfig?.memory?.workspaceIdentity,
    workspacePath: workingDirectory,
  });
  const mcpProjectTrust: ProjectMcpTrustSnapshot = {
    workspaceIdentity: mcpProjectTrustIdentity,
    approvals: await readMcpProjectTrustRecords(storageRoot),
  };
  let { configuredMcpServers, runtimeConfig, untrustedProjectMcpServers } =
    resolveAppRuntimeConfig({
      cliStorageRoot,
      configResult,
      options,
      persistedMode,
      pluginHooks: pluginOutcome.hooks,
      pluginMcpServers: pluginOutcome.mcpServers,
      builtInMcpServers,
      pluginRuntimeFeatures,
      builtInSubagentModelSelectionOverrides:
        zcodeSubagentProfileOutcome.builtInModelSelectionOverrides,
      projectMcpTrust: mcpProjectTrust,
      subagentOutputRootDir: join(cliStorageRoot, "agents"),
      subagentProfiles,
      storageRoot,
      workingDirectory,
      workspaceIdentity: options.runtimeConfig?.memory?.workspaceIdentity,
    });
  const browserControlPort = options.browserControlPort;
  let nodeReplBrowserBroker: NodeReplBrowserBroker | undefined;
  let ownedNodeReplBrowserBroker: NodeReplBrowserBroker | undefined;
  if (
    browserControlPort &&
    pluginRuntimeFeatures.browserUse === true &&
    runtimeConfig.mcp?.servers?.node_repl?.type === "stdio"
  ) {
    nodeReplBrowserBroker =
      options.nodeReplBrowserBroker ??
      (ownedNodeReplBrowserBroker = createNodeReplBrowserBroker({
        browserControlPort,
        logger,
        platform: options.platform,
      }));
    if (ownedNodeReplBrowserBroker) state.ownedNodeReplBrowserBroker = ownedNodeReplBrowserBroker;
    configuredMcpServers = injectNodeReplBrowserBroker(
      configuredMcpServers,
      nodeReplBrowserBroker,
    );
    runtimeConfig.mcp = {
      ...runtimeConfig.mcp,
      servers: injectNodeReplBrowserBroker(
        runtimeConfig.mcp.servers ?? {},
        nodeReplBrowserBroker,
      ),
    };
  }
  startupTimer.mark("ZCode runtime configuration resolved", {
    context: runtimeConfigLogContext(runtimeConfig, workingDirectory),
    event: "bootstrap.app.startup.runtime_config.completed",
    stage: "resolve_runtime_config",
  });
  // Plugin 对话引用：身份 catalog 在 App（Session runtime）
  // 创建时冻结一次。冷恢复会重建 App，天然拿到新 catalog；已有 Session 不热加载新 Plugin。
  const pluginReferenceCatalog = buildPluginReferenceCatalog(pluginOutcome.plugins);
  runtimeConfig.pluginReferenceCatalog = pluginReferenceCatalog;
  const cliDefaultSelection =
    options.modelSelectionMode === "cli-default"
      ? new CliDefaultSelection(runtimeConfig.modelSelection)
      : undefined;
  return {
    storageRoot,
    cliStorageRoot,
    modelIoDir,
    pluginOutcome,
    pluginCatalog,
    pluginTemplates,
    bundledSkillRoots,
    sessionStore,
    ownsSessionStore,
    localSettingStore,
    projectID,
    mcpProjectTrustIdentity,
    configuredMcpServers,
    runtimeConfig,
    untrustedProjectMcpServers,
    browserControlPort,
    pluginReferenceCatalog,
    cliDefaultSelection,
  };
}
