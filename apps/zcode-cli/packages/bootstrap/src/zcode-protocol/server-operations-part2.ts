


import { resolveEffectiveBashShellSelection } from "@zcode/adapters/exec";



import { repairPersistedRemoteSessionPaths } from "@zcode/core";
import { CoreErrorType, createCoreError, type ExecutionShellSelection, type MessageWithParts, type ModelSelection, type MessageId, type SessionEvent, SessionEventType, type SessionId, type SessionInfo, type TargetCompletionVerificationPayload, type TraceId, type UsageStorePort } from "@zcode/contracts";
import { DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY, ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS, zcodeProtocolMethods, zcodeSessionRuntimePreferencesResultSchema, zcodeUsageStatsParamsSchema, getConversationMessageProjectionPolicy, isRemoteWorkspaceIdentity, type ZCodeSessionCreateParams, type ZCodeDeliveryKind, type IntegratedTerminalShellSelection, type ZCodeSessionRuntimePreferencesScope, type ZCodeSessionRuntimePreferencesResult, type ZCodeProtocolTrace, type ZCodeSessionEvent, type ZCodeWorkspaceRef, type ZCodeStateUpdatedNotification } from "@zcode/shared";


import { ProtocolRequestError, parseParams, type ZCodeProtocolAgentServerContext, type ZCodeProtocolSessionRecord, type ZCodeProtocolToolInputTransmissionState } from "./server-types.js";

import { buildAppUsageSnapshot, resolveTzOffsetMs } from "./usage-stats-builder.js";








import { projectIdFromDirectory } from "../app/paths.js";





import {
  APP_USAGE_RANGE_DAYS,
  DEFAULT_PROTOCOL_EVENT_SEQUENCE_KEY,
  PLAN_MODE_GOAL_CONTINUATION_SKIPPED_MESSAGE,
  ProtocolGoalTarget,
  ProtocolStreamingDeltaKind,
  REMOTE_AUTOMATION_TOOL_NAMES,
  asRecord,
  integratedTerminalShellToExecutionSelection,
  measureJsonBytes,
  numberValue,
  resolveLegacyRemoteWorkspace,
  stringValue,
} from "./server-operations-part1.js";
import { snapshotWithDiagnostics } from "./server-operations-part5.js";
import { projectActiveSessionMessages } from "./server-operations-part5.js";

// Часть 2/7 модуля server-operations: вынесено по лимиту строк.

export async function requestSessionRuntimePreferences(
  context: ZCodeProtocolAgentServerContext,
  sessionId: SessionId,
  scope: ZCodeSessionRuntimePreferencesScope,
  trace?: ZCodeProtocolTrace,
): Promise<ZCodeSessionRuntimePreferencesResult> {
  const startedAt = Date.now();
  // ZCodeProtocolTrace.traceId 是协议层的 string；LogContext 需要 branded TraceId，
  // 按本文件既有惯例断言收口，避免多处日志构造重复转换。
  const traceId = trace?.traceId as TraceId | undefined;
  context.logger?.debug("ZCode Protocol runtime preferences request started", {
    event: "zcode_protocol.runtime_preferences.request_started",
    module: "bootstrap.zcode_protocol",
    scope,
    sessionId,
    traceId,
  });
  try {
    const result = await context.requestClient(
      zcodeProtocolMethods.sessionRequestRuntimePreferences,
      { sessionId, scope },
      zcodeSessionRuntimePreferencesResultSchema,
      {
        timeoutMs: ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
        ...(trace ? { trace } : {}),
      },
    );
    context.logger?.debug("ZCode Protocol runtime preferences response received", {
      durationMs: Math.max(0, Date.now() - startedAt),
      event: "zcode_protocol.runtime_preferences.response_received",
      module: "bootstrap.zcode_protocol",
      scope,
      sessionId,
      traceId,
    });
    return result;
  } catch (error) {
    const errorCode = error instanceof ProtocolRequestError ? error.code : undefined;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const diagnostic = {
      durationMs: Math.max(0, Date.now() - startedAt),
      errorCode,
      errorMessage,
      event: "zcode_protocol.runtime_preferences.request_failed",
      module: "bootstrap.zcode_protocol",
      scope,
      sessionId,
      traceId,
    };
    if (errorCode === -32022) {
      // 诊断：偏好请求超时发生在 runtime 注册前；记录 session/scope，区分
      // “Host 没收到/没回包”和“恢复过程中其他阶段失败”。
      context.logger?.warn("ZCode Protocol runtime preferences request timed out", diagnostic);
    } else if (errorCode !== -32601 && errorCode !== -32020) {
      context.logger?.warn("ZCode Protocol runtime preferences request failed", diagnostic);
    } else {
      context.logger?.debug(
        "ZCode Protocol runtime preferences compatibility fallback",
        diagnostic,
      );
    }
    if (error instanceof ProtocolRequestError && (error.code === -32601 || error.code === -32020)) {
      // 兼容旧 Host 或无 Host 的纯 CLI 创建路径；Memory 服从产品默认关闭，
      // 增强搜索维持原有默认开启，其他协议/传输错误仍阻止 runtime 创建。
      return {
        askUserQuestionAutoResolutionEnabled: true,
        memoryEnabled: false,
        modelContextBudgetStrategy: DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
        nativeSearchEnhancementsEnabled: true,
        toolSearchMode: "off",
        // Без Host-ответа нельзя угадывать политику: fail-closed к прежнему поведению allow.
        workspaceBoundary: "allow",
      };
    }
    throw error;
  }
}

