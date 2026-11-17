import type { ZCodeAgentServiceAccountHelpers } from "./zcodeAgentServiceAccountHelpers.js";
import type { ZCodeAgentServiceRequestHandlersA } from "./zcodeAgentServiceRequestHandlersA.js";
import type { ZCodeAgentServiceRequestHandlersB } from "./zcodeAgentServiceRequestHandlersB.js";
import type { ZCodeAgentServiceRequestHandlersC } from "./zcodeAgentServiceRequestHandlersC.js";
import type { ZCodeAgentServiceSessionHelpers } from "./zcodeAgentServiceSessionHelpers.js";
import type { ZCodeAgentServiceState } from "./zcodeAgentServiceState.js";
import type { ZCodeAgentWorkspaceTarget } from "./zcodeAgent.js";
import type { ZCodeProtocolClient } from "./zcodeProtocolClient.js";
import {
  V4_NOTIFICATIONS,
  conversationTelemetryFactSchema,
  conversationTopicWireCandidateSchema,
  cuaPermissionObservationSchema,
  sessionsIndexTopicWireCandidateSchema,
  workspaceConfigTopicWireCandidateSchema,
} from "@zcode/shared/zcode-protocol-v4";
import {
  isRemoteWorkspaceIdentity,
  localTtftFactsSchema,
  offPeakLifecycleNotificationSchema,
  resolveWorkspaceKey,
  type ProcessResourceCliLane,
  zcodeComputerUseOperationEventSchema,
  zcodeMcpResourceSamplesSchema,
  zcodeMcpTelemetryEventSchema,
  zcodePluginOperationProgressNotificationSchema,
  zcodeProcessResourceSampleSchema,
  zcodeProtocolMethods,
  zcodeProtocolNotifications,
  zcodeProviderRuntimeHeadersCancelledSchema,
  zcodeSessionEventSchema,
  zcodeStateUpdatedNotificationSchema,
  zcodeToolExecResourceSchema,
  zcodeTopicResourceCancelParamsSchema,
} from "@zcode/shared";
import { createTopicResourceBridge } from "./topicResourceBridge.js";
import { logger } from "./zcodeAgentServiceSupport.js";
import { pluginUiToolResultNotificationSchema } from "@zcode/shared/mcp-apps";
import { providerRuntimeHeadersRequestKey } from "./zcodeAgentServiceParams.js";
import { uploadTopicResourceToClient } from "./topicResourceUpload.js";

