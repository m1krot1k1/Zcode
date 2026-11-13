
/* eslint-disable max-lines -- ZCode Protocol 的 session/workspace 方法共享同一个 server context 与 snapshot helpers，迁移期先集中维护。 */
import { observeSessionDebug } from "./session-debug.js";






import { createSessionId, type SessionEvent, SessionEventType, type SessionId, type CollaborationMode, type WorkspaceId } from "@zcode/contracts";
import { subagentRuntimeConfigSchema, ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS, zcodeProtocolMethods, zcodeSessionCreateParamsSchema, zcodeSessionForkParamsSchema, isRemoteWorkspaceIdentity, type ZCodeProtocolTrace } from "@zcode/shared";
import { buildWorkspaceRef, formatProtocolModelSelection } from "./mapper.js";
import { optionalModelSelectionFromString } from "./model-mapper.js";
import { ProtocolRequestError, assertExpectedRevision, createProtocolRootTraceContext, parseParams, requireSession, type ZCodeProtocolAgentServerContext, type ZCodeProtocolSessionRecord } from "./server-types.js";
import { createWorkspaceZCodeApp } from "./workspace-model-runtime.js";

import { createProtocolInteractionBroker } from "./interaction-broker.js";
import { createProtocolAutomationPort } from "./automation-port.js";
import { createProtocolOffPeakPort } from "./offpeak-port.js";
import { createProtocolTopicResourcePort } from "./topic-resource-port.js";
import { createProtocolCodeIntelligencePort } from "./code-index-port.js";
import { createProtocolBrowserControlBroker } from "./browser-control-broker.js";
import { mapComputerUseOperationEvent } from "./computer-use-operation-event.js";
import { protocolMcpServersToRuntimeMcpConfig } from "./protocol-mcp-config.js";


import { runSessionModelConfigMutation } from "../zcode-protocol-v4/model-config-mutation.js";

import { resolveDynamicWorkflowRuntimeGate } from "./dynamic-workflow-policy.js";

import {
  SessionStartupPreferences,
  SessionStartupPreferencesSource,
  ZCodeSessionRecordParams,
  ensureNoActiveTurn,
  inheritForkedSessionTarget,
  reconcileRecordPersistence,
  resolveSupportedAppThoughtLevel,
} from "./server-operations-part1.js";
import {
  SnapshotPhaseDurationsMs,
  getPersistedSession,
  resolveSessionToolDenylist,
  shouldHideProtocolSessionEvent,
  snapshot,
  toRuntimeModelSelection,
} from "./server-operations-part2.js";
import {
  mergeProtocolStreamingDeltaBatch,
  readStreamingDeltaBatchableEvent,
  resolveSessionStartupPreferences,
  shouldFlushProtocolStreamingDeltaBatchForInterval,
} from "./server-operations-part3.js";
import { getLiveProtocolStreamingDeltaBatchState, resolveForkTarget } from "./server-operations-part4.js";
import { flushLiveProtocolStreamingDeltaBatch, isNonActivitySessionEvent, resetLiveProtocolStreamingDeltaBatch, sendProtocolSessionEvent, snapshotWithDiagnostics } from "./server-operations-part5.js";
import { persistImportedSessionHistory } from "./server-operations-part7.js";

// Часть 6/7 модуля server-operations: вынесено по лимиту строк.

