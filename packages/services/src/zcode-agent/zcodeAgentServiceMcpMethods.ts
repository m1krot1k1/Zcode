import type {
  IZCodeAgentService,
  ZCodeAgentAppToolCallForUiParams,
  ZCodeAgentAppToolInstanceForUiParams,
  ZCodeAgentCallMcpToolForUiParams,
  ZCodeAgentCancelMcpToolCallForUiParams,
  ZCodeAgentConnectMcpServerParams,
  ZCodeAgentDeleteSavedWorkflowParams,
  ZCodeAgentFindSavedWorkflowForRunParams,
  ZCodeAgentGetSavedWorkflowParams,
  ZCodeAgentListMcpResourcesForUiParams,
  ZCodeAgentListMcpServerStatusesParams,
  ZCodeAgentListSavedWorkflowRunsParams,
  ZCodeAgentListSavedWorkflowsParams,
  ZCodeAgentMcpResourceSubscriptionForUiParams,
  ZCodeAgentMoveSavedWorkflowParams,
  ZCodeAgentPluginReferenceCatalogParams,
  ZCodeAgentPluginViewParams,
  ZCodeAgentReadMcpResourceForUiParams,
  ZCodeAgentReadMcpResourceParams,
  ZCodeAgentRegisterAppToolsForUiParams,
  ZCodeAgentResolveAppToolCallForUiParams,
  ZCodeAgentResolveSuggestedPluginReferenceParams,
  ZCodeAgentSaveSavedWorkflowFromRunParams,
  ZCodeAgentSkillReferenceCatalogParams,
  ZCodeAgentUpdateSavedWorkflowMetaParams,
  ZCodeAgentWorkspaceTarget,
} from "./zcodeAgent.js";
import type { ZCodeAgentServiceRuntime } from "./zcodeAgentServiceRuntime.js";
import {
  CHILD_PROCESSES_REQUEST_TIMEOUT_MS,
  PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS,
  buildWorkspaceRef,
  getUnrecognizedTopLevelKeys,
  isProtocolMethodNotFoundError,
  isProtocolRequestTimeout,
  logger,
  savedWorkflowScopeParam,
} from "./zcodeAgentServiceSupport.js";
import {
  ZCODE_AGENT_PROVIDER,
  resolveWorkspaceKey,
  type ZCodeProcessChildProcess,
  zcodeMcpConnectResultSchema,
  zcodeMcpListResultSchema,
  zcodeMcpReadResourceResultSchema,
  zcodeMcpUiAppToolAcceptedResultSchema,
  zcodeMcpUiCallToolResultSchema,
  zcodeMcpUiCancelCallResultSchema,
  zcodeMcpUiCloseInstanceResultSchema,
  zcodeMcpUiListResourceTemplatesResultSchema,
  zcodeMcpUiListResourcesResultSchema,
  zcodeMcpUiOpenInstanceResultSchema,
  zcodeMcpUiReadResourceResultSchema,
  zcodeMcpUiRegisterAppToolsResultSchema,
  zcodeMcpUiResourceSubscriptionResultSchema,
  zcodeMcpUiResourceSubscriptionResultSchema as mcpUiEmptyResultSchema,
  zcodeMcpUiSamplingResultSchema,
  zcodeMcpUiUnregisterAppToolsResultSchema,
  zcodePluginsListResultSchema,
  zcodePluginsListUiSurfacesResultSchema,
  zcodePluginsResolveSuggestedReferenceResultSchema,
  zcodeProcessChildProcessesResultSchema,
  zcodeProtocolMethods,
  zcodeSkillsReferenceCatalogResultSchema,
  zcodeWorkflowsDeleteResultSchema,
  zcodeWorkflowsForRunResultSchema,
  zcodeWorkflowsGetResultSchema,
  zcodeWorkflowsListResultSchema,
  zcodeWorkflowsMoveResultSchema,
  zcodeWorkflowsRunsResultSchema,
  zcodeWorkflowsSaveResultSchema,
  zcodeWorkflowsUpdateMetaResultSchema,
} from "@zcode/shared";
import {
  ZCodeAgentMcpConnectUnsupportedError,
  ZCodeAgentMcpStatusModeUnsupportedError,
} from "#src/zcode-agent/zcodeAgentErrors.js";
import { MCP_APPS_SAMPLING_TRANSPORT_TIMEOUT_MS } from "@zcode/shared/mcp-apps";
import { requestPluginReferenceCatalog } from "#src/zcode-agent/pluginReferenceCatalogRequest.js";

