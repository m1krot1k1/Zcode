import type {
  ActiveWorkspaceClient,
  CreateZCodeAgentServiceOptions,
  HostOpenCodeRun,
  HostOpenCodeRunStatus,
  WaitingWorkspaceStartup,
} from "./zcodeAgentServiceParams.js";
import type {
  ConversationTelemetryFact,
  ConversationTopicWireCandidate,
  SessionsIndexTopicWireCandidate,
  WorkspaceConfigTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  OpenCodeAcpPermissionEvent,
  OpenCodeAcpSessionUpdate,
} from "#src/opencode-acp-runtime/contract.js";
import type {
  ZCodeAgentAppRuntimePreferences,
  ZCodeAgentCuaPermissionObservation,
  ZCodeAgentServiceEvent,
  ZCodeAgentSessionRuntimePreferencesRequest,
  ZCodeAgentWorkspaceTarget,
} from "./zcodeAgent.js";
import type { PluginUiToolResultNotification } from "@zcode/shared/mcp-apps";
import type { ZCodeProtocolClient } from "./zcodeProtocolClient.js";
import {
  MCP_STATUS_LANE_IDLE_TIMEOUT_MS,
  cuaOperationLogger,
  logger,
  type PendingPermissionRequest,
  type PendingProviderRuntimeHeadersRequest,
  type PendingSessionRuntimePreferencesRequest,
  type SessionEventSequenceState,
} from "./zcodeAgentServiceSupport.js";
import {
  createCuaOperationTurnTracker,
  type CuaOperationTurnTracker,
} from "./cuaOperationTurnTracker.js";
import {
  createOfficialMcpIssuanceAudit,
  type OfficialMcpIssuanceAudit,
} from "#src/official-mcp/officialMcpIssuanceAudit.js";
import {
  type AgentLaneResourceSample,
  type DynamicWorkflowClientConfig,
  type DynamicWorkflowMode,
  type LocalTtftFacts,
  type OffPeakLifecycleNotification,
  type TraceId,
  type ZCodeMcpResourceSample,
  type ZCodeMcpTelemetryEvent,
  type ZCodePluginOperationProgressNotification,
  type ZCodeProviderRuntimeHeadersCancelled,
  type ZCodeProviderRuntimeHeadersRequestParams,
  type ZCodeToolExecResource,
  zcodeOpenCodeAgentRunEventSchema,
  zcodeProtocolMethods,
} from "@zcode/shared";
import { AutomationRepo } from "#src/session/automationRepo.js";
import { AutomationService } from "#src/session/automationService.js";
import { Emitter, type IDisposable } from "@zcode/rpc";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import { ZCodeAgentProcessManager } from "./zcodeAgentProcessManager.js";
import { randomUUID } from "node:crypto";
import { registerMemoryDiagnosticsProvider } from "#src/memoryDiagnostics.js";

export interface V4SubscriptionRoute {
  workspaceKey: string;
  topic: string;
  subscriptionId: string;
  connectionId: string;
}