export function onSessionEvent(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  event: SessionEvent,
): void {
  const computerUseOperationEvent = mapComputerUseOperationEvent(event);
  if (computerUseOperationEvent) {
    try {
      // 桌面 v4 主链没有旧 session/event 的 deliveryKind 订阅，顶部提示不能继续
      // 依赖该旧门控；这里只发送无内容的生命周期元数据，并与 v4 投影并行、互不阻断。
      context.notify({
        method: zcodeProtocolMethods.computerUseOperationEvent,
        params: computerUseOperationEvent,
      });
      // 这条 notify 过去只在抛错时有日志，成功路径无痕，于是「agent 压根没发」
      // 与「发了但宿主侧静默丢弃」无法区分。CLI 自己的 jsonl 收 debug 级，足够闭环到源头。
      context.logger?.debug("Computer Use operation lifecycle notification sent", {
        event: "zcode_protocol.computer-use.operation-event.sent",
        eventId: computerUseOperationEvent.eventId,
        sessionId: computerUseOperationEvent.sessionId,
        kind: computerUseOperationEvent.kind,
        turnId:
          "turnId" in computerUseOperationEvent ? computerUseOperationEvent.turnId : undefined,
      });
    } catch (error) {
      context.logger?.warn("Computer Use operation lifecycle notification failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "zcode_protocol.computer-use.operation-event.failed",
        eventId: computerUseOperationEvent.eventId,
        sessionId: computerUseOperationEvent.sessionId,
        turnId:
          "turnId" in computerUseOperationEvent ? computerUseOperationEvent.turnId : undefined,
      });
    }
  }
  if (String(event.sessionId) !== record.app.sessionId) {
    // subagent runtime 复用父 runtime 的外部 event sink，但 raw child event
    // 仍属于 child session。无条件用 parent record id ingest 会让 child topic 打开后
    // 不再更新，同时还可能错误 bump 父任务活动时间。这里必须先按事件自己的 sessionId
    // 路由并返回；parent mirror event 本身使用 parent sessionId，继续走下方既有链路。
    context.v4Gateway?.ingestDetachedLiveSession(
      String(event.sessionId),
      event,
      record.app.sessionId,
    );
    return;
  }
  // record.updatedAt 是 sessions-index 的 lastActivityAt 事实源（v4-bridge
  // getSessionIndexMeta），UI 侧栏按它排序。纯配置/恢复/标题元数据事件不是用户会话活动，
  // 之前无差别 bump 会让"切一次模型/点开任务"把任务顶到列表最前并触发整表重排。
  // core 已在发布终态前持久化结果；列表复用同一事实，不从裁剪正文窗口猜测结果。
  if (event.type === SessionEventType.TurnComplete || event.type === SessionEventType.TurnError) {
    const payload = event.payload as { resultType?: string };
    record.lastOutcome =
      event.type === SessionEventType.TurnError
        ? "error"
        : payload.resultType === "cancelled"
          ? "interrupted"
          : "completed";
  }
  const nonActivityEvent = isNonActivitySessionEvent(event);
  if (event.type === SessionEventType.ModelSelected) {
    // 恢复候选只服务初始 UI；用户新选择生效后不能在后续清空时被旧候选复活。
    delete record.restoredModelSelection;
  }
  if (!nonActivityEvent) {
    record.updatedAt = Date.now();
  }
  reconcileRecordPersistence(record);
  // 调试旁路不依赖聊天订阅；放在 deliveryKind 判断之前，避免旧订阅退出后诊断再次断流。
  observeSessionDebug(record, event);
  // v4 通道：权威事件无条件喂给 v4 投影/发布器——v4 订阅不依赖旧协议的
  // deliveryKind 订阅态，帧节奏由 gateway 按订阅者 profile 自行调度。
  context.v4Gateway?.ingest(record.app.sessionId, event);
  if (!record.deliveryKind) return;
  const deltaInfo = readStreamingDeltaBatchableEvent(event);
  if (deltaInfo && !shouldHideProtocolSessionEvent(record, event)) {
    const batchState = getLiveProtocolStreamingDeltaBatchState(record, record.deliveryKind);
    if (batchState.batch && batchState.batch.batchKey !== deltaInfo.batchKey) {
      flushLiveProtocolStreamingDeltaBatch(context, record, record.deliveryKind);
    }
    batchState.batch = mergeProtocolStreamingDeltaBatch(batchState.batch, event, deltaInfo);
    if (
      deltaInfo.shouldFlushFirstDelta &&
      !batchState.flushedFirstDeltaBatchKeys.has(deltaInfo.batchKey)
    ) {
      flushLiveProtocolStreamingDeltaBatch(context, record, record.deliveryKind);
      batchState.flushedFirstDeltaBatchKeys.add(deltaInfo.batchKey);
      return;
    }
    if (
      batchState.batch.delta.length >= batchState.batch.maxChars ||
      shouldFlushProtocolStreamingDeltaBatchForInterval(
        batchState.batch,
        batchState.lastFlushAtByBatchKey,
      )
    ) {
      flushLiveProtocolStreamingDeltaBatch(context, record, record.deliveryKind);
    }
    return;
  }

  resetLiveProtocolStreamingDeltaBatch(context, record, record.deliveryKind);
  sendProtocolSessionEvent(context, record, event, record.deliveryKind);
}

