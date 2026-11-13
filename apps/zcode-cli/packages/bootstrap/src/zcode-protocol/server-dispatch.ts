import {
  offPeakControlParamsSchema,
  offPeakControlResultSchema,
  zcodeProtocolMethods,
  zcodeWorkspaceHookTrustGrantParamsSchema,
  type ZCodeProtocolRequest,
  type ZCodeProtocolRequestId,
} from "@zcode/shared";
import {
  V4_METHODS,
  V4_NOTIFICATIONS,
  parseSessionsIndexTopic,
  parseWorkspaceConfigTopic,
} from "@zcode/shared/zcode-protocol-v4";
import {
  ProtocolRequestError,
  type ZCodeProtocolAgentServerContext,
  type ZCodeProtocolPostResponseBatch,
} from "./server-types.js";
import {
  cancelBackgroundTask,
  closeSession,
  compactSession,
  createSession,
  forkSession,
  generateWorkspaceText,
  goalSession,
  getTaskTokenUsage,
  getUsageStats,
  listSessions,
  listSessionSubagents,
  readEvents,
  readMessages,
  readSession,
  resumeSession,
  sendPrompt,
  setMode,
  setModel,
  setThoughtLevel,
  stopSession,
  subscribeSession,
} from "./server-operations.js";
import { querySessionDebug } from "./session-debug.js";
import { listChildProcesses } from "./process-child-processes.js";
import {
  readWorkspacePresentation,
  testProviderModelConnectivity,
} from "./workspace-model-runtime.js";
import {
  addPluginMarketplace,
  configurePlugin,
  describePlugin,
  getPluginsOverview,
  installPlugin,
  listPlugins,
  removePluginMarketplace,
  resetPluginConfig,
  restoreBuiltinPlugin,
  setPluginEnabled,
  uninstallPlugin,
  updatePlugin,
  updatePluginMarketplace,
  validatePlugin,
} from "./plugins.js";
import {
  getPluginReferenceCatalog,
  resolveSuggestedPluginReference,
} from "./plugin-reference-catalog.js";
import { getSkillReferenceCatalog } from "./skill-reference-catalog.js";
import {
  deleteSavedWorkflowOp,
  getSavedWorkflowOp,
  listSavedWorkflowRunsOp,
  listSavedWorkflowsOp,
  moveSavedWorkflowOp,
  updateSavedWorkflowMetaOp,
} from "./saved-workflows.js";
import { findSavedWorkflowForRunOp, saveSavedWorkflowFromRunOp } from "./saved-workflows-run.js";
import { connectMcpServer, listMcpServers } from "./mcp.js";
import {
  callMcpUiTool,
  sampleMcpUi,
  cancelMcpUiSampling,
  cancelMcpUiToolCall,
  listMcpUiResourceTemplates,
  listMcpUiResources,
  claimMcpUiAppToolCall,
  registerMcpUiAppTools,
  resolveMcpUiAppToolCall,
  unregisterMcpUiAppTools,
  readMcpUiResource,
  readMcpUiResourceForUi,
  subscribeMcpUiResource,
  unsubscribeMcpUiResource,
} from "./mcp-ui/index.js";
import { closeMcpUiInstance, openMcpUiInstance, validateMcpUiInstance } from "./mcp-ui/index.js";
import { listPluginUiSurfaces } from "./plugin-ui-surfaces.js";
import { updateInteractionPreferences } from "./interaction-preferences.js";
import {
  refreshProviderRegistry,
  updateAccountProviderConfig,
  updateRuntimeProviderCatalog,
} from "./account-provider-config.js";
import { updateModelIoPreferences } from "./model-io-preferences.js";
import { updateOffPeakToolPolicy } from "./off-peak-tool-policy.js";
import { updateDynamicWorkflowPolicy } from "./dynamic-workflow-policy.js";
import {
  grantWorkspaceHookTrustForProtocol,
  notifyWorkspaceHookTrustGrantSessions,
} from "./workspace-hook-trust.js";
import type { ConversationV4Gateway } from "../zcode-protocol-v4/v4-gateway.js";
import {
  cancelPluginOperation,
  cancelWorkspaceGenerateText,
  withPluginOperationSignal,
  withWorkspaceGenerateTextSignal,
  type PluginOperationRegistries,
} from "./server-plugin-ops.js";

/**
 * 方法分派所需的 server 内部状态。dispatch 只读 context 与 outbox，
 * 长操作取消走显式注册表，避免回指 server 实例形成双向依赖。
 */