export function createZCodeAgentServiceState(options?: CreateZCodeAgentServiceOptions) {
  const mutable = {
    serviceDisposing: false,
    latestAppRuntimePreferences: undefined as ZCodeAgentAppRuntimePreferences | undefined,
    dynamicWorkflowOffer: undefined as Promise<DynamicWorkflowClientConfig | undefined> | undefined,
    pushedDynamicWorkflowUserMode: undefined as DynamicWorkflowMode | undefined,
    modelSelectionSubscription: undefined as IDisposable | undefined,
    accountProviderConfigUnsubscribe: undefined as (() => void) | undefined,
    runtimeProviderCatalogUnsubscribe: undefined as (() => void) | undefined,
    runtimeLifecycleDisposable: undefined as IDisposable | undefined,
    v4RouteRuntimeRestartDisposable: undefined as IDisposable | undefined,
  };
  const processManager = new ZCodeAgentProcessManager(options);
  // Windows indicator 与 macOS producer lifecycle client 共用已校验、去重的 sideband facts。
  const cuaOperationTurnTracker: CuaOperationTurnTracker | undefined =
    options?.cuaOperationStateReporter || options?.onCuaPipSessionLifecycle
      ? createCuaOperationTurnTracker({
          ...(options?.cuaOperationStateReporter
            ? { reporter: options.cuaOperationStateReporter }
            : {}),
          ...(options?.onCuaPipSessionLifecycle
            ? { onPipSessionLifecycle: options.onCuaPipSessionLifecycle }
            : {}),
          logger: {
            debug: (message) => cuaOperationLogger.debug(undefined, message),
            info: (message) => cuaOperationLogger.info(undefined, message),
            warn: (message) => cuaOperationLogger.warn(undefined, message),
          },
        })
      : undefined;
  // AutomationRepo 也持有 tasks-index.sqlite 连接，disposeAll 需一并收口（见下方 disposeAll 注释）
  const automationRepo = new AutomationRepo();
  const automationService = new AutomationService(automationRepo, options?.prepareProjectExecution);
  const automationTaskIndexRepo = new TaskIndexRepo();
  const pluginProcessManager = new ZCodeAgentProcessManager({
    commandResolver: options?.commandResolver,
    presentationSurface: options?.presentationSurface,
    requestTimeoutMs: options?.requestTimeoutMs,
    resolveSpawnEnv: options?.resolveSpawnEnv,
    waitForSpawnAdmission: options?.waitForSpawnAdmission,
  });
  // 合并时误删了独立进程：mcp/list 的慢握手会堵住串行 stdio 队列，连带卡住插件卸载。
  // 恢复专用控制面进程及空闲回收；共享 workspace 路径，不共享请求队列或 watchdog。
  const mcpStatusProcessManager = new ZCodeAgentProcessManager({
    commandResolver: options?.commandResolver,
    presentationSurface: options?.presentationSurface,
    processLifecycleReporter: options?.processLifecycleReporter,
    requestTimeoutMs: options?.requestTimeoutMs,
    resolveSpawnEnv: options?.resolveSpawnEnv,
    waitForSpawnAdmission: options?.waitForSpawnAdmission,
    lane: "mcp-status",
    idleTimeoutMs: options?.mcpStatusIdleTimeoutMs ?? MCP_STATUS_LANE_IDLE_TIMEOUT_MS,
  });
  const sessionEmitters = new Map<string, Emitter<ZCodeAgentServiceEvent>>();
  /**
   * 已经记过"首次发放官方身份头"审计日志的 (pluginId, mcpKey, workspaceKey)。
   *
   * 存在理由：成功路径不能只记 debug——生产构建的最低级别是 Info，事后无法回答
   * "凭据被哪个插件取走过"。但每次 initialize / tools\_list / tools\_call 都会触发一次发放，
   * 全量记 info 就是消息量级的日志膨胀。折中：每个三元组只在本进程内首次发放时记一条 info，
   * 之后仍走 debug。审计线索到"哪个插件、哪个 workspace、什么时候第一次拿"这个粒度。
   */
  const officialMcpIssuanceAudit: OfficialMcpIssuanceAudit = createOfficialMcpIssuanceAudit();
  const providerRuntimeHeadersWorkspaceEmitters = new Map<
    string,
    Emitter<ZCodeProviderRuntimeHeadersRequestParams>
  >();
  const providerRuntimeHeadersCancelledEmitters = new Map<
    string,
    Emitter<ZCodeProviderRuntimeHeadersCancelled>
  >();
  const sessionRuntimePreferencesRequestEmitter =
    new Emitter<ZCodeAgentSessionRuntimePreferencesRequest>();
  const processResourceSampleEmitter = new Emitter<AgentLaneResourceSample>();
  const toolExecResourceEmitter = new Emitter<ZCodeToolExecResource>();
  const mcpResourceSamplesEmitter = new Emitter<ZCodeMcpResourceSample[]>();
  const mcpTelemetryEmitter = new Emitter<ZCodeMcpTelemetryEvent>();
  const pluginOperationProgressEmitters = new Map<
    string,
    Emitter<ZCodePluginOperationProgressNotification>
  >();
  // v4 conversation 帧 fan-out：workspace 级 emitter，renderer 侧按 topic 自行路由。
  const conversationFrameEmitters = new Map<string, Emitter<ConversationTopicWireCandidate>>();
  const localTtftFactsEmitter = new Emitter<{
    workspaceKey: string;
    facts: LocalTtftFacts;
  }>();
  const conversationTelemetryFactEmitters = new Map<string, Emitter<ConversationTelemetryFact>>();
  const offPeakLifecycleEmitters = new Map<string, Emitter<OffPeakLifecycleNotification>>();
  const pluginUiToolResultEmitter = new Emitter<
    PluginUiToolResultNotification & ZCodeAgentWorkspaceTarget
  >();
  const cuaPermissionObservationEmitter = new Emitter<ZCodeAgentCuaPermissionObservation>();
  // sessions-index 帧 fan-out：与 conversation 同一 conversationFrame 通知，按 topic 前缀分流到此 emitter。
  const sessionsIndexFrameEmitters = new Map<string, Emitter<SessionsIndexTopicWireCandidate>>();
  // workspace-config 帧 fan-out：配置目录活性（task-index syncer 消费），同一通知按前缀分流。
  const workspaceConfigFrameEmitters = new Map<
    string,
    Emitter<WorkspaceConfigTopicWireCandidate>
  >();
  // v4 订阅替换按 (connectionId, topic) 判定；每个 host process 服务一个
  // renderer 窗口，一个稳定 connectionId 即可让重订阅天然替换旧订阅。
  const v4ConnectionId = `host-${randomUUID()}`;
  const v4SubscriptionRoutes = new Map<string, V4SubscriptionRoute>();
  const v4RouteKeyByOwnership = new Map<string, string>();
  const sessionEventSequenceStates = new Map<string, SessionEventSequenceState>();
  const wiredClients = new WeakSet<ZCodeProtocolClient>();
  const clientDisposables = new WeakMap<ZCodeProtocolClient, IDisposable[]>();
  const pendingPermissions = new Map<string, PendingPermissionRequest>();
  const pendingUserInputs = new Map<string, PendingPermissionRequest>();
  // 内存诊断计数器：只读各 per-session 镜像表的 size。
  const memoryDiagnostics = registerMemoryDiagnosticsProvider("agent", () => ({
    sessionEmitters: sessionEmitters.size,
    seqStates: sessionEventSequenceStates.size,
    sessionTraceIds: sessionTraceIdBySessionKey.size,
    conversationFrameEmitters: conversationFrameEmitters.size,
    pendingPermissions: pendingPermissions.size,
    pendingUserInputs: pendingUserInputs.size,
  }));
  const pendingProviderRuntimeHeaders = new Map<string, PendingProviderRuntimeHeadersRequest>();
  const pendingSessionRuntimePreferences = new Map<
    string,
    PendingSessionRuntimePreferencesRequest
  >();
  const activeClientsByWorkspaceKey = new Map<string, ActiveWorkspaceClient>();
  const openCodeRuns = new Map<string, HostOpenCodeRun>();
  const openCodeRunKey = (workspaceKey: string, sessionId: string, commandId: string) =>
    `${workspaceKey}\u0000${sessionId}\u0000${commandId}`;
  const emitOpenCodeRunEvent = async (
    run: HostOpenCodeRun,
    event: Record<string, unknown>,
  ): Promise<void> => {
    if (!run.opencodeSessionId) return;
    const parsedNotification = zcodeOpenCodeAgentRunEventSchema.safeParse({
      protocolVersion: 1,
      zcodeSessionId: run.zcodeSessionId,
      commandId: run.commandId,
      runId: run.runId,
      opencodeSessionId: run.opencodeSessionId,
      sequence: ++run.eventSequence,
      event,
    });
    if (!parsedNotification.success) {
      logger.warn(undefined, "OpenCode delegated run event was rejected by its protocol schema", {
        event: "zcode_agent.opencode_run.notification_invalid",
        workspaceKey: run.workspaceKey,
        commandId: run.commandId,
        runId: run.runId,
        sequence: run.eventSequence,
      });
      return;
    }
    const notification = parsedNotification.data;
    const previousDelivery = run.eventDelivery;
    run.eventDelivery = previousDelivery
      .then(async () => {
        const activeClient = activeClientsByWorkspaceKey.get(run.workspaceKey)?.client;
        if (mutable.serviceDisposing || activeClient !== run.client || run.client.isDisposed)
          return;
        await run.client.notify(
          zcodeProtocolMethods.interactionOpenCodeAgentRunEvent,
          notification,
        );
      })
      .catch((error: unknown) => {
        // A failed send consumes its sequence; the receiver must reconcile the gap by exact run identity.
        logger.warn(undefined, "OpenCode delegated run event delivery failed", {
          event: "zcode_agent.opencode_run.notification_failed",
          workspaceKey: run.workspaceKey,
          commandId: run.commandId,
          runId: run.runId,
          sequence: notification.sequence,
          errorType: error instanceof Error ? error.name : typeof error,
        });
      });
    await run.eventDelivery;
  };
  const closeOpenCodeRun = async (
    run: HostOpenCodeRun,
    terminal: HostOpenCodeRunStatus,
    details: {
      diagnosticCode?: string;
      stopReason?: string;
      finalText?: string;
    } = {},
  ): Promise<void> => {
    if (["completed", "cancelled", "failed", "interrupted"].includes(run.status)) return;
    run.status = terminal;
    run.diagnosticCode = details.diagnosticCode;
    run.stopReason = details.stopReason;
    if (details.finalText !== undefined) run.finalText = details.finalText.slice(0, 16 * 1024);
    const terminalEvent =
      terminal === "completed"
        ? {
            type: "completed",
            stopReason: run.stopReason ?? "end_turn",
            ...(run.finalText ? { finalText: run.finalText } : {}),
          }
        : terminal === "cancelled"
          ? {
              type: "cancelled",
              ...(run.diagnosticCode ? { diagnosticCode: run.diagnosticCode } : {}),
            }
          : terminal === "interrupted"
            ? {
                type: "interrupted",
                diagnosticCode: run.diagnosticCode ?? "host_disconnected",
              }
            : {
                type: "failed",
                diagnosticCode: run.diagnosticCode ?? "acp_request_failed",
              };
    if (run.opencodeSessionId) await emitOpenCodeRunEvent(run, terminalEvent);
    for (const disposable of run.disposables.splice(0)) disposable.dispose();
    if (run.opencodeSessionId) {
      try {
        await options?.openCodeAcpRuntime?.closeSession({
          sessionId: run.opencodeSessionId,
        });
      } catch (error) {
        logger.warn(undefined, "OpenCode ACP session cleanup failed", {
          workspaceKey: run.workspaceKey,
          runId: run.runId,
          error: String(error),
        });
      }
    }
  };
  const disposeOpenCodeRuns = async (workspaceKey?: string): Promise<void> => {
    const runs = [...openCodeRuns.values()].filter(
      (run) =>
        (workspaceKey === undefined || run.workspaceKey === workspaceKey) &&
        (!(["completed", "cancelled", "failed", "interrupted"] as const).includes(
          run.status as "completed" | "cancelled" | "failed" | "interrupted",
        ) ||
          (run.startupPromise !== undefined && !run.startupSettled)),
    );
    await Promise.all(
      runs.map(async (run) => {
        run.disconnectRequested = true;
        run.cancelRequested = true;
        // teardown 要等启动 continuation 收口：startSession/config 仍在途时由它关闭迟到会话，
        // 这样 disposeAllAndWait 完成才代表 ACP 的启动清理已经结束。
        if (run.startupPromise && !run.startupSettled) {
          run.status = "cancelling";
          await run.startupPromise;
          if (["completed", "cancelled", "failed", "interrupted"].includes(run.status)) return;
        }
        if (!run.opencodeSessionId) {
          run.status = "cancelling";
          return;
        }
        if (run.opencodeSessionId) {
          await options?.openCodeAcpRuntime
            ?.cancel({ sessionId: run.opencodeSessionId })
            .catch(() => undefined);
        }
        await closeOpenCodeRun(run, "interrupted", {
          diagnosticCode: "host_shutdown",
        });
      }),
    );
  };
  const normalizeOpenCodeUpdate = (run: HostOpenCodeRun, update: OpenCodeAcpSessionUpdate) => {
    const value = update as unknown as Record<string, unknown>;
    const type = value.sessionUpdate;
    if (type === "agent_message_chunk") {
      const content = value.content as { type?: unknown; text?: unknown } | undefined;
      if (content?.type === "text" && typeof content.text === "string") {
        const text = content.text.slice(0, 16 * 1024);
        run.finalText = `${run.finalText ?? ""}${text}`.slice(0, 16 * 1024);
        void emitOpenCodeRunEvent(run, { type: "content", text });
      }
    } else if (type === "tool_call" || type === "tool_call_update") {
      const toolCallId = value.toolCallId;
      if (typeof toolCallId === "string") {
        void emitOpenCodeRunEvent(run, {
          type: "tool",
          toolCallId: toolCallId.slice(0, 256),
          title: (typeof value.title === "string" ? value.title : "Tool call").slice(0, 256),
          status: (typeof value.status === "string" ? value.status : "in_progress").slice(0, 64),
        });
      }
    }
  };
  const normalizeOpenCodePermission = (run: HostOpenCodeRun, event: OpenCodeAcpPermissionEvent) => {
    if (event.type === "requested") {
      const request = event.request;
      if (request.sessionId !== run.opencodeSessionId || !run.opencodeSessionId) return;
      const optionIds = new Set(request.options.map((option) => option.optionId));
      run.permissions.set(request.requestId, optionIds);
      void emitOpenCodeRunEvent(run, {
        type: "permissionRequested",
        requestId: request.requestId.slice(0, 256),
        title: request.toolTitle.slice(0, 256),
        ...(request.inputSummary ? { inputSummary: request.inputSummary.slice(0, 2048) } : {}),
        options: request.options.slice(0, 32).map((option) => ({
          optionId: option.optionId.slice(0, 256),
          name: option.name.slice(0, 256),
          kind: option.kind,
        })),
      });
    } else {
      if (event.sessionId !== run.opencodeSessionId || !run.opencodeSessionId) return;
      run.permissions.delete(event.requestId);
      void emitOpenCodeRunEvent(run, {
        type: "permissionResolved",
        requestId: event.requestId.slice(0, 256),
        cancelled: event.cancelled,
      });
    }
  };
  const interactionPreferenceSyncByWorkspaceKey = new Map<string, Promise<void>>();
  const dynamicWorkflowPolicySyncByWorkspaceKey = new Map<string, Promise<void>>();
  const waitingWorkspaceStartups = new Map<string, WaitingWorkspaceStartup>();
  // 同一 Client 的 Account Config 与 runtime catalog 共用串行链，避免旧快照覆盖新版本。
  const accountConfigSyncByClient = new WeakMap<ZCodeProtocolClient, Promise<void>>();
  // 此缓存只记住已收到 ACK 的账号快照版本，不代表其他 runtime catalog 版本。
  const accountConfigReceivedRevisionByClient = new WeakMap<ZCodeProtocolClient, string>();
  const runtimeCatalogReceivedRevisionByClient = new WeakMap<ZCodeProtocolClient, string>();
  const sessionTraceIdBySessionKey = new Map<string, TraceId>();
  const accountRequestAuthService = options?.accountRequestAuthService;
  const accountProviderConfigSource = options?.accountProviderConfigSource;
  const runtimeProviderCatalogSource = options?.runtimeProviderCatalogSource;
  const modelSelectionReadinessSource = options?.modelSelectionReadinessSource;
  const sessionRuntimePreferencesAuthority = options?.sessionRuntimePreferencesAuthority ?? "local";
  const resolveSessionRuntimePreferences = options?.resolveSessionRuntimePreferences;
  return {
    options,
    mutable,
    processManager,
    cuaOperationTurnTracker,
    automationRepo,
    automationService,
    automationTaskIndexRepo,
    pluginProcessManager,
    mcpStatusProcessManager,
    sessionEmitters,
    officialMcpIssuanceAudit,
    providerRuntimeHeadersWorkspaceEmitters,
    providerRuntimeHeadersCancelledEmitters,
    sessionRuntimePreferencesRequestEmitter,
    processResourceSampleEmitter,
    toolExecResourceEmitter,
    mcpResourceSamplesEmitter,
    mcpTelemetryEmitter,
    pluginOperationProgressEmitters,
    conversationFrameEmitters,
    localTtftFactsEmitter,
    conversationTelemetryFactEmitters,
    offPeakLifecycleEmitters,
    pluginUiToolResultEmitter,
    cuaPermissionObservationEmitter,
    sessionsIndexFrameEmitters,
    workspaceConfigFrameEmitters,
    v4ConnectionId,
    v4SubscriptionRoutes,
    v4RouteKeyByOwnership,
    sessionEventSequenceStates,
    wiredClients,
    clientDisposables,
    pendingPermissions,
    pendingUserInputs,
    memoryDiagnostics,
    pendingProviderRuntimeHeaders,
    pendingSessionRuntimePreferences,
    activeClientsByWorkspaceKey,
    openCodeRuns,
    openCodeRunKey,
    emitOpenCodeRunEvent,
    closeOpenCodeRun,
    disposeOpenCodeRuns,
    normalizeOpenCodeUpdate,
    normalizeOpenCodePermission,
    interactionPreferenceSyncByWorkspaceKey,
    dynamicWorkflowPolicySyncByWorkspaceKey,
    waitingWorkspaceStartups,
    accountConfigSyncByClient,
    accountConfigReceivedRevisionByClient,
    runtimeCatalogReceivedRevisionByClient,
    sessionTraceIdBySessionKey,
    accountRequestAuthService,
    accountProviderConfigSource,
    runtimeProviderCatalogSource,
    modelSelectionReadinessSource,
    sessionRuntimePreferencesAuthority,
    resolveSessionRuntimePreferences,
  };
}

export type ZCodeAgentServiceState = ReturnType<typeof createZCodeAgentServiceState>;