export async function createRecord(
  context: ZCodeProtocolAgentServerContext,
  params: ZCodeSessionRecordParams,
  sessionId: SessionId,
  resume: boolean,
  startupPreferences: SessionStartupPreferences,
  trace?: ZCodeProtocolTrace,
): Promise<ZCodeProtocolSessionRecord> {
  const workspace =
    "workspace" in params && params.workspace
      ? params.workspace
      : buildWorkspaceRef({ workspacePath: context.deps.cwd ?? process.cwd() });
  const eventStore = context.deps.createSessionEventStore(sessionId);
  const traceContext = createProtocolRootTraceContext(sessionId, trace);
  const initialModel = "model" in params ? params.model : undefined;
  const parentSessionId =
    "parentSessionId" in params && params.parentSessionId
      ? (params.parentSessionId as SessionId)
      : undefined;
  const taskType = params.taskType ?? "interactive";
  const runtimeMcp = protocolMcpServersToRuntimeMcpConfig(params.mcpServers);
  context.logger?.info("ZCode Protocol createRecord MCP config", {
    event: "zcode_protocol.create_record.mcp_config",
    rootTraceId: traceContext.traceId,
    inboundTraceId: trace?.traceId,
    paramMcpServerCount: params.mcpServers?.length ?? 0,
    runtimeHasMcpConfig: Boolean(runtimeMcp),
    runtimeMcpServerCount: Object.keys(runtimeMcp?.servers ?? {}).length,
    sessionId,
    workspaceKey: workspace.workspaceKey,
    workspacePath: workspace.workspacePath,
  });
  // automation-port 需要读取「本会话」的实时 model/mode/thought；record 在 app 之后才建。
  // 用可变持有者做惰性绑定：CronCreate 在 turn 中调用 create() 时 record 早已就绪。
  let ownSessionRecord: ZCodeProtocolSessionRecord | undefined;
  const app = await createWorkspaceZCodeApp(context, workspace, {
    env: context.deps.env,
    eventStore,
    resume,
    additionalDirectories: params.additionalDirectories ?? startupPreferences.additionalDirectories,
    runtimeConfig: {
      mode: "mode" in params ? params.mode : undefined,
      modelSelection: "model" in params ? toRuntimeModelSelection(initialModel) : undefined,
      parentSessionId,
      taskType,
      // 动态工作流灰度门（docs/dynamic-workflow/launch.md「Gray release」「On demand: activation」）：
      // 与 offPeakPort 同一套读法——本次 create/resume 参数优先，缺席时读 Host 同步到进程的
      // workspace 级结论。取值与「必须显式布尔」的理由收在 resolveDynamicWorkflowRuntimeGate。
      ...resolveDynamicWorkflowRuntimeGate(
        {
          dynamicWorkflowEnabled:
            "dynamicWorkflowEnabled" in params ? params.dynamicWorkflowEnabled : undefined,
          dynamicWorkflowMode:
            "dynamicWorkflowMode" in params ? params.dynamicWorkflowMode : undefined,
        },
        context.appRuntimePreferences,
      ),
      // 修复原因：协议侧的工具允许/拒绝列表是 session 级安全边界，必须进入 runtimeConfig，
      // 不能只依赖 prompt 文本约束，否则内置工具和动态 MCP 工具仍可能越过调用面。
      toolAllowlist: "toolAllowlist" in params ? params.toolAllowlist : undefined,
      toolDisallowlist: resolveSessionToolDenylist(params, workspace),
      nativeSearchEnhancementsEnabled: startupPreferences.nativeSearchEnhancementsEnabled,
      toolSearch: { mode: startupPreferences.toolSearchMode },
      workspaceBoundary: startupPreferences.workspaceBoundary,
      modelContextBudgetStrategy: startupPreferences.modelContextBudgetStrategy,
      // Memory Settings 是现有 CLI features.memory/use 之外的总开关。只在关闭时
      // 写入 override，避免开启值反向覆盖用户已有的 CLI 禁用配置。
      ...(startupPreferences.memoryEnabled ? {} : { memory: { enabled: false } }),
      // desktop-continuous session/create 由 UI 先解析 ~/.zcode/.agents 的 enabled MCP，
      // 但 protocol app-server 自己不会读取 UI/main 侧的 MCP store；之前 createRecord 没把
      // params.mcpServers 注入 runtimeConfig，导致日志里 runtimeHasMcpConfig=false，工具永远不启动。
      // MCP 是 runtime 启动期配置，因此必须在 session 创建/恢复边界一次性写入 runtimeConfig.mcp。
      ...(runtimeMcp ? { mcp: runtimeMcp } : {}),
      // 之前只有 TUI 路径（tui-prompt-handler）注入 titleGeneration，
      // ZCode Protocol app-server 创建的 session（desktop/web/mobile）没有传，导致
      // shouldAttemptSessionTitleGeneration 的 `if (!config.titleGeneration) return false`
      // 永远命中，模型生成 title 的请求从不触发，侧边栏标题一直停在 first_input 的用户 query。
      // 这里补一份默认配置开启；具体是否生成仍由 runtime 按 parent/taskType/turnNumber 把关。
      // automation 执行会话显式关闭二次命名，避免回答内容覆盖原始用户 query 标题。
      titleGeneration: params.titleGenerationEnabled === false ? { enabled: false } : {},
      workingDirectory: workspace.workspacePath,
      // 身份隔离与路径执行分开：core 只把 identity 写入 session.workspace_id，
      // workingDirectory 仍是远端机器上的实际路径；本地 workspace 保持 undefined。
      workspaceIdentity: workspace.workspaceIdentity as WorkspaceId | undefined,
    },
    // ZCode Protocol app-server 以前没有注入可等待的交互 broker，
    // core 遇到 permission / AskUserQuestion 只能走默认拒绝，UI 永远收不到阻塞请求。
    // 这里把阻塞交互转换成 server-to-client JSON-RPC request，由 app 通过 response 释放 runtime。
    permissionBroker: createProtocolInteractionBroker(context),
    automationPort: createProtocolAutomationPort(context, () => ownSessionRecord),
    topicResourcePort: createProtocolTopicResourcePort(context),
    codeIntelligencePort: createProtocolCodeIntelligencePort(context, sessionId),
    // 只接入 Host 已开放的工具面；缺省不注入。复用现行异步工厂，
    // 不恢复旧 deferred ModelAdapter/Registry overlay，也不改变 Session Selection。
    ...(("offPeakToolEnabled" in params && params.offPeakToolEnabled === true) ||
    context.appRuntimePreferences.offPeakToolEnabled === true
      ? { offPeakPort: createProtocolOffPeakPort(context, () => ownSessionRecord) }
      : {}),
    resolveInitialBashShellSelection: startupPreferences.resolveInitialBashShellSelection,
    ...(startupPreferences.subagentRuntimeConfigEnabled &&
    !(workspace.workspaceIdentity && isRemoteWorkspaceIdentity(workspace.workspaceIdentity))
      ? {
          readSubagentRuntimeConfig: async ({ signal, traceContext }) => {
            signal.throwIfAborted();
            const result = await context.requestClient(
              zcodeProtocolMethods.subagentsReadRuntimeConfig,
              { sessionId },
              subagentRuntimeConfigSchema,
              {
                signal,
                timeoutMs: ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
                trace: { traceId: traceContext.traceId },
              },
            );
            signal.throwIfAborted();
            return result;
          },
        }
      : {}),
    // browser-use：agent.browsers.* 经此把命令转成 interaction/browserExecute 反向请求。
    browserControlPort: createProtocolBrowserControlBroker(context),
    // Protocol server 是受信任的 Desktop/Web/Mobile Host；灰度开关由这里显式注入，
    // 不从 workspace/project 配置或环境变量读取，关闭时仍可通过删掉该字段回滚到 hard block。
    workspaceHookTrustEnabled: true,
    // 无 session 的 Settings Trust 曾绕过 managed policy；session Runtime 与
    // workspace RPC 必须共享 Host 持有的同一 provider，不能各自创建默认 policy。
    workspaceHookPolicyProvider: context.deps.workspaceHookPolicyProvider,
    workspaceHookReviewHost: {
      taskId: sessionId,
      runId: `workspace-hook-run:${sessionId}:${crypto.randomUUID()}`,
      workspaceLabel:
        workspace.workspacePath.split(/[\\/]/u).filter(Boolean).at(-1) ?? workspace.workspacePath,
      ...(workspace.remoteSessionId ? { remoteSessionId: workspace.remoteSessionId } : {}),
    },
    sessionId,
    sessionStore: context.deps.sessionStore,
    traceContext,
    version: context.deps.version,
    modelIoFullRetentionEnabled: context.appRuntimePreferences.modelIoFullRetentionEnabled,
  });
  const now = Date.now();
  const record: ZCodeProtocolSessionRecord = {
    app,
    createdAt: now,
    eventStore,
    memoryEnabled: startupPreferences.memoryEnabled,
    subagentRuntimeConfigEnabled: startupPreferences.subagentRuntimeConfigEnabled,
    modelContextBudgetStrategy: startupPreferences.modelContextBudgetStrategy,
    nativeSearchEnhancementsEnabled: startupPreferences.nativeSearchEnhancementsEnabled,
    toolSearchMode: startupPreferences.toolSearchMode,
    workspaceBoundary: startupPreferences.workspaceBoundary,
    ...(parentSessionId ? { parentSessionId } : {}),
    persistence: "persistence" in params ? (params.persistence ?? "immediate") : "immediate",
    protocolEventSequences: new Map(),
    protocolToolInputTransmissions: new Map(),
    stateRevision: 0,
    taskType,
    traceContext,
    updatedAt: now,
    workspace,
  };
  const unsubscribeSessionEvents = app.runtime.subscribeEvents({
    onSessionEvent: (event) => onSessionEvent(context, record, event),
  });
  record.unsubscribe = () => {
    unsubscribeSessionEvents();
  };
  // 绑定归属会话，供 automation-port 读取本会话实时 model/mode/thought。
  ownSessionRecord = record;
  return record;
}