export async function readPersistedSessionMessages(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
): Promise<MessageWithParts[]> {
  return await (context.deps.sessionStore?.messages({
    sessionID: sessionId as SessionId,
  }) ?? []);
}

export function isZCodeSessionMode(
  value: unknown,
): value is NonNullable<ZCodeSessionCreateParams["mode"]> {
  return (
    value === "plan" ||
    value === "build" ||
    value === "edit" ||
    value === "yolo" ||
    value === "guarded" ||
    value === "auto"
  );
}

export function toRuntimeModelSelection(
  model: ZCodeSessionCreateParams["model"],
): ModelSelection | undefined {
  if (!model) return undefined;
  return {
    modelId: model.modelId,
    providerId: model.providerId,
    ...(model.options ? { options: model.options } : {}),
  };
}

export interface SnapshotPhaseDurationsMs {
  contextUsageBreakdownEvents: number;
  eventSeq: number;
  goalVerificationEvents: number;
  persistedMessages: number;
  persistedSession: number;
  rewindEvents: number;
  target: number;
  todos: number;
  buildSnapshot: number;
}

export function isTargetCompletionVerificationStatus(
  status: string | undefined,
): status is TargetCompletionVerificationPayload["status"] {
  return (
    status === "started" ||
    status === "completed" ||
    status === "failed_closed" ||
    status === "cancelled"
  );
}

export function limitMessages<T>(messages: T[], limit?: number): T[] {
  return limit && limit > 0 ? messages.slice(-limit) : messages;
}

export async function readSessionMessages(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
) {
  if (!context.deps.sessionStore) return [];
  return await context.deps.sessionStore.messages({
    sessionID: record.app.sessionId as SessionId,
  });
}

export async function readSessionContextUsageBreakdownEvents(
  record: ZCodeProtocolSessionRecord,
): Promise<SessionEvent[]> {
  const events = await record.eventStore.getEvents(record.app.sessionId as SessionId);
  return events.filter((event) => event.type === SessionEventType.ModelComplete);
}

export async function readSessionRewindEvents(
  record: ZCodeProtocolSessionRecord,
): Promise<SessionEvent[]> {
  const events = await record.eventStore.getEvents(record.app.sessionId as SessionId);
  return events.filter((event) => event.type === SessionEventType.RewindTriggered);
}

export type ActiveConversationRewindPayload = {
  createdMessageId: MessageId;
  targetMessageId: MessageId;
};