export interface ProtocolDispatchHost {
  readonly context: ZCodeProtocolAgentServerContext;
  readonly postResponseOutbox: Map<ZCodeProtocolRequestId, ZCodeProtocolPostResponseBatch>;
  readonly operations: PluginOperationRegistries;
  requireV4Gateway(): ConversationV4Gateway;
}

function requireV4Gateway(host: ProtocolDispatchHost) {
  if (!host.context.v4Gateway) {
    throw new ProtocolRequestError(-32603, "v4 gateway is not initialized");
  }
  return host.context.v4Gateway;
}

export async function dispatchProtocolRequest(
  host: ProtocolDispatchHost,
  request: ZCodeProtocolRequest,
): Promise<unknown> {
  switch (request.method) {
    // ── v4 conversation 通道（竖切，与旧 session/* 并存）──
    case V4_METHODS.connectionFlow: {
      requireV4Gateway(host).setConnectionFlowState(request.params);
      return {};
    }
    case V4_METHODS.conversationSubscribe: {
      // 同一 subscribe 方法按 topic 前缀分派：
      // sessions-index/* → 列表订阅；workspace-config/* → 配置目录订阅；否则 conversation。
      const gateway = requireV4Gateway(host);
      const topic = (request.params as { topic?: unknown } | null)?.topic;
      let dispatch;
      if (typeof topic === "string" && parseSessionsIndexTopic(topic) !== null) {
        dispatch = await gateway.subscribeSessionsIndexReserved(request.params);
      } else if (typeof topic === "string" && parseWorkspaceConfigTopic(topic) !== null) {
        dispatch = await gateway.subscribeWorkspaceConfigReserved(request.params);
      } else {
        dispatch = await gateway.subscribeReserved(request.params);
      }
      if (dispatch.initialWires.length > 0) {
        host.postResponseOutbox.set(request.id, {
          messages: dispatch.initialWires.map((wire) => ({
            method: V4_NOTIFICATIONS.conversationFrame,
            params: wire,
          })),
          commit: dispatch.commit,
        });
      }
      return { ack: dispatch.ack };
    }
    case V4_METHODS.conversationResync: {
      // same-sub recovery 与 subscribe 共用确定性 post-response outbox；公共
      // response 仍 strict ACK-only，physical recovery 只能在 ACK line 后发送。
      const dispatch = requireV4Gateway(host).resyncReserved(request.params);
      if (dispatch.initialWires.length > 0) {
        host.postResponseOutbox.set(request.id, {
          messages: dispatch.initialWires.map((wire) => ({
            method: V4_NOTIFICATIONS.conversationFrame,
            params: wire,
          })),
          commit: dispatch.commit,
        });
      }
      return { ack: dispatch.ack };
    }
    case V4_METHODS.conversationUnsubscribe: {
      // topic + subscriptionId + connectionId 精确命中唯一 publisher；禁止按裸
      // subId 对 conversation/sessions-index/workspace-config 广撒网。
      requireV4Gateway(host).unsubscribe(request.params);
      return {};
    }
    // ── 行分页 query（独立分支，便于与帧分派改动合并）──
    case V4_METHODS.conversationRowsRange:
      return await requireV4Gateway(host).rowsRange(request.params);
    case V4_METHODS.conversationPlans:
      return await requireV4Gateway(host).plans(request.params);
    case V4_METHODS.backgroundBashOutput:
      return await requireV4Gateway(host).backgroundBashOutput(request.params);
    case V4_METHODS.offPeakControl: {
      const params = offPeakControlParamsSchema.parse(request.params);
      const record = host.context.sessions.get(params.sessionId);
      // 生命周期只存在于驻留 runtime；换票不能恢复冷会话或重放原始输入。
      return offPeakControlResultSchema.parse(
        record ? await record.app.runtime.controlOffPeakExecution(params) : { accepted: false },
      );
    }
    case V4_METHODS.conversationFileChanges:
      return await requireV4Gateway(host).fileChanges(request.params);
    case V4_METHODS.conversationFileRewindPreview:
      return await requireV4Gateway(host).fileRewindPreview(request.params);
    // workflow run 事件日志分页（只读、无状态、超时重发安全；新方法天然偏斜安全）。
    case V4_METHODS.conversationWorkflowRunEvents:
      return await requireV4Gateway(host).workflowRunEvents(request.params);
    // dwf run 枚举（重启后的发现查询）。
    case V4_METHODS.conversationWorkflowRuns:
      return await requireV4Gateway(host).workflowRuns(request.params);
    // dwf 用户面产物的三个读面。同族：只读、无状态、
    // 超时重发安全；ArtifactRead 的授权在宿主端口侧，网关只校参数与分块。
    case V4_METHODS.conversationWorkflowRunArtifacts:
      return await requireV4Gateway(host).workflowRunArtifacts(request.params);
    case V4_METHODS.conversationWorkflowRunArtifactData:
      return await requireV4Gateway(host).workflowRunArtifactData(request.params);
    case V4_METHODS.conversationWorkflowRunArtifactRead:
      return await requireV4Gateway(host).workflowRunArtifactRead(request.params);
    // dwf 工作区 transcript 的两个读面。同族。
    case V4_METHODS.conversationWorkflowRunWorkspace:
      return await requireV4Gateway(host).workflowRunWorkspace(request.params);
    case V4_METHODS.conversationWorkflowRunNodeResult:
      return await requireV4Gateway(host).workflowRunNodeResult(request.params);
    // 附件只能走小 RPC transaction，禁止 full-data attachment/put 单行。
    case V4_METHODS.attachmentBegin:
      return await requireV4Gateway(host).attachmentBegin(request.params);
    case V4_METHODS.attachmentChunk:
      return await requireV4Gateway(host).attachmentChunk(request.params);
    case V4_METHODS.attachmentCommit:
      return await requireV4Gateway(host).attachmentCommit(request.params);
    case V4_METHODS.attachmentAbort:
      await requireV4Gateway(host).attachmentAbort(request.params);
      return {};
    case V4_METHODS.attachmentRead:
      return await requireV4Gateway(host).attachmentRead(request.params);
    case V4_METHODS.conversationAttachmentRead:
      return await requireV4Gateway(host).conversationAttachmentRead(request.params);
    case V4_METHODS.conversationAttachmentStat:
      return await requireV4Gateway(host).conversationAttachmentStat(request.params);
    case V4_METHODS.attachmentPreviewSource:
      return await requireV4Gateway(host).attachmentPreviewSource(request.params);
    // ── usage query（additive）：与旧 usage/stats、session/usage 同一数据访问
    // 层（usage store 聚合），仅换 v4 名字空间——不经 v4Gateway（无会话投影依赖），
    // 也不经旧 op 分派（无桥）。旧 case 保留到旧词删除（老 host 版本兼容）。──
    case V4_METHODS.usageStats:
      return await getUsageStats(host.context, request.params);
    case V4_METHODS.conversationUsage:
      return await getTaskTokenUsage(host.context, request.params);
    case V4_METHODS.command:
      return requireV4Gateway(host).handleCommand(request.params);
    case V4_METHODS.commandsQuery:
      return requireV4Gateway(host).queryCommands(request.params);
    case V4_METHODS.sessionsIndexReconcile:
      return requireV4Gateway(host).reconcileSessions(request.params);
    case zcodeProtocolMethods.sessionCreate:
      return await createSession(host.context, request.params, request.trace);
    case zcodeProtocolMethods.sessionResume:
      return await resumeSession(host.context, request.params);
    case zcodeProtocolMethods.sessionList:
      return await listSessions(host.context, request.params);
    case zcodeProtocolMethods.sessionSubagents:
      return await listSessionSubagents(host.context, request.params);
    case zcodeProtocolMethods.sessionRead:
      return await readSession(host.context, request.params);
    case zcodeProtocolMethods.sessionMessages:
      return await readMessages(host.context, request.params);
    case zcodeProtocolMethods.sessionEvents:
      return await readEvents(host.context, request.params);
    case zcodeProtocolMethods.sessionSubscribe:
      return await subscribeSession(host.context, request.params);
    case zcodeProtocolMethods.sessionSend:
      return await sendPrompt(host.context, request.params);
    case zcodeProtocolMethods.sessionStop:
      return await stopSession(host.context, request.params);
    case zcodeProtocolMethods.sessionCancelBackgroundTask:
      return await cancelBackgroundTask(host.context, request.params);
    case zcodeProtocolMethods.sessionFork:
      return await forkSession(host.context, request.params);
    case zcodeProtocolMethods.sessionCompact:
      return await compactSession(host.context, request.params);
    case zcodeProtocolMethods.sessionGoal:
      return await goalSession(host.context, request.params);
    case zcodeProtocolMethods.sessionSetModel:
      return await setModel(host.context, request.params);
    case zcodeProtocolMethods.sessionSetThoughtLevel:
      return await setThoughtLevel(host.context, request.params);
    case zcodeProtocolMethods.sessionSetMode:
      return await setMode(host.context, request.params);
    case zcodeProtocolMethods.sessionClose:
      return await closeSession(host.context, request.params);
    case zcodeProtocolMethods.workspaceReadPresentation:
      return await readWorkspacePresentation(host.context, request.params);
    case zcodeProtocolMethods.workspaceHookTrustGrant: {
      const grantResult = await grantWorkspaceHookTrustForProtocol(request.params, {
        appVersion: host.context.deps.version,
        policyProvider: host.context.deps.workspaceHookPolicyProvider,
      });
      if (grantResult.accepted) {
        await notifyWorkspaceHookTrustGrantSessions({
          // dispatch 层的 params 是弱类型；grant 内部已用同一 schema parse 过，这里
          // safeParse 只为取出 workspaceKey 做匹配，失败即跳过通知（防御，正常必成功）。
          grantedWorkspaceKey: zcodeWorkspaceHookTrustGrantParamsSchema.safeParse(request.params)
            .success
            ? zcodeWorkspaceHookTrustGrantParamsSchema.parse(request.params).workspace
                .workspaceKey
            : undefined,
          sessions: host.context.sessions,
        });
      }
      return grantResult;
    }
    case zcodeProtocolMethods.providerUpdateAccountConfig:
      return await updateAccountProviderConfig(host.context, request.params);
    case zcodeProtocolMethods.providerUpdateRuntimeCatalog:
      return await updateRuntimeProviderCatalog(host.context, request.params);
    case zcodeProtocolMethods.providerRefreshRegistry:
      return await refreshProviderRegistry(host.context, request.params);
    case zcodeProtocolMethods.workspaceUpdateInteractionPreferences:
      return await updateInteractionPreferences(host.context, request.params);
    case zcodeProtocolMethods.workspaceUpdateModelIoPreferences:
      return await updateModelIoPreferences(host.context, request.params);
    case zcodeProtocolMethods.workspaceUpdateOffPeakToolPolicy:
      return await updateOffPeakToolPolicy(host.context, request.params);
    case zcodeProtocolMethods.workspaceUpdateDynamicWorkflowPolicy:
      return await updateDynamicWorkflowPolicy(host.context, request.params);
    case zcodeProtocolMethods.workspaceGenerateText:
      return await withWorkspaceGenerateTextSignal(host.operations, request, (signal) =>
        generateWorkspaceText(host.context, request.params, signal),
      );
    case zcodeProtocolMethods.workspaceCancelGenerateText:
      return cancelWorkspaceGenerateText(host.operations, request.params);
    case zcodeProtocolMethods.providerTestModelConnectivity:
      return await testProviderModelConnectivity(host.context, request.params);
    case zcodeProtocolMethods.mcpList:
      return await listMcpServers(host.context, request.params);
    case zcodeProtocolMethods.mcpConnect:
      return await connectMcpServer(host.context, request.params);
    case zcodeProtocolMethods.mcpReadResource:
      return await readMcpUiResource(host.context, request.params);
    case zcodeProtocolMethods.mcpUiOpenInstance:
      return openMcpUiInstance(host.context, request.params);
    case zcodeProtocolMethods.mcpUiValidateInstance:
      return validateMcpUiInstance(host.context, request.params);
    case zcodeProtocolMethods.mcpUiCloseInstance:
      return closeMcpUiInstance(host.context, request.params);
    case zcodeProtocolMethods.mcpUiSampling:
      return sampleMcpUi(host.context, request.params);
    case zcodeProtocolMethods.mcpUiCancelSampling:
      return cancelMcpUiSampling(host.context, request.params);
    case zcodeProtocolMethods.mcpUiCallTool:
      return await callMcpUiTool(host.context, request.params);
    case zcodeProtocolMethods.mcpUiCancelCall:
      return await cancelMcpUiToolCall(host.context, request.params);
    case zcodeProtocolMethods.mcpUiReadResource:
      return await readMcpUiResourceForUi(host.context, request.params);
    case zcodeProtocolMethods.mcpUiListResources:
      return await listMcpUiResources(host.context, request.params);
    case zcodeProtocolMethods.mcpUiListResourceTemplates:
      return await listMcpUiResourceTemplates(host.context, request.params);
    case zcodeProtocolMethods.mcpUiSubscribeResource:
      return await subscribeMcpUiResource(host.context, request.params);
    case zcodeProtocolMethods.mcpUiUnsubscribeResource:
      return await unsubscribeMcpUiResource(host.context, request.params);
    case zcodeProtocolMethods.mcpUiRegisterAppTools:
      return await registerMcpUiAppTools(host.context, request.params);
    case zcodeProtocolMethods.mcpUiUnregisterAppTools:
      return await unregisterMcpUiAppTools(host.context, request.params);
    case zcodeProtocolMethods.mcpUiClaimAppToolCall:
      return await claimMcpUiAppToolCall(host.context, request.params);
    case zcodeProtocolMethods.mcpUiResolveAppToolCall:
      return await resolveMcpUiAppToolCall(host.context, request.params);
    case zcodeProtocolMethods.pluginsList:
      return await listPlugins(host.context, request.params);
    case zcodeProtocolMethods.pluginsReferenceCatalogWithCategory:
      return await getPluginReferenceCatalog(host.context, request.params, true);
    case zcodeProtocolMethods.pluginsReferenceCatalog:
      return await getPluginReferenceCatalog(host.context, request.params);
    case zcodeProtocolMethods.pluginsListUiSurfaces:
      return await listPluginUiSurfaces(host.context, request.params);
    case zcodeProtocolMethods.skillsReferenceCatalog:
      return await getSkillReferenceCatalog(host.context, request.params);
    case zcodeProtocolMethods.workflowsList:
      return await listSavedWorkflowsOp(host.context, request.params);
    case zcodeProtocolMethods.workflowsGet:
      return await getSavedWorkflowOp(host.context, request.params);
    case zcodeProtocolMethods.workflowsUpdateMeta:
      return await updateSavedWorkflowMetaOp(host.context, request.params);
    case zcodeProtocolMethods.workflowsDelete:
      return await deleteSavedWorkflowOp(host.context, request.params);
    case zcodeProtocolMethods.workflowsRuns:
      return await listSavedWorkflowRunsOp(host.context, request.params);
    case zcodeProtocolMethods.workflowsMove:
      return await moveSavedWorkflowOp(host.context, request.params);
    case zcodeProtocolMethods.workflowsSave:
      return await saveSavedWorkflowFromRunOp(host.context, request.params);
    case zcodeProtocolMethods.workflowsForRun:
      return await findSavedWorkflowForRunOp(host.context, request.params);
    case zcodeProtocolMethods.pluginsResolveSuggestedReference:
      return await withPluginOperationSignal(host.operations, request, (signal) =>
        resolveSuggestedPluginReference(host.context, request.params, signal),
      );
    case zcodeProtocolMethods.pluginsSetEnabled:
      return await withPluginOperationSignal(host.operations, request, (signal) =>
        setPluginEnabled(host.context, request.params, signal),
      );
    case zcodeProtocolMethods.pluginsOverview:
      return await getPluginsOverview(host.context, request.params);
    case zcodeProtocolMethods.processChildProcesses:
      return listChildProcesses(host.context.deps.mcpTelemetry?.listProcesses() ?? []);
    case zcodeProtocolMethods.runtimeCapabilities:
      return { independentPlanState: true, historyFirst: true };
    case zcodeProtocolMethods.pluginsMarketplaceAdd:
      return await withPluginOperationSignal(host.operations, request, (signal) =>
        addPluginMarketplace(host.context, request.params, signal),
      );
    case zcodeProtocolMethods.pluginsMarketplaceRemove:
      return await removePluginMarketplace(host.context, request.params);
    case zcodeProtocolMethods.pluginsMarketplaceUpdate:
      return await withPluginOperationSignal(host.operations, request, (signal) =>
        updatePluginMarketplace(host.context, request.params, signal),
      );
    case zcodeProtocolMethods.pluginsInstall:
      return await withPluginOperationSignal(host.operations, request, (signal) =>
        installPlugin(host.context, request.params, signal),
      );
    case zcodeProtocolMethods.pluginsCancelOperation:
      return cancelPluginOperation(host.operations, request.params);
    case zcodeProtocolMethods.pluginsUninstall:
      return await uninstallPlugin(host.context, request.params);
    case zcodeProtocolMethods.pluginsUpdate:
      return await updatePlugin(host.context, request.params);
    case zcodeProtocolMethods.pluginsRestoreBuiltin:
      return await restoreBuiltinPlugin(host.context, request.params);
    case zcodeProtocolMethods.pluginsConfigure:
      return await configurePlugin(host.context, request.params);
    case zcodeProtocolMethods.pluginsResetConfig:
      return await resetPluginConfig(host.context, request.params);
    case zcodeProtocolMethods.pluginsValidate:
      return await validatePlugin(host.context, request.params);
    case zcodeProtocolMethods.pluginsDescribe:
      return await describePlugin(host.context, request.params);
    case zcodeProtocolMethods.usageStats:
      return await getUsageStats(host.context, request.params);
    case zcodeProtocolMethods.sessionDebug:
      return querySessionDebug(host.context, request.params);
    case zcodeProtocolMethods.sessionUsage:
      return await getTaskTokenUsage(host.context, request.params);
    default:
      throw new ProtocolRequestError(-32601, `Method not found: ${request.method}`);
  }
}