export async function materializeSessionRecord(
  context: ZCodeProtocolAgentServerContext,
  params: ZCodeSessionRecordParams,
  sessionId: SessionId,
  resume: boolean,
  source: SessionStartupPreferencesSource,
  trace?: ZCodeProtocolTrace,
): Promise<ZCodeProtocolSessionRecord> {
  const startupPreferences = await resolveSessionStartupPreferences(
    context,
    sessionId,
    source,
    trace,
  );
  return createRecord(context, params, sessionId, resume, startupPreferences, trace);
}

export async function materializeCreatedSession<T>(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  trace: ZCodeProtocolTrace | undefined,
  project: (
    record: ZCodeProtocolSessionRecord,
  ) => Promise<{ value: T; phaseDurationsMs?: SnapshotPhaseDurationsMs; messageCount?: number }>,
): Promise<T> {
  const params = parseParams(zcodeSessionCreateParamsSchema, rawParams);
  const startedAt = Date.now();
  const sessionId = params.sessionId! as SessionId;
  const workspace = params.workspace;
  context.logger?.info("ZCode Protocol session/create started", {
    event: "zcode_protocol.session_create.started",
    hasInitialModel: params.model !== undefined,
    hasInitialThoughtLevel: params.thoughtLevel !== undefined,
    inboundTraceId: trace?.traceId,
    module: "bootstrap.zcode_protocol",
    persistence: params.persistence,
    sessionId,
    status: "started",
    workspaceKey: workspace.workspaceKey,
    workspacePath: workspace.workspacePath,
  });
  const recordStartedAt = Date.now();
  const record = await materializeSessionRecord(
    context,
    { ...params, workspace },
    sessionId,
    false,
    { kind: "host" },
    trace,
  );
  const recordCreateDurationMs = Date.now() - recordStartedAt;
  context.assertServing?.();
  context.sessions.set(sessionId, record);
  let setInitialModelDurationMs: number | undefined;
  let setInitialThoughtLevelDurationMs: number | undefined;
  let snapshotDurationMs = 0;
  let snapshotPhaseDurationsMs: SnapshotPhaseDurationsMs | undefined;
  const initialModel = params.model;
  const initialThoughtLevel = params.thoughtLevel;
  try {
    await runSessionModelConfigMutation(record.app, async () => {
      if (initialModel) {
        const setInitialModelStartedAt = Date.now();
        await record.app.setModel(formatProtocolModelSelection(initialModel));
        setInitialModelDurationMs = Date.now() - setInitialModelStartedAt;
        record.stateRevision++;
      }
      const supportedInitialThoughtLevel = resolveSupportedAppThoughtLevel(
        record.app,
        initialThoughtLevel,
      );
      if (supportedInitialThoughtLevel) {
        // app 已接管默认模型/思考深度持久化，session/create 会显式传入 thoughtLevel。
        // Workspace Preferences 必须持久化读取：只读 Agent 内存会在重启后丢掉用户上次选择。
        const setInitialThoughtLevelStartedAt = Date.now();
        await record.app.setThoughtLevel(supportedInitialThoughtLevel);
        setInitialThoughtLevelDurationMs = Date.now() - setInitialThoughtLevelStartedAt;
        record.stateRevision++;
      } else if (initialThoughtLevel) {
        // workspace 默认 thoughtLevel 可能来自上一个模型。新 session 继承另一模型时，
        // 不能把不支持的档位硬塞给 runtime，否则创建阶段会抛 Unsupported reasoning effort。
        context.logger?.warn("ZCode Protocol session/create skipped unsupported thought level", {
          event: "zcode_protocol.session_create.thought_level_skipped",
          module: "bootstrap.zcode_protocol",
          requestedThoughtLevel: initialThoughtLevel,
          sessionId,
          supportedThoughtLevels: record.app.listThoughtLevels(),
          workspaceKey: workspace.workspaceKey,
          workspacePath: workspace.workspacePath,
        });
      }
    });
    if (params.importedHistory) {
      // 历史导入过去只写 legacy snapshot，taskId 不是真实 protocol sessionId，
      // setModel/sendPrompt 会打到不存在的 runtime。这里在创建期把历史写入 sessionStore 并 resume，
      // 让导入结果从第一刻起就是可续聊、可切模型的 ZCode session。
      await persistImportedSessionHistory({
        context,
        record,
        sessionId,
        createParams: params,
      });
      await record.app.resume();
      record.stateRevision++;
    }
    const snapshotStartedAt = Date.now();
    const createdSnapshotResult = await project(record);
    const createdSnapshot = createdSnapshotResult.value;
    snapshotPhaseDurationsMs = createdSnapshotResult.phaseDurationsMs;
    snapshotDurationMs = Date.now() - snapshotStartedAt;
    context.logger?.info("ZCode Protocol session/create completed", {
      durationMs: Date.now() - startedAt,
      event: "zcode_protocol.session_create.completed",
      hasInitialModel: initialModel !== undefined,
      hasInitialThoughtLevel: initialThoughtLevel !== undefined,
      messageCount: createdSnapshotResult.messageCount,
      module: "bootstrap.zcode_protocol",
      persistence: params.persistence,
      recordCreateDurationMs,
      rootTraceId: record.traceContext.traceId,
      sessionId,
      setInitialModelDurationMs,
      setInitialThoughtLevelDurationMs,
      snapshotPhaseDurationsMs,
      snapshotDurationMs,
      status: "completed",
      workspaceKey: workspace.workspaceKey,
      workspacePath: workspace.workspacePath,
    });
    return createdSnapshot;
  } catch (error) {
    context.logger?.warn("ZCode Protocol session/create failed", {
      durationMs: Date.now() - startedAt,
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "zcode_protocol.session_create.failed",
      module: "bootstrap.zcode_protocol",
      persistence: params.persistence,
      recordCreateDurationMs,
      rootTraceId: record.traceContext.traceId,
      sessionId,
      setInitialModelDurationMs,
      setInitialThoughtLevelDurationMs,
      snapshotPhaseDurationsMs,
      snapshotDurationMs,
      status: "failed",
      workspaceKey: workspace.workspaceKey,
      workspacePath: workspace.workspacePath,
    });
    // draft 创建会用用户上次选择的模型作为启动种子。
    // 如果该模型已被删除，失败的 record 不能留在 context.sessions：
    // 后续 workspace 状态继续读到这个半初始化 app，造成模型/思考档位串台。
    record.unsubscribe?.();
    // v4 通道：创建期已 ingest 的事件会惰性建出 publisher，失败清理时一并回收。
    // 创建失败只释放运行态，不把它宣告为 CLI 已持久化的软删除。
    context.v4Gateway?.disposeSession(sessionId);
    context.sessions.delete(sessionId);
    try {
      await record.app.close?.();
    } catch {
      // 保留原始 create 失败原因；close 只是清理半初始化 runtime 的 best-effort 动作。
    }
    // 内存 event store 随 record 释放。
    await record.eventStore.deleteSession(sessionId as SessionId).catch(() => undefined);
    throw error;
  }
}