export function isRewindCommandAckMessage(
  message: MessageWithParts,
  targetByNoticeMessageId: ReadonlyMap<MessageId, MessageId>,
): boolean {
  if (message.info.role !== "assistant") {
    return false;
  }
  const targetMessageId = targetByNoticeMessageId.get(message.info.parentID);
  if (!targetMessageId) {
    return false;
  }
  const text = message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
  const ackText = `Rewound conversation to before message ${targetMessageId}.`;
  // 内部 `/rewind conversation <messageId>` 的成功回执可能被旧事件投影落成
  // assistant 文本。它只是编辑/重试的控制命令 ACK，刷新或恢复时不能再渲染给用户。
  return text === ackText || text.endsWith(`\n${ackText}`);
}

export function isUserVisibleSessionMessage(message: MessageWithParts): boolean {
  if (message.info.role !== "user") {
    return true;
  }
  const policy = getConversationMessageProjectionPolicy(message);
  return policy === "realUserInput" || policy === "timelineOnly";
}

export async function getPersistedSession(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
): Promise<SessionInfo | null> {
  const sessionStore = context.deps.sessionStore;
  if (!sessionStore) return null;
  const session = await sessionStore.getSession(sessionId as SessionId);
  if (!session) return null;
  // 协议冷恢复先用 session.path 创建 runtime，必须在物化前清理旧版 identity/cwd 混写数据。
  return await repairPersistedRemoteSessionPaths(sessionStore, session, {
    onPersistenceFailure: (error) => {
      context.logger?.warn("Session path repair persistence failed; using in-memory repair", {
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "zcode_protocol.session.path_repair.persist_failed",
        sessionId,
      });
    },
  });
}

export function emitStateUpdated(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  reason: string,
  patch: unknown,
): void {
  const notification: ZCodeStateUpdatedNotification = {
    patch,
    reason,
    revision: record.stateRevision,
    scope: "session",
    sessionId: record.app.sessionId,
    type: "state.updated",
    workspace: record.workspace,
  };
  context.notify({ method: "state.updated", params: notification });
}

export interface ProtocolStreamingDeltaBatchInfo {
  batchKey: string;
  delta: string;
  kind: ProtocolStreamingDeltaKind;
  maxChars: number;
  shouldFlushFirstDelta: boolean;
  timestampMs: number;
}

export interface ProtocolStreamingDeltaBatch {
  batchKey: string;
  delta: string;
  event: SessionEvent;
  kind: ProtocolStreamingDeltaKind;
  maxChars: number;
  startedAtMs: number;
  updatedAtMs: number;
}

export function protocolEventSequenceKey(deliveryKind?: ZCodeDeliveryKind): string {
  return deliveryKind ?? DEFAULT_PROTOCOL_EVENT_SEQUENCE_KEY;
}

export function buildProtocolStreamingDeltaBatchKey(params: {
  assistantMessageId?: string;
  inputId?: string;
  kind: ProtocolStreamingDeltaKind;
  partId?: string;
  parentToolUseId?: string;
  toolCallId?: string;
}): string {
  return [
    params.kind,
    params.assistantMessageId ?? "",
    params.inputId ?? "",
    params.partId ?? "",
    params.parentToolUseId ?? "",
    params.toolCallId ?? "",
  ].join(":");
}

export function readProtocolStreamingParentToolUseId(
  payload: Record<string, unknown>,
): string | undefined {
  const direct = stringValue(payload.parentToolUseId) ?? stringValue(payload.parentToolCallId);
  if (direct) {
    return direct;
  }
  const meta = asRecord(payload._meta);
  const zcode = asRecord(meta.zcode);
  const claudeCode = asRecord(meta.claudeCode);
  return (
    stringValue(meta.parentToolUseId) ??
    stringValue(meta.parentToolCallId) ??
    stringValue(zcode.parentToolUseId) ??
    stringValue(zcode.parentToolCallId) ??
    stringValue(claudeCode.parentToolUseId) ??
    stringValue(claudeCode.parentToolCallId)
  );
}

export function markStreamedToolInputIfPresent(
  mappedEvent: ZCodeSessionEvent,
  toolInputTransmissions: ZCodeProtocolToolInputTransmissionState,
): void {
  if (mappedEvent.type !== "model.streaming") {
    return;
  }
  const payload = asRecord(mappedEvent.payload);
  if (payload.kind !== "tool_call" || !("input" in payload)) {
    return;
  }
  const toolCallId = stringValue(payload.toolCallId);
  if (!toolCallId) {
    return;
  }
  toolInputTransmissions.streamedToolCallIdsWithInput.add(toolCallId);
}