export function createMcpMethods(
  ctx: ZCodeAgentServiceRuntime,
): Pick<
  IZCodeAgentService,
  | "listMcpServerStatuses"
  | "connectMcpServer"
  | "listPlugins"
  | "getPluginReferenceCatalog"
  | "getSkillReferenceCatalog"
  | "openMcpUiInstance"
  | "validateMcpUiInstance"
  | "recycleMcpUiInstance"
  | "closeMcpUiInstance"
  | "readMcpResource"
  | "sampleMcpApp"
  | "cancelMcpAppSampling"
  | "callMcpToolForUi"
  | "cancelMcpToolCallForUi"
  | "readMcpResourceForUi"
  | "listMcpResourcesForUi"
  | "listMcpResourceTemplatesForUi"
  | "subscribeMcpResourceForUi"
  | "unsubscribeMcpResourceForUi"
  | "registerAppToolsForUi"
  | "unregisterAppToolsForUi"
  | "claimAppToolCallForUi"
  | "resolveAppToolCallForUi"
  | "listPluginUiSurfaces"
  | "listSavedWorkflows"
  | "getSavedWorkflow"
  | "updateSavedWorkflowMeta"
  | "deleteSavedWorkflow"
  | "listSavedWorkflowRuns"
  | "moveSavedWorkflow"
  | "saveSavedWorkflowFromRun"
  | "findSavedWorkflowForRun"
  | "resolveSuggestedPluginReference"
  | "onDynamicPluginOperationProgress"
  | "collectLocalRuntimeChildProcesses"