/**
 * 已完成 core copy 后只注册 child record。V4 running fork 复用这段宿主生命周期，
 * 但不会进入 forkSession 的 active-turn guard / workspace fork；runtimeConfig 可固定在 fork 点。
 */
export async function registerForkedSession(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  fork: Awaited<ReturnType<ZCodeProtocolSessionRecord["app"]["forkFromCheckpoint"]>>,
  options: {
    runtimeConfig: {
      mode: CollaborationMode;
      model: string;
      thoughtLevel?: string;
      followupMode?: "queue" | "guide";
    };
    inheritLatestTarget: boolean;
  },
) {
  const parentMode = options.runtimeConfig.mode;
  const parentModel = options.runtimeConfig.model;
  const parentThoughtLevel = options.runtimeConfig.thoughtLevel;
  const parentFollowupMode = options.runtimeConfig.followupMode;
  const forkedSession = await getPersistedSession(context, fork.forkedSessionId);
  if (!forkedSession) {
    throw new Error(`Persisted child session not found: ${fork.forkedSessionId}`);
  }
  const forkRecord = await materializeSessionRecord(
    context,
    {
      sessionId: fork.forkedSessionId,
      mode: parentMode,
      // 未绑定父会话也允许复制历史；不能因分叉而选择默认模型或解析空字符串。
      model: optionalModelSelectionFromString(parentModel),
      ...(fork.parentSessionId ? { parentSessionId: fork.parentSessionId } : {}),
      taskType: forkedSession.taskType,
      workspace: record.workspace,
    },
    fork.forkedSessionId as SessionId,
    true,
    { kind: "inherit", parent: record },
  );
  context.assertServing?.();
  context.sessions.set(fork.forkedSessionId, forkRecord);
  await runSessionModelConfigMutation(forkRecord.app, async () => {
    // fork 是父会话运行态的分支；只复制消息的话新 record 会从 workspace 默认值恢复，
    // 于是 fork 后的当前模型/模式会被最新默认设置覆盖。这里在 resume 前显式继承父会话设置。
    if (forkRecord.app.getMode() !== parentMode) {
      await forkRecord.app.setMode(parentMode);
      forkRecord.stateRevision++;
    }
    if (parentModel && forkRecord.app.getModel() !== parentModel) {
      await forkRecord.app.setModel(parentModel);
      forkRecord.stateRevision++;
    }
    if (parentThoughtLevel && forkRecord.app.getThoughtLevel() !== parentThoughtLevel) {
      await forkRecord.app.setThoughtLevel(parentThoughtLevel);
      forkRecord.stateRevision++;
    }
    if (parentFollowupMode && parentFollowupMode !== "queue") {
      await forkRecord.app.setFollowupMode(parentFollowupMode);
      forkRecord.stateRevision++;
    }
  });
  if (options.inheritLatestTarget) {
    await inheritForkedSessionTarget(context, record, forkRecord, fork.forkedSessionId);
  }
  await forkRecord.app.resume();
  return {
    forkedSessionId: fork.forkedSessionId,
    parentSessionId: fork.parentSessionId,
    targetMessageId: fork.targetMessageId,
    targetCheckpointId: fork.targetCheckpointId,
    response: fork.response,
    snapshot: await snapshot(context, forkRecord, forkedSession),
  };
}