export function decodeTextProtocolAttachment(record: Record<string, unknown>): string | undefined {
  const dataBase64 = stringValue(record.dataBase64);
  if (!dataBase64) return undefined;
  const sizeBytes = numberValue(record.sizeBytes);
  if (sizeBytes !== undefined && sizeBytes > 64 * 1024) return undefined;
  try {
    return Buffer.from(dataBase64, "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

export function shouldHideProtocolSessionEvent(
  record: ZCodeProtocolSessionRecord,
  event: SessionEvent,
): boolean {
  const payload = asRecord(event.payload);
  const querySource = stringValue(payload.querySource);
  if (event.type === "model_request" && querySource === "session_title") {
    return true;
  }
  if (event.type === "model_network_status" && querySource === "session_title") {
    // 不能用标题生成的全局 suppress 标记隐藏 model_network_status：
    // 标题请求重试时会把并发主请求的 retry 事件也吞掉，导致 app 输入框右下角看不到重试次数。
    // status 事件带 querySource，只隐藏标题生成自己的网络状态。
    return true;
  }
  if (event.type === "model_complete" && querySource === "session_title") {
    return true;
  }
  return false;
}

export function copyByteLength(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  sourceKey: string,
  targetKey: string,
): void {
  if (source[sourceKey] !== undefined) {
    target[targetKey] = measureJsonBytes(source[sourceKey]);
  }
}

export function copySmallObject(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  sourceKey: string,
): void {
  const value = source[sourceKey];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  if (measureJsonBytes(value) <= 1024) {
    target[sourceKey] = value;
  }
}

export function copyContextUsageBreakdownSummary(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): void {
  const value = source.contextUsageBreakdown;
  if (!Array.isArray(value)) {
    return;
  }
  target.contextUsageBreakdownCount = value.length;
  target.contextUsageBreakdownSources = value
    .map((item) => asRecord(item).source)
    .filter((source): source is string => typeof source === "string")
    .slice(0, 20);
}

export function isImportedHistoryMessage(
  message: MessageWithParts,
  source: NonNullable<ZCodeSessionCreateParams["importedHistory"]>["source"],
): boolean {
  const messageId = String(message.info.id);
  if (/^msg_import_\d+$/u.test(messageId) || messageId.startsWith("msg_claude-import-")) {
    return true;
  }
  const messageMetadata = asRecord((message.info as unknown as { metadata?: unknown }).metadata);
  if (messageMetadata.migrationSource === source) {
    return true;
  }
  return message.parts.some((part) => {
    const partMetadata = asRecord((part as unknown as { metadata?: unknown }).metadata);
    return partMetadata.migrationSource === source;
  });
}

export async function repairLegacyRemoteSessionWorkspaceForResume(
  context: ZCodeProtocolAgentServerContext,
  session: SessionInfo,
): Promise<SessionInfo> {
  if (session.workspaceID || !context.deps.sessionStore?.repairLegacyRemoteSessionWorkspace) {
    return session;
  }
  const legacyWorkspaceDirectory = session.path ?? session.directory;
  if (session.directory !== legacyWorkspaceDirectory) return session;
  const legacyRemote = resolveLegacyRemoteWorkspace(context, legacyWorkspaceDirectory);
  if (!legacyRemote) return session;

  const repaired = await context.deps.sessionStore.repairLegacyRemoteSessionWorkspace({
    sessionID: session.id,
    projectID: projectIdFromDirectory(legacyRemote.workspacePath),
    legacyWorkspaceDirectory,
    workspaceID: legacyRemote.workspaceIdentity,
    workspacePath: legacyRemote.workspacePath,
  });
  // 原子修复返回 false 后仍用旧 directory/path 物化 runtime，最终在错误 cwd
  // 中执行工具。这里必须读取原始持久事实，不能让已有 identity 的内存路径修复伪装成已落盘。
  const refreshed = await context.deps.sessionStore.getSession(session.id);
  const repairPersisted =
    refreshed?.workspaceID === legacyRemote.workspaceIdentity &&
    refreshed.directory === legacyRemote.workspacePath &&
    refreshed.path === legacyRemote.workspacePath;
  if (!repairPersisted) {
    context.logger?.warn("legacy remote session workspace repair was not persisted", {
      event: "zcode_protocol.session_resume.legacy_remote_workspace_repair_rejected",
      legacyWorkspaceDirectory,
      legacyWorkspaceIdentity: legacyRemote.workspaceIdentity,
      module: "bootstrap.zcode_protocol",
      repaired,
      sessionId: session.id,
      workspacePath: legacyRemote.workspacePath,
    });
    throw createCoreError(
      CoreErrorType.SessionCorrupted,
      "Legacy remote session workspace repair was not persisted",
      {
        context: {
          directory: refreshed?.directory ?? session.directory,
          path: refreshed?.path ?? session.path,
          reason: "legacy_remote_session_workspace_repair_rejected",
          sessionId: session.id,
          workspaceIdentity: legacyRemote.workspaceIdentity,
        },
        recoverable: true,
      },
    );
  }
  if (repaired) {
    context.logger?.info("legacy remote session workspace repaired", {
      event: "zcode_protocol.session_resume.legacy_remote_workspace_repaired",
      legacyWorkspaceDirectory,
      legacyWorkspaceIdentity: legacyRemote.workspaceIdentity,
      module: "bootstrap.zcode_protocol",
      sessionId: session.id,
      workspacePath: legacyRemote.workspacePath,
    });
  }
  // Core resumeFromStore 会重新读库；NULL identity 修复必须先持久化，不能只改 bootstrap 内存值。
  return refreshed;
}

export async function getUsageStats(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeUsageStatsParamsSchema, rawParams ?? {});
  const timeZone = params.timeZone ?? "UTC";
  const until = Date.now();
  const tzOffsetMs = resolveTzOffsetMs(timeZone, until);
  const rangeDays = APP_USAGE_RANGE_DAYS[params.range] ?? 30;
  const since = params.range === "all" ? 0 : until - rangeDays * 86_400_000;
  const buildOptions = {
    range: params.range,
    timeZone,
    tzOffsetMs,
    generatedAt: until,
    since,
    until,
  };

  // SessionStorePort 与 UsageStorePort 是分离接口，但实际 store 同时实现两者；
  // 沿用 core/usage-observability 的运行时收窄方式访问只读聚合方法。
  const usageStore = context.deps.sessionStore as Partial<UsageStorePort> | undefined;
  if (!usageStore?.queryAppUsage) {
    // 无 usage store（不应发生）：返回空快照而非抛错，便于 UI 显示空态。
    return buildAppUsageSnapshot(
      {
        totals: {
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          modelRequestCount: 0,
          modelErrorCount: 0,
          avgTimeToFirstTokenMs: null,
        },
        turnTotals: {
          totalSessions: 0,
          totalTurns: 0,
          avgTurnDurationMs: null,
          longestSessionMs: 0,
        },
        toolTotals: { toolCallCount: 0, toolErrorCount: 0 },
        models: [],
        tools: [],
        days: [],
        dayModels: [],
      },
      buildOptions,
    );
  }

  const result = await usageStore.queryAppUsage({ since, until, tzOffsetMs });
  return buildAppUsageSnapshot(result, buildOptions);
}

export function resolveSessionToolDenylist(
  params: Pick<ZCodeSessionCreateParams, "toolDenylist">,
  workspace: ZCodeWorkspaceRef,
): readonly string[] | undefined {
  const tools = new Set(params.toolDenylist ?? []);
  if (workspace.workspaceIdentity && isRemoteWorkspaceIdentity(workspace.workspaceIdentity)) {
    // Bug 原因：SSH/WSL/Docker/Server 等远程会话仍注入 automationPort，导致 Cron 工具在远端被注册；
    // 远程 workspace 没有本地调度器的可靠触发边界，所以必须在 session 初始化时统一禁用，
    // 不能只依赖 UI 或 prompt 文本约束。
    for (const toolName of REMOTE_AUTOMATION_TOOL_NAMES) {
      tools.add(toolName);
    }
  }
  return tools.size > 0 ? [...tools] : undefined;
}

export async function pauseActiveGoalForSessionStop(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  params: { sessionId: string },
): Promise<ProtocolGoalTarget | null> {
  if (!record.app.readTarget || !record.app.updateTargetStatus) {
    return null;
  }
  const target = await record.app.readTarget();
  if (!target || target.status !== "active") {
    return null;
  }

  try {
    // Stop 只 abort controller 时，goal verifier 若没及时收到 abort，
    // 会在队列仍持有 stopRequested 的情况下保留 active goal，导致后续队列无法 drain。
    const pausedTarget = await record.app.updateTargetStatus("paused");
    if (pausedTarget) {
      context.logger?.info("ZCode Protocol session/stop paused active goal", {
        sessionId: params.sessionId,
        targetId: pausedTarget.targetID,
        workspacePath: record.workspace.workspacePath,
      });
    }
    return pausedTarget;
  } catch (error) {
    context.logger?.warn("ZCode Protocol session/stop failed to pause active goal", {
      error: error instanceof Error ? error.message : String(error),
      sessionId: params.sessionId,
      targetId: target.targetID,
      workspacePath: record.workspace.workspacePath,
    });
    return null;
  }
}

export function appendPlanModeGoalContinuationNote(response: string): string {
  return `${response}\n\n${PLAN_MODE_GOAL_CONTINUATION_SKIPPED_MESSAGE}`;
}

export function formatGoalChanged(title: string, target: ProtocolGoalTarget): string {
  const lines = [title, `Objective: ${target.objective}`];
  if (target.tokensUsed !== undefined || target.tokenBudget !== undefined) {
    const budget =
      target.tokenBudget === null || target.tokenBudget === undefined
        ? "none"
        : target.tokenBudget.toString();
    lines.push(`Usage: ${target.tokensUsed ?? 0} tokens / ${budget}`);
  }
  if (target.timeUsedSeconds !== undefined) {
    lines.push(`Time: ${target.timeUsedSeconds} seconds`);
  }
  return lines.join("\n");
}

export function resolveProtocolBashShellSelection(
  context: ZCodeProtocolAgentServerContext,
  selection: IntegratedTerminalShellSelection | undefined,
): ExecutionShellSelection {
  const configuredSelection = integratedTerminalShellToExecutionSelection(selection);
  return resolveEffectiveBashShellSelection({
    env: context.deps.env ?? process.env,
    override: configuredSelection,
    platform: context.deps.platform ?? process.platform,
  }).selection;
}

export function derivePersistedSessionMode(
  messages: readonly MessageWithParts[],
): ZCodeSessionCreateParams["mode"] | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const info = messages[index]?.info;
    if (info?.role === "assistant" && isZCodeSessionMode(info.mode)) return info.mode;
  }
  return undefined;
}