export function createWireClientHelpers(
  ctx: ZCodeAgentServiceState &
    ZCodeAgentServiceSessionHelpers &
    ZCodeAgentServiceAccountHelpers &
    ZCodeAgentServiceRequestHandlersA &
    ZCodeAgentServiceRequestHandlersB &
    ZCodeAgentServiceRequestHandlersC,
) {
  const {
    activeClientsByWorkspaceKey,
    cancelProviderRuntimeHeaders,
    clientDisposables,
    cuaOperationTurnTracker,
    cuaPermissionObservationEmitter,
    getConversationFrameEmitter,
    getConversationTelemetryFactEmitter,
    getOffPeakLifecycleEmitter,
    getSessionsIndexFrameEmitter,
    getWorkspaceConfigFrameEmitter,
    handleAutomationCheckTaskBindingRequest,
    handleAutomationCreateRequest,
    handleAutomationDeleteRequest,
    handleAutomationListRequest,
    handleAutomationUpdateRequest,
    handleChannelReplyRequest,
    handleCodeIndexNotifyMutatedRequest,
    handleCodeIndexQueryRequest,
    handleInteractionBrowserExecuteRequest,
    handleInteractionBrowserListRequest,
    handleInteractionRequestOfficialMcpAuthHeadersRequest,
    handleInteractionRequestOpenCodeAgentRunRequest,
    handleInteractionRequestPermissionRequest,
    handleInteractionRequestProviderRuntimeHeadersRequest,
    handleInteractionRequestUserInputRequest,
    handleOffPeakCreateRequest,
    handleOffPeakListRequest,
    handleSessionEvent,
    handleSessionRequestRuntimePreferencesRequest,
    handleStateUpdated,
    handleSubagentsReadRuntimeConfigRequest,
    invalidateWorkspaceClient,
    localTtftFactsEmitter,
    mcpResourceSamplesEmitter,
    mcpTelemetryEmitter,
    options,
    pendingProviderRuntimeHeaders,
    pluginOperationProgressEmitters,
    pluginUiToolResultEmitter,
    processResourceSampleEmitter,
    toolExecResourceEmitter,
    v4ConnectionId,
    wiredClients,
  } = ctx;
  function wireClient(
    client: ZCodeProtocolClient,
    workspace: ZCodeAgentWorkspaceTarget,
    /**
     * 该 client 所属的进程泳道。CLI 进程不知道自己被哪个进程管理器拉起，
     * 因此资源样本的 lane 只能在这里按调用方补齐。
     */
    lane: ProcessResourceCliLane,
  ): void {
    if (wiredClients.has(client)) {
      return;
    }
    wiredClients.add(client);
    const topicResources = createTopicResourceBridge(() => {
      // 预热可能没有 remoteSessionId；不能永久捕获 wireClient 首次参数。
      // 从同一个实际 CLI 的当前可信入口取路由，并在一次资源操作内保持不变。
      const active = activeClientsByWorkspaceKey.get(resolveWorkspaceKey(workspace));
      const resourceWorkspace =
        active?.client === client ? { ...active.workspace } : { ...workspace };
      return {
        validate: (request, signal, trace) => {
          if (!options?.topicResourceValidator)
            throw new Error("Topic resource authorization is unavailable");
          return options.topicResourceValidator(
            { ...request, ...resourceWorkspace, trace },
            signal,
          );
        },
        read: (request, signal, trace) => {
          if (!options?.topicResourceExecutor)
            throw new Error("Topic attachment retrieval is unavailable on this host");
          return options.topicResourceExecutor({ ...request, ...resourceWorkspace, trace }, signal);
        },
        upload: (request, attachment, signal, trace) =>
          uploadTopicResourceToClient(
            client,
            v4ConnectionId,
            { ...resourceWorkspace, sessionId: request.taskId },
            attachment,
            signal,
            trace,
          ),
      };
    });
    const disposables = [
      topicResources,
      client.onNotification((message) => {
        if (message.method === zcodeProtocolNotifications.providerRuntimeHeadersCancelled) {
          const parsed = zcodeProviderRuntimeHeadersCancelledSchema.safeParse(message.params);
          if (
            !parsed.success ||
            resolveWorkspaceKey(parsed.data.workspace) !== resolveWorkspaceKey(workspace)
          )
            return;
          const key = providerRuntimeHeadersRequestKey({
            ...workspace,
            sessionId: parsed.data.sessionId,
            requestId: parsed.data.requestId,
          });
          const pending = pendingProviderRuntimeHeaders.get(key);
          // 旧 client 或同路径不同 identity 的取消不能删除新 runtime/其他工作区的请求。
          if (pending?.client === client) cancelProviderRuntimeHeaders(key, pending);
          return;
        }
        if (message.method === zcodeProtocolNotifications.processResourceSample) {
          const parsed = zcodeProcessResourceSampleSchema.safeParse(message.params);
          if (parsed.success) {
            processResourceSampleEmitter.fire({ ...parsed.data, lane });
          } else {
            logger.debug(undefined, "丢弃无效 ZCode CLI 资源样本", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                path: issue.path.join("."),
              })),
            });
          }
          return;
        }

        if (message.method === zcodeProtocolNotifications.toolExecResource) {
          const parsed = zcodeToolExecResourceSchema.safeParse(message.params);
          if (parsed.success) toolExecResourceEmitter.fire(parsed.data);
          return;
        }
        if (message.method === zcodeProtocolNotifications.mcpResourceSamples) {
          const parsed = zcodeMcpResourceSamplesSchema.safeParse(message.params);
          if (parsed.success) mcpResourceSamplesEmitter.fire(parsed.data);
          else logger.debug(undefined, "丢弃无效 MCP 资源样本");
          return;
        }

        if (message.method === zcodeProtocolNotifications.mcpTelemetry) {
          const parsed = zcodeMcpTelemetryEventSchema.safeParse(message.params);
          if (parsed.success) {
            mcpTelemetryEmitter.fire(parsed.data);
          } else {
            logger.debug(undefined, "丢弃无效 ZCode CLI MCP 遥测事件", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                path: issue.path.join("."),
              })),
            });
          }
          return;
        }

        if (message.method === zcodeProtocolNotifications.pluginOperationProgress) {
          const parsed = zcodePluginOperationProgressNotificationSchema.safeParse(message.params);
          if (parsed.success) {
            pluginOperationProgressEmitters.get(parsed.data.operationId)?.fire(parsed.data);
          } else {
            logger.warn(undefined, "丢弃无效 ZCode Protocol 插件操作进度", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                message: issue.message,
                path: issue.path.join("."),
              })),
            });
          }
          return;
        }

        if (message.method === zcodeProtocolMethods.computerUseOperationEvent) {
          const parsed = zcodeComputerUseOperationEventSchema.safeParse(message.params);
          if (parsed.success) {
            // v4 会话不会投影 legacy session/event，CUA 提示必须直接消费 runtime sideband，
            // 避免把两条独立事件流的 sequenceNumber/seq 混为同一顺序域。
            cuaOperationTurnTracker?.accept(workspace, parsed.data);
          } else {
            logger.warn(undefined, "丢弃无效 ZCode Protocol Computer Use operation event", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                message: issue.message,
                path: issue.path.join("."),
              })),
              workspaceKey: resolveWorkspaceKey(workspace),
            });
          }
          return;
        }

        if (message.method === "session/event") {
          const parsed = zcodeSessionEventSchema.safeParse(message.params);
          if (parsed.success) {
            handleSessionEvent(workspace, parsed.data);
          } else {
            const rawParams =
              typeof message.params === "object" && message.params !== null
                ? (message.params as Record<string, unknown>)
                : {};
            logger.warn(
              typeof rawParams.traceId === "string" ? rawParams.traceId : undefined,
              "丢弃无效 ZCode Protocol session event",
              {
                eventId: rawParams.eventId,
                issues: parsed.error.issues.map((issue) => ({
                  code: issue.code,
                  message: issue.message,
                  path: issue.path.join("."),
                })),
                sessionId: rawParams.sessionId,
                type: rawParams.type,
              },
            );
          }
          return;
        }

        if (message.method === "state.updated") {
          const parsed = zcodeStateUpdatedNotificationSchema.safeParse(message.params);
          if (parsed.success) {
            handleStateUpdated(workspace, parsed.data);
          }
          return;
        }

        if (message.method === V4_NOTIFICATIONS.localTtftFacts) {
          const parsed = localTtftFactsSchema.safeParse(message.params);
          if (parsed.success && !workspace.remoteSessionId && !workspace.workspaceIdentity?.trim())
            localTtftFactsEmitter.fire({
              workspaceKey: resolveWorkspaceKey(workspace),
              facts: parsed.data,
            });
          return;
        }
        if (message.method === V4_NOTIFICATIONS.conversationTelemetryFact) {
          const parsed = conversationTelemetryFactSchema.safeParse(message.params);
          if (parsed.success) {
            getConversationTelemetryFactEmitter(workspace).fire(parsed.data);
          } else {
            // 严格丢弃未知字段，避免 CLI runtime 新字段未经审计穿透到 renderer reporter。
            logger.warn(undefined, "丢弃无效 v4 conversation telemetry fact", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                message: issue.message,
                path: issue.path.join("."),
              })),
              workspaceKey: resolveWorkspaceKey(workspace),
            });
          }
          return;
        }
        if (message.method === V4_NOTIFICATIONS.offPeakLifecycle) {
          const parsed = offPeakLifecycleNotificationSchema.safeParse(message.params);
          if (parsed.success) getOffPeakLifecycleEmitter(workspace).fire(parsed.data);
          else
            logger.warn(undefined, "丢弃无效闲时生命周期通知", {
              workspaceKey: resolveWorkspaceKey(workspace),
            });
          return;
        }

        if (message.method === V4_NOTIFICATIONS.pluginUiToolResult) {
          const parsed = pluginUiToolResultNotificationSchema.safeParse(message.params);
          // 只接受当前本地 runtime；旧进程迟到结果和远程客户端不能在本窗口创建 UI。
          if (
            parsed.success &&
            !workspace.remoteSessionId &&
            !isRemoteWorkspaceIdentity(workspace.workspaceIdentity ?? "") &&
            activeClientsByWorkspaceKey.get(resolveWorkspaceKey(workspace))?.client === client
          ) {
            pluginUiToolResultEmitter.fire({
              ...parsed.data,
              workspacePath: workspace.workspacePath,
              ...(workspace.workspaceIdentity
                ? { workspaceIdentity: workspace.workspaceIdentity }
                : {}),
            });
          }
          return;
        }
        if (message.method === V4_NOTIFICATIONS.cuaPermissionObservation) {
          const parsed = cuaPermissionObservationSchema.safeParse(message.params);
          if (
            parsed.success &&
            !workspace.remoteSessionId &&
            !(workspace.workspaceIdentity && isRemoteWorkspaceIdentity(workspace.workspaceIdentity))
          ) {
            cuaPermissionObservationEmitter.fire({
              ...parsed.data,
              workspacePath: workspace.workspacePath,
              ...(workspace.workspaceIdentity
                ? { workspaceIdentity: workspace.workspaceIdentity }
                : {}),
            });
          } else if (!parsed.success) {
            // 原因：权限观察会触发 renderer 副作用，未知字段必须 fail closed，不能宽松透传。
            logger.warn(undefined, "丢弃无效 v4 CUA 权限观察", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                message: issue.message,
                path: issue.path.join("."),
              })),
              workspaceKey: resolveWorkspaceKey(workspace),
            });
          }
          return;
        }

        if (message.method === V4_NOTIFICATIONS.conversationFrame) {
          // 同一通知也载 sessions-index 帧，按 topic 前缀分流到列表 emitter
          // （否则会被 conversation schema 校验丢弃）。
          const topic = (message.params as { topic?: unknown } | null)?.topic;
          if (typeof topic === "string" && topic.startsWith("sessions-index/")) {
            const indexParsed = sessionsIndexTopicWireCandidateSchema.safeParse(message.params);
            if (indexParsed.success) {
              getSessionsIndexFrameEmitter(workspace).fire(indexParsed.data);
            } else {
              logger.warn(undefined, "丢弃无效 v4 sessions-index frame", {
                issues: indexParsed.error.issues.map((issue) => ({
                  code: issue.code,
                  message: issue.message,
                  path: issue.path.join("."),
                })),
                workspaceKey: resolveWorkspaceKey(workspace),
              });
            }
            return;
          }
          if (typeof topic === "string" && topic.startsWith("workspace-config/")) {
            const configParsed = workspaceConfigTopicWireCandidateSchema.safeParse(message.params);
            if (configParsed.success) {
              getWorkspaceConfigFrameEmitter(workspace).fire(configParsed.data);
            } else {
              logger.warn(undefined, "丢弃无效 v4 workspace-config frame", {
                issues: configParsed.error.issues.map((issue) => ({
                  code: issue.code,
                  message: issue.message,
                  path: issue.path.join("."),
                })),
                workspaceKey: resolveWorkspaceKey(workspace),
              });
            }
            return;
          }
          const parsed = conversationTopicWireCandidateSchema.safeParse(message.params);
          if (parsed.success) {
            getConversationFrameEmitter(workspace).fire(parsed.data);
          } else {
            logger.warn(undefined, "丢弃无效 v4 conversation frame", {
              issues: parsed.error.issues.map((issue) => ({
                code: issue.code,
                message: issue.message,
                path: issue.path.join("."),
              })),
              workspaceKey: resolveWorkspaceKey(workspace),
            });
          }
          return;
        }
      }),
      client.onRequest((request) => {
        if (request.method === zcodeProtocolMethods.interactionRequestOpenCodeAgentRun) {
          handleInteractionRequestOpenCodeAgentRunRequest(client, workspace, request);
          return;
        }
        if (request.method === zcodeProtocolMethods.codeIndexQuery) {
          handleCodeIndexQueryRequest(client, workspace, request);
          return;
        }
        if (request.method === zcodeProtocolMethods.codeIndexNotifyMutated) {
          handleCodeIndexNotifyMutatedRequest(client, workspace, request);
          return;
        }
        if (request.method === zcodeProtocolMethods.subagentsReadRuntimeConfig) {
          handleSubagentsReadRuntimeConfigRequest(client, workspace, request);
          return;
        }
        if (request.method === zcodeProtocolMethods.channelReply) {
          handleChannelReplyRequest(client, workspace, request);
          return;
        }
        if (request.method === zcodeProtocolMethods.topicResourceRead) {
          void topicResources
            .read(request.params, request.trace)
            .then((result) => client.respond(request.id, result))
            .catch((error: unknown) =>
              client.respondError(request.id, {
                code: -32603,
                message: error instanceof Error ? error.message : "Topic resource read failed",
              }),
            );
          return;
        }
        if (request.method === zcodeProtocolMethods.topicResourceCancel) {
          const parsed = zcodeTopicResourceCancelParamsSchema.safeParse(request.params);
          void client.respond(request.id, {
            cancelled: parsed.success && topicResources.cancel(parsed.data),
          });
          return;
        }
        if (request.method === zcodeProtocolMethods.sessionRequestRuntimePreferences) {
          handleSessionRequestRuntimePreferencesRequest(client, workspace, request);
          return;
        }
        if (request.method === zcodeProtocolMethods.interactionRequestPermission) {
          handleInteractionRequestPermissionRequest(client, workspace, request);
          return;
        }
        if (request.method === zcodeProtocolMethods.interactionRequestUserInput) {
          handleInteractionRequestUserInputRequest(client, workspace, request);
          return;
        }
        if (request.method === zcodeProtocolMethods.interactionRequestProviderRuntimeHeaders) {
          handleInteractionRequestProviderRuntimeHeadersRequest(client, workspace, request);
          return;
        }
        if (request.method === zcodeProtocolMethods.interactionRequestOfficialMcpAuthHeaders) {
          handleInteractionRequestOfficialMcpAuthHeadersRequest(client, workspace, request);
          return;
        }
        if (request.method === zcodeProtocolMethods.interactionBrowserList) {
          handleInteractionBrowserListRequest(client, workspace, request);
          return;
        }
        if (request.method === zcodeProtocolMethods.interactionBrowserExecute) {
          handleInteractionBrowserExecuteRequest(client, workspace, request);
          return;
        }
        if (request.method === zcodeProtocolMethods.automationCreate) {
          handleAutomationCreateRequest(client, workspace, request);
          return;
        }
        if (request.method === zcodeProtocolMethods.offPeakCreate) {
          handleOffPeakCreateRequest(client, workspace, request);
          return;
        }
        if (request.method === zcodeProtocolMethods.offPeakList) {
          handleOffPeakListRequest(client, workspace, request);
          return;
        }
        if (request.method === zcodeProtocolMethods.automationList) {
          handleAutomationListRequest(client, workspace, request);
          return;
        }
        if (request.method === zcodeProtocolMethods.automationCheckTaskBinding) {
          handleAutomationCheckTaskBindingRequest(client, workspace, request);
          return;
        }
        if (request.method === zcodeProtocolMethods.automationUpdate) {
          handleAutomationUpdateRequest(client, workspace, request);
          return;
        }
        if (request.method === zcodeProtocolMethods.automationDelete) {
          handleAutomationDeleteRequest(client, workspace, request);
          return;
        }

        void client.respondError(request.id, {
          code: -32601,
          message: `Unsupported ZCode Protocol request: ${request.method}`,
        });
      }),
      client.onClose(() => {
        invalidateWorkspaceClient(resolveWorkspaceKey(workspace), client);
      }),
    ];
    clientDisposables.set(client, disposables);
  }

  return {
    wireClient,
  };
}

export type ZCodeAgentServiceWireHelpers = ReturnType<typeof createWireClientHelpers>;