export async function createSessionWithProjection<T>(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  trace: ZCodeProtocolTrace | undefined,
  project: (
    record: ZCodeProtocolSessionRecord,
  ) => Promise<{ value: T; phaseDurationsMs?: SnapshotPhaseDurationsMs; messageCount?: number }>,
): Promise<T> {
  const params = parseParams(zcodeSessionCreateParamsSchema, rawParams);
  const sessionId = (params.sessionId ?? createSessionId()) as SessionId;
  const claims = (context.sessionCreationIds ??= new Set<string>());
  // Host 预留只决定身份与归属，不能覆盖 CLI 已有/软删/正在创建的会话。
  // 在任何 await 前占用 ID，防止 native 与 V4 并发 materialize 同一 runtime。
  if (context.sessions.has(sessionId) || claims.has(sessionId))
    throw new ProtocolRequestError(-32602, "sessionId already exists");
  claims.add(sessionId);
  try {
    if (await context.deps.sessionStore?.getSession(sessionId))
      throw new ProtocolRequestError(-32602, "sessionId already exists");
    return await materializeCreatedSession(context, { ...params, sessionId }, trace, project);
  } finally {
    claims.delete(sessionId);
  }
}

export async function forkSession(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionForkParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  assertExpectedRevision(record, params.expectedRevision);
  ensureNoActiveTurn(record, "Cannot fork while a prompt is running");
  const forkTarget = await resolveForkTarget(context, record, params.target);
  const parentMode = record.app.getMode();
  const parentModel = record.app.getModel();
  const parentThoughtLevel = record.app.getThoughtLevel();
  const fork = await record.app.forkFromCheckpoint({
    targetCheckpointId: forkTarget.targetCheckpointId,
    targetMessageId: forkTarget.targetMessageId,
  });
  return await registerForkedSession(context, record, fork, {
    runtimeConfig: {
      mode: parentMode,
      model: parentModel,
      thoughtLevel: parentThoughtLevel,
    },
    inheritLatestTarget: true,
  });
}

export async function createSession(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  trace?: ZCodeProtocolTrace,
) {
  return createSessionWithProjection(context, rawParams, trace, async (record) => {
    const result = await snapshotWithDiagnostics(context, record);
    return {
      value: result.snapshot,
      phaseDurationsMs: result.phaseDurationsMs,
      messageCount: result.snapshot.messages.length,
    };
  });
}

/** V4 创建只需要 record；不要为了丢弃的 legacy snapshot 强制解析空模型。 */
export async function createSessionRecordForV4(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  return createSessionWithProjection(context, rawParams, undefined, async (record) => ({
    value: { sessionId: record.app.sessionId },
  }));
}