> {
  const {
    getMcpStatusClient,
    getPluginManagementClient,
    getPluginOperationProgressEmitter,
    getReadOnlyClient,
    mcpStatusProcessManager,
    pluginProcessManager,
    processManager,
    resolveSavedWorkflowCarrier,
  } = ctx;
  return {
    async listMcpServerStatuses(params: ZCodeAgentListMcpServerStatusesParams) {
      const requestMcpList = async (options?: { omitMcpServers?: boolean; omitMode?: boolean }) => {
        const client = await getMcpStatusClient();
        return client.request(
          zcodeProtocolMethods.mcpList,
          {
            workspace: buildWorkspaceRef(params),
            ...(params.mcpServers !== undefined && !options?.omitMcpServers
              ? { mcpServers: params.mcpServers }
              : {}),
            ...(params.mode !== undefined && !options?.omitMode ? { mode: params.mode } : {}),
          },
          zcodeMcpListResultSchema,
        );
      };
      try {
        return await requestMcpList();
      } catch (error) {
        const unrecognizedKeys = getUnrecognizedTopLevelKeys(error);
        if (params.mode === "status" && unrecognizedKeys.includes("mode")) {
          // 旧 Agent 不认识 status-only 时，省略 mode 重试会退回默认 connect，
          // 重新执行 replace 收敛并可能断开 UI 显式下发但旧 Agent 配置中不存在的 MCP；
          // 稳定错误码会跨 host RPC 保留，供 UI 停止不可能成功的轮询。
          logger.warn(undefined, "旧 Agent 不支持 MCP status-only，跳过会改变连接集合的兼容重试", {
            workspaceKey: resolveWorkspaceKey(params),
            workspacePath: params.workspacePath,
          });
          throw new ZCodeAgentMcpStatusModeUnsupportedError();
        }
        if (
          (params.mode !== undefined && unrecognizedKeys.includes("mode")) ||
          (params.mcpServers !== undefined && unrecognizedKeys.includes("mcpServers"))
        ) {
          const omitMode = unrecognizedKeys.includes("mode");
          const omitMcpServers = unrecognizedKeys.includes("mcpServers");
          logger.warn(undefined, "MCP 状态列表命中新旧协议兼容重试", {
            omittedKeys: [...(omitMode ? ["mode"] : []), ...(omitMcpServers ? ["mcpServers"] : [])],
            workspaceKey: resolveWorkspaceKey(params),
            workspacePath: params.workspacePath,
          });
          return await requestMcpList({
            omitMcpServers,
            omitMode,
          });
        }
        if (!isProtocolRequestTimeout(error, zcodeProtocolMethods.mcpList)) {
          throw error;
        }
        logger.warn(undefined, "MCP 状态列表请求超时，重启无响应 agent 后重试一次", {
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
          message: error instanceof Error ? error.message : String(error),
        });
        return await requestMcpList();
      }
    },

    async connectMcpServer(params: ZCodeAgentConnectMcpServerParams) {
      // 与 mcp/list 复用同一 mcp-status 控制面进程：approval store 与连接都在同一个
      // agent 进程内，设置页连接成功后紧接着的 status 刷新能看到一致结果。
      const client = await getMcpStatusClient();
      try {
        return await client.request(
          zcodeProtocolMethods.mcpConnect,
          {
            workspace: buildWorkspaceRef(params),
            serverName: params.serverName,
            approveProjectScope: params.approveProjectScope === true,
            ...(params.mcpServers !== undefined ? { mcpServers: params.mcpServers } : {}),
          },
          zcodeMcpConnectResultSchema,
        );
      } catch (error) {
        if (isProtocolMethodNotFoundError(error)) {
          // 旧 Agent 没有 mcp/connect：不能回退到会隐式启动 project MCP 的旧路径，
          // 用稳定 code 让设置页提示升级/重启 Agent。
          logger.warn(undefined, "旧 Agent 不支持 MCP 显式连接", {
            workspaceKey: resolveWorkspaceKey(params),
            workspacePath: params.workspacePath,
          });
          throw new ZCodeAgentMcpConnectUnsupportedError();
        }
        throw error;
      }
    },

    async listPlugins(params: ZCodeAgentPluginViewParams) {
      const requestPluginsList = async () => {
        const client = await getPluginManagementClient();
        // plugins/list 只读取本地 plugin metadata，与 mcp/list 一样走默认协议超时，
        // 这样 stale client 能在合理时间内触发回收并重试，而不是被 5 分钟市场 I/O 超时拖住。
        return client.request(
          zcodeProtocolMethods.pluginsList,
          {
            workspace: buildWorkspaceRef(params),
            ...(params.configScope ? { configScope: params.configScope } : {}),
          },
          zcodePluginsListResultSchema,
        );
      };
      try {
        return await requestPluginsList();
      } catch (error) {
        if (!isProtocolRequestTimeout(error, zcodeProtocolMethods.pluginsList)) {
          throw error;
        }
        logger.warn(undefined, "插件列表请求超时，重启无响应 agent 后重试一次", {
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
          message: error instanceof Error ? error.message : String(error),
        });
        // 插件列表只读取 CLI plugin metadata。若旧 agent 进程还活着但协议不回包，
        // 第一次 plugins/list 超时后不能继续复用 stale client。process manager 会在超时时回收该 client，
        // 这里对幂等的列表请求重试一次，让设置页可从重新拉起的 app-server 自动恢复。
        return await requestPluginsList();
      }
    },

    async getPluginReferenceCatalog(params: ZCodeAgentPluginReferenceCatalogParams) {
      // Plugin 引用 catalog 必须打到持有 session 记录的 workspace agent client
      // （getReadOnlyClient 优先复用 active client），不能走独立 plugin management 进程——
      // 那个进程没有任何 session，session-owned catalog 会永远查不到。
      const client = await getReadOnlyClient(params);
      return requestPluginReferenceCatalog(client, {
        workspace: buildWorkspaceRef(params),
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      });
    },

    async getSkillReferenceCatalog(params: ZCodeAgentSkillReferenceCatalogParams) {
      // 与 Plugin 引用一样，Session 快照只存在于 workspace agent 进程；独立管理进程
      // 没有 resident Session，不能作为对话 authority。
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.skillsReferenceCatalog,
        {
          workspace: buildWorkspaceRef(params),
          ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        },
        zcodeSkillsReferenceCatalogResultSchema,
      );
    },

    async openMcpUiInstance(params) {
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.mcpUiOpenInstance,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          pluginId: params.pluginId,
          serverName: params.serverName,
          scopeId: params.scopeId,
          accountContext: params.accountContext,
          resourceUri: params.resourceUri,
          ownerWebContentsId: params.ownerWebContentsId,
        },
        zcodeMcpUiOpenInstanceResultSchema,
      );
    },
    async validateMcpUiInstance(params) {
      const client = await getReadOnlyClient(params);
      await client.request(
        zcodeProtocolMethods.mcpUiValidateInstance,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          pluginId: params.pluginId,
          serverName: params.serverName,
          instance: params.instance,
        },
        mcpUiEmptyResultSchema,
      );
    },
    async recycleMcpUiInstance(params) {
      const client = await getReadOnlyClient(params);
      const result = await client.request(
        zcodeProtocolMethods.mcpUiCloseInstance,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          pluginId: params.pluginId,
          serverName: params.serverName,
          instance: params.instance,
          onlyIfIdle: true,
        },
        zcodeMcpUiCloseInstanceResultSchema,
      );
      return result.closed;
    },
    async closeMcpUiInstance(params) {
      const client = await getReadOnlyClient(params);
      await client.request(
        zcodeProtocolMethods.mcpUiCloseInstance,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          pluginId: params.pluginId,
          serverName: params.serverName,
          instance: params.instance,
        },
        zcodeMcpUiCloseInstanceResultSchema,
      );
    },
    async readMcpResource(params: ZCodeAgentReadMcpResourceParams) {
      // 与 Skill / Plugin 引用一样，session 冻结 catalog 只存在于 workspace agent 进程。
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.mcpReadResource,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          uri: params.uri,
        },
        zcodeMcpReadResourceResultSchema,
      );
    },

    async sampleMcpApp(params) {
      const client = await getReadOnlyClient(params, "existing-only");
      const { workspacePath: _path, workspaceIdentity: _identity, ...bound } = params;
      const wire = { ...bound, workspace: buildWorkspaceRef(params) };
      try {
        return await client.request(
          zcodeProtocolMethods.mcpUiSampling,
          wire,
          zcodeMcpUiSamplingResultSchema,
          { timeoutMs: MCP_APPS_SAMPLING_TRANSPORT_TIMEOUT_MS },
        );
      } catch (error) {
        // 超时/通道失败只取消原调用，不能恢复 Agent 并重新发起采样。
        const { request: _request, ...cancelParams } = wire;
        void client
          .request(
            zcodeProtocolMethods.mcpUiCancelSampling,
            cancelParams,
            zcodeMcpUiCancelCallResultSchema,
          )
          .catch(() => undefined);
        throw error;
      }
    },
    async cancelMcpAppSampling(params) {
      const client = await getReadOnlyClient(params, "existing-only");
      const { workspacePath: _path, workspaceIdentity: _identity, ...bound } = params;
      return client.request(
        zcodeProtocolMethods.mcpUiCancelSampling,
        { ...bound, workspace: buildWorkspaceRef(params) },
        zcodeMcpUiCancelCallResultSchema,
      );
    },
    async callMcpToolForUi(params: ZCodeAgentCallMcpToolForUiParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.mcpUiCallTool,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          toolName: params.toolName,
          ...(params.arguments ? { arguments: params.arguments } : {}),
          callId: params.callId,
        },
        zcodeMcpUiCallToolResultSchema,
      );
    },

    async cancelMcpToolCallForUi(params: ZCodeAgentCancelMcpToolCallForUiParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.mcpUiCancelCall,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          callId: params.callId,
        },
        zcodeMcpUiCancelCallResultSchema,
      );
    },

    async readMcpResourceForUi(params: ZCodeAgentReadMcpResourceForUiParams) {
      // 与 callMcpToolForUi 同一进程：归属（pluginId ↔ serverName）、mimeType 白名单与 8 MiB 上限都在 agent 侧 fail closed。
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.mcpUiReadResource,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          uri: params.uri,
        },
        zcodeMcpUiReadResourceResultSchema,
      );
    },

    async listMcpResourcesForUi(params: ZCodeAgentListMcpResourcesForUiParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.mcpUiListResources,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          ...(params.cursor ? { cursor: params.cursor } : {}),
        },
        zcodeMcpUiListResourcesResultSchema,
      );
    },

    async listMcpResourceTemplatesForUi(params: ZCodeAgentListMcpResourcesForUiParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.mcpUiListResourceTemplates,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          ...(params.cursor ? { cursor: params.cursor } : {}),
        },
        zcodeMcpUiListResourceTemplatesResultSchema,
      );
    },

    async subscribeMcpResourceForUi(params: ZCodeAgentMcpResourceSubscriptionForUiParams) {
      // 订阅登记在 agent 侧（按 server / uri 引用计数并随重连重放）；host 只转发身份三元组。
      const client = await getReadOnlyClient(params);
      await client.request(
        zcodeProtocolMethods.mcpUiSubscribeResource,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          scopeId: params.scopeId,
          generation: params.generation,
          uri: params.uri,
        },
        zcodeMcpUiResourceSubscriptionResultSchema,
      );
    },

    async unsubscribeMcpResourceForUi(params: ZCodeAgentMcpResourceSubscriptionForUiParams) {
      const client = await getReadOnlyClient(params);
      await client.request(
        zcodeProtocolMethods.mcpUiUnsubscribeResource,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          scopeId: params.scopeId,
          generation: params.generation,
          uri: params.uri,
        },
        zcodeMcpUiResourceSubscriptionResultSchema,
      );
    },

    async registerAppToolsForUi(params: ZCodeAgentRegisterAppToolsForUiParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.mcpUiRegisterAppTools,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          scopeId: params.scopeId,
          generation: params.generation,
          tools: params.tools,
        },
        zcodeMcpUiRegisterAppToolsResultSchema,
      );
    },

    async unregisterAppToolsForUi(params: ZCodeAgentAppToolInstanceForUiParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.mcpUiUnregisterAppTools,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          scopeId: params.scopeId,
          generation: params.generation,
        },
        zcodeMcpUiUnregisterAppToolsResultSchema,
      );
    },

    async claimAppToolCallForUi(params: ZCodeAgentAppToolCallForUiParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.mcpUiClaimAppToolCall,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          scopeId: params.scopeId,
          generation: params.generation,
          callId: params.callId,
        },
        zcodeMcpUiAppToolAcceptedResultSchema,
      );
    },

    async resolveAppToolCallForUi(params: ZCodeAgentResolveAppToolCallForUiParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.mcpUiResolveAppToolCall,
        {
          workspace: buildWorkspaceRef(params),
          sessionId: params.sessionId,
          instance: params.instance,
          pluginId: params.pluginId,
          serverName: params.serverName,
          scopeId: params.scopeId,
          generation: params.generation,
          callId: params.callId,
          ...(params.result ? { result: params.result } : {}),
          ...(params.error ? { error: params.error } : {}),
        },
        zcodeMcpUiAppToolAcceptedResultSchema,
      );
    },

    async listPluginUiSurfaces(params: ZCodeAgentWorkspaceTarget) {
      // 面板只在已有会话时可打开，此时 workspace agent 必然存在；走 read-only client 读它解析好的清单，
      // 不用独立插件管理进程（那边没有本 workspace 的启停状态上下文，与 mcp/readResource 同理）。
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.pluginsListUiSurfaces,
        { workspace: buildWorkspaceRef(params) },
        zcodePluginsListUiSurfacesResultSchema,
      );
    },

    // 已保存工作流的 GUI 中枢：与 Skill catalog 同一条
    // workspace agent client 路径；文件在 workspace 里，远程 workspace 就在远端进程里扫。
    // 全局档：载体由 resolveSavedWorkflowCarrier 选，
    // `scope` 只在有定义时下推。
    async listSavedWorkflows(params: ZCodeAgentListSavedWorkflowsParams) {
      const { client, workspace } = await resolveSavedWorkflowCarrier(params);
      return client.request(
        zcodeProtocolMethods.workflowsList,
        { workspace, ...savedWorkflowScopeParam(params) },
        zcodeWorkflowsListResultSchema,
      );
    },

    async getSavedWorkflow(params: ZCodeAgentGetSavedWorkflowParams) {
      const { client, workspace } = await resolveSavedWorkflowCarrier(params);
      return client.request(
        zcodeProtocolMethods.workflowsGet,
        { workspace, name: params.name, ...savedWorkflowScopeParam(params) },
        zcodeWorkflowsGetResultSchema,
      );
    },

    async updateSavedWorkflowMeta(params: ZCodeAgentUpdateSavedWorkflowMetaParams) {
      const { client, workspace } = await resolveSavedWorkflowCarrier(params);
      return client.request(
        zcodeProtocolMethods.workflowsUpdateMeta,
        {
          workspace,
          name: params.name,
          meta: params.meta,
          ...savedWorkflowScopeParam(params),
        },
        zcodeWorkflowsUpdateMetaResultSchema,
      );
    },

    async deleteSavedWorkflow(params: ZCodeAgentDeleteSavedWorkflowParams) {
      const { client, workspace } = await resolveSavedWorkflowCarrier(params);
      return client.request(
        zcodeProtocolMethods.workflowsDelete,
        { workspace, name: params.name, ...savedWorkflowScopeParam(params) },
        zcodeWorkflowsDeleteResultSchema,
      );
    },

    async listSavedWorkflowRuns(params: ZCodeAgentListSavedWorkflowRunsParams) {
      const { client, workspace } = await resolveSavedWorkflowCarrier(params);
      return client.request(
        zcodeProtocolMethods.workflowsRuns,
        {
          workspace,
          ...(params.name === undefined ? {} : { name: params.name }),
          limit: params.limit,
          ...savedWorkflowScopeParam(params),
        },
        zcodeWorkflowsRunsResultSchema,
      );
    },

    // 把全局档搬回项目档（只此一向）：
    // `workspace` 必带，既是载体又是目标项目（协议处理器据它算项目根），因此走
    // getReadOnlyClient(params) 直通，不经全局载体选择。
    async moveSavedWorkflow(params: ZCodeAgentMoveSavedWorkflowParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.workflowsMove,
        { workspace: buildWorkspaceRef(params), name: params.name },
        zcodeWorkflowsMoveResultSchema,
      );
    },

    // 完成卡的「直接保存」（docs/dynamic-workflow/transcript-and-notifications.md）：必须打到
    // **这次 run 所属 workspace** 的 agent client——脚本从那个进程的 journal 里读，全局档也一样
    // （落点由 agent 按 scope 算，与载体无关）。因此走 getReadOnlyClient 直通，不经全局载体选择。
    async saveSavedWorkflowFromRun(params: ZCodeAgentSaveSavedWorkflowFromRunParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.workflowsSave,
        {
          workspace: buildWorkspaceRef(params),
          runId: params.runId,
          name: params.name,
          meta: params.meta,
          ...(params.scope === undefined ? {} : { scope: params.scope }),
          ...(params.overwrite === undefined ? {} : { overwrite: params.overwrite }),
        },
        zcodeWorkflowsSaveResultSchema,
      );
    },

    async findSavedWorkflowForRun(params: ZCodeAgentFindSavedWorkflowForRunParams) {
      const client = await getReadOnlyClient(params);
      return client.request(
        zcodeProtocolMethods.workflowsForRun,
        {
          workspace: buildWorkspaceRef(params),
          runId: params.runId,
          ...(params.candidates === undefined ? {} : { candidates: [...params.candidates] }),
        },
        zcodeWorkflowsForRunResultSchema,
      );
    },

    async resolveSuggestedPluginReference(params: ZCodeAgentResolveSuggestedPluginReferenceParams) {
      const client = await getPluginManagementClient();
      return client.request(
        zcodeProtocolMethods.pluginsResolveSuggestedReference,
        {
          workspace: buildWorkspaceRef(params),
          stableId: params.stableId,
          operationId: params.operationId,
          clientMode: params.clientMode,
          deliveryKind: params.deliveryKind,
        },
        zcodePluginsResolveSuggestedReferenceResultSchema,
        { timeoutMs: PLUGIN_MANAGEMENT_REQUEST_TIMEOUT_MS },
      );
    },

    onDynamicPluginOperationProgress(operationId: string) {
      return getPluginOperationProgressEmitter(operationId).event;
    },

    async collectLocalRuntimeChildProcesses(signal?: AbortSignal) {
      const managed = [processManager, pluginProcessManager, mcpStatusProcessManager]
        .flatMap((manager) => manager.listManagedProcesses())
        .filter(
          (runtime) => !runtime.client.isDisposed && !runtime.client.storageStartup.isWaiting,
        );
      return Promise.all(
        managed.map(async (runtime) => {
          let children: ZCodeProcessChildProcess[] = [];
          try {
            const result = await runtime.client.request(
              zcodeProtocolMethods.processChildProcesses,
              {},
              zcodeProcessChildProcessesResultSchema,
              {
                timeoutMs: CHILD_PROCESSES_REQUEST_TIMEOUT_MS,
                lifecycle: "observation",
                signal,
              },
            );
            children = result.processes;
          } catch {
            // 旧 CLI 不认识该方法或 runtime 正忙：本轮该 Agent 的后代全部归 cli，不影响其它 runtime。
          }
          return {
            pid: runtime.pid,
            provider: ZCODE_AGENT_PROVIDER,
            workspacePath: runtime.workspacePath,
            ...(runtime.lane ? { lane: runtime.lane } : {}),
            children,
          };
        }),
      );
    },
  };
}