export async function snapshot(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  knownSession?: SessionInfo | null,
  options: {
    messageLimit?: number;
    modelAvailability?: "all" | "current";
  } = {},
) {
  return (await snapshotWithDiagnostics(context, record, knownSession, options)).snapshot;
}

export function asGoalCompletionVerification(
  value: unknown,
): TargetCompletionVerificationPayload["verification"] | undefined {
  const record = asRecord(value);
  if (typeof record.passed !== "boolean") {
    return undefined;
  }
  const reason = stringValue(record.reason);
  if (!reason) {
    return undefined;
  }
  return {
    nextAction: stringValue(record.nextAction),
    passed: record.passed,
    reason,
  };
}

export async function readActiveSessionMessages(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
): Promise<MessageWithParts[]> {
  const [messages, session, rewindEvents] = await Promise.all([
    readSessionMessages(context, record),
    getPersistedSession(context, record.app.sessionId),
    readSessionRewindEvents(record),
  ]);
  return projectActiveSessionMessages(messages, session, rewindEvents);
}

export function activeConversationRewindPayloadFromSession(
  session: SessionInfo | null | undefined,
): ActiveConversationRewindPayload | null {
  const createdMessageId = session?.revert?.createdMessageID;
  const targetMessageId = session?.revert?.targetMessageID;
  if (!createdMessageId || !targetMessageId) {
    return null;
  }
  return { createdMessageId, targetMessageId };
}
