
/* eslint-disable max-lines -- ZCode Protocol 的 session/workspace 方法共享同一个 server context 与 snapshot helpers，迁移期先集中维护。 */





import type { SendInputOptions } from "../app/types.js";

import { SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION, type EventId, type MessageWithParts, type MessageId, type QueryId, type SessionEvent, SessionEventType, type SessionId, type TraceId, type TurnBackgroundAttribution, type TurnId } from "@zcode/contracts";
import { zcodeProtocolErrorCodes, zcodeSessionCancelBackgroundTaskParamsSchema, zcodeSessionSetModeParamsSchema, zcodeSessionSetModelParamsSchema, zcodeSessionSetThoughtLevelParamsSchema, zcodeSessionStopParamsSchema, type ZCodeAutomationBotDeliveryTarget, type ZCodeDeliveryKind, type ZCodeSessionEvent, type ZCodeSessionHistoryTarget, type ZCodeSessionResumeParams } from "@zcode/shared";
import { buildWorkspaceRef, mapSessionEventForProtocol, shouldExposeSessionEventToProtocol } from "./mapper.js";

import { ProtocolRequestError, assertExpectedRevision, parseParams, requireSession, type ZCodeProtocolAgentServerContext, type ZCodeProtocolSessionRecord, type ZCodeProtocolToolInputTransmissionState } from "./server-types.js";
import { ensureSessionModelAvailable } from "./workspace-model-runtime.js";











import { runSessionModelConfigMutation } from "../zcode-protocol-v4/model-config-mutation.js";



import {
  ProtocolGoalTarget,
  asRecord,
  buildPromptTurnToolDisallowlist,
  discardFailedSessionResume,
  measureJsonBytes,
  numberValue,
  resolvePromptTurnAutomationId,
  resolvePromptTurnOffPeakTaskId,
  stringValue,
} from "./server-operations-part1.js";
import {
  derivePersistedSessionMode,
  emitStateUpdated,
  getPersistedSession,
  pauseActiveGoalForSessionStop,
  protocolEventSequenceKey,
  readPersistedSessionMessages,
  repairLegacyRemoteSessionWorkspaceForResume,
  shouldHideProtocolSessionEvent,
  snapshot,
} from "./server-operations-part2.js";
import { CONFIG_ONLY_MUTATION_REASONS, LiveProtocolStreamingDeltaBatch, ResumeActivation, assignProtocolEventSeq, getProtocolToolInputTransmissionState, liveProtocolStreamingDeltaBatches, mapProtocolPromptAttachments, omitDuplicateScheduledToolInput, readTargetCompletionVerificationPayload, resolveTurnMessageId, summarizeProtocolPayload } from "./server-operations-part3.js";
import { materializeSessionRecord } from "./server-operations-part6.js";

// Часть 4/7 модуля server-operations: вынесено по лимиту строк.

export function logProtocolSessionEventSent(
  context: ZCodeProtocolAgentServerContext,
  sourceEvent: SessionEvent,
  mappedEvent: ZCodeSessionEvent,
): void {
  const payload =
    typeof mappedEvent.payload === "object" && mappedEvent.payload !== null
      ? (mappedEvent.payload as Record<string, unknown>)
      : {};
  const protocolMessage = {
    method: "session/event",
    params: mappedEvent,
  };
  context.logger?.debug("ZCode Protocol session event sent", {
    deliveryKind: mappedEvent.deliveryKind,
    event: "zcode_protocol.session_event.sent",
    eventId: mappedEvent.eventId,
    method: "session/event",
    module: "bootstrap.zcode_protocol",
    payloadKeys: Object.keys(payload).sort(),
    payloadKind: typeof payload.kind === "string" ? payload.kind : undefined,
    payloadSummary: summarizeProtocolPayload(payload),
    protocolMessageBytes: measureJsonBytes(protocolMessage),
    protocolPayloadBytes: measureJsonBytes(mappedEvent.payload),
    protocolEventType: mappedEvent.type,
    protocolSeq: mappedEvent.seq,
    sessionEventSequenceNumber: sourceEvent.sequenceNumber,
    sessionEventType: sourceEvent.type,
    sessionId: mappedEvent.sessionId,
    turnId: mappedEvent.turnId,
  });
}

// 原因: legacy resume делал `get → 4 await → set` без single-flight. Два параллельных
// session/resume создавали два app/runtime на один sessionId: дубли истории и два
// владельца проекции. V4-путь уже коалесцировал активации, здесь тот же владелец
// должен быть один. Ключ — объект контекста и sessionId, поэтому разные воркспейсы/
// процессы не смешиваются.
export const resumeActivationFlights = new WeakMap<object, Map<string, Promise<ResumeActivation>>>();

export async function activateSessionForResumeInner(
  context: ZCodeProtocolAgentServerContext,
  params: ZCodeSessionResumeParams,
  options: { reusePersistedMessages?: boolean; persistedMessages?: MessageWithParts[] } = {},
): Promise<ResumeActivation> {
  const resumeStartedAt = Date.now();
  const activeBeforeWait = context.sessions.has(params.sessionId);
  context.logger?.debug("ZCode Protocol session resume started", {
    activeBeforeWait,
    event: "zcode_protocol.session.resume_started",
    hasSessionStore: Boolean(context.deps.sessionStore),
    module: "bootstrap.zcode_protocol",
    sessionId: params.sessionId,
  });
  // 再激活闸门：该 session 正在容量去激活（app.close 收尾未完成）时先等待，
  // 防止新旧 app 对同一 session 资源交错读写。无 in-flight 时立即返回。
  await context.sessionResidentPool?.waitForDeactivation(params.sessionId);
  const existing = context.sessions.get(params.sessionId);
  if (existing) {
    return { record: existing };
  }
  let session = await getPersistedSession(context, params.sessionId);
  if (!session || session.time.deleted !== undefined) {
    // 诊断：冷恢复只有在持久化记录也不存在时才会走到这里；单凭错误文本无法和
    // readSession 的“runtime 尚未活跃”区分，因此把两层状态和等待耗时一起落盘。
    context.logger?.warn("ZCode Protocol session resume found no persisted record", {
      activeBeforeWait,
      activeSessionCount: context.sessions.size,
      durationMs: Math.max(0, Date.now() - resumeStartedAt),
      event: "zcode_protocol.session.resume_persisted_missing",
      hasSessionStore: Boolean(context.deps.sessionStore),
      module: "bootstrap.zcode_protocol",
      sessionId: params.sessionId,
    });
    throw new ProtocolRequestError(
      zcodeProtocolErrorCodes.sessionUnavailable,
      `Session not found: ${params.sessionId}`,
    );
  }
  session = await repairLegacyRemoteSessionWorkspaceForResume(context, session);
  const workspace =
    params.workspace ??
    buildWorkspaceRef({
      // V4 历史会话冷订阅只传 sessionId；远端会话若在这里仅用目录
      // 重建 workspace，identity 会退化成 path key，无法命中按 workspaceID 隔离的
      // provider registry，最终把可用模型误判为不可用并永久触发 restoreWarning。
      workspaceIdentity: session.workspaceID,
      workspacePath: session.path ?? session.directory,
    });
  let persistedMessages =
    options.persistedMessages ?? (await readPersistedSessionMessages(context, params.sessionId));
  const mode = derivePersistedSessionMode(persistedMessages);
  // shell 设置变更只对新 session 生效；冷恢复必须使用创建时落库的
  // Bash shell 快照。runtime.resumeFromStore 会读取快照；这里只负责不把
  // resume 请求里携带的当前 settings 重新注入老 session。
  const record = await materializeSessionRecord(
    context,
    {
      ...params,
      mode,
      // 模型只由 App 的单向迁移/当前 entry 恢复，不能先用消息或调用方 hint 构造一次选择。
      model: undefined,
      ...(session.parentID ? { parentSessionId: String(session.parentID) } : {}),
      // resume 曾丢掉持久化 taskType，createRecord 落回缺省
      // "interactive"。于是被 resume 的 workflow_child / subagent_child 会话通过
      // isTaskListSessionType 的筛，经 getSessionWorkspaceId 漏进 sessions-index，
      // desktop 任务列表长出「workflow actor actor#N@k」假任务，任务索引同步器还会
      // 反复对它们发 session/resume。fork 路径一直带着 taskType，这里必须同样带。
      taskType: session.taskType,
      workspace,
    },
    params.sessionId as SessionId,
    true,
    { kind: "host" },
    session.traceID ? { traceId: session.traceID } : undefined,
  );
  // createRecord 把 createdAt/updatedAt 写死为 Date.now()——resume 老会话
  // 会让 sessions-index 把它当"刚创建"的会话（配合 hydration 前的空标题，侧栏
  // 表现为原会话消失、冒出"新任务刚刚"）。恢复路径回填 store 的真实时间。
  if (session.time?.created) record.createdAt = session.time.created;
  if (session.time?.updated) record.updatedAt = session.time.updated;
  record.lastOutcome = session.lastOutcome;
  context.assertServing?.();
  context.sessions.set(params.sessionId, record);
  try {
    const resumeResult = await runSessionModelConfigMutation(record.app, async () => {
      const result = options.reusePersistedMessages
        ? await record.app.resume({ persistedMessages })
        : await record.app.resume();
      // 仅用于首次投影种子，包含有效模型+空档位；它不是第二份可执行 Runtime 选择。
      record.restoredModelSelection = result.modelSelection;
      return result;
    });
    if (options.reusePersistedMessages && resumeResult.persistedMessagesReloadRequired) {
      persistedMessages = await readPersistedSessionMessages(context, params.sessionId);
    }
    context.logger?.info("ZCode Protocol session resume completed", {
      activeSessionCount: context.sessions.size,
      durationMs: Math.max(0, Date.now() - resumeStartedAt),
      event: "zcode_protocol.session.resume_completed",
      module: "bootstrap.zcode_protocol",
      persistedMessageCount: persistedMessages.length,
      sessionId: params.sessionId,
      traceId: record.traceContext.traceId,
    });
    return {
      knownSession: session,
      record,
      ...(options.reusePersistedMessages ? { persistedMessages } : {}),
    };
  } catch (error) {
    // resume 入册后失败曾留下半初始化 app，重试误判已就绪；只回收本次 record，保留历史投影。
    await discardFailedSessionResume(context, params.sessionId, record);
    throw error;
  }
}

export async function resolveForkTarget(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  target: ZCodeSessionHistoryTarget,
): Promise<{ targetCheckpointId?: string; targetMessageId?: string }> {
  if (target.kind === "latestCheckpoint") {
    return {};
  }
  if (target.kind === "checkpoint") {
    return { targetCheckpointId: target.checkpointId };
  }
  if (target.kind === "message") {
    return { targetMessageId: target.messageId };
  }
  return {
    targetMessageId: await resolveTurnMessageId(context, record, target.turnIndex, "assistant"),
  };
}

export function sessionEntryToTargetCompletionVerificationEvent(
  entry: {
    id: string;
    sessionID: SessionId;
    time: { created: number; updated: number };
    data: unknown;
  },
  fallbackSessionId: string,
  index: number,
): SessionEvent | null {
  const data = asRecord(entry.data);
  const payload = readTargetCompletionVerificationPayload(data.payload);
  if (!payload) {
    return null;
  }
  const eventId = stringValue(data.eventId) ?? entry.id;
  const traceId = stringValue(data.traceId) ?? "trace_restored_goal_verification";
  const turnId = stringValue(data.turnId);
  return {
    id: eventId as EventId,
    payload,
    sequenceNumber: numberValue(data.sequenceNumber) ?? index + 1,
    sessionId: (entry.sessionID ?? fallbackSessionId) as SessionId,
    timestamp: new Date(entry.time.updated || entry.time.created),
    traceId: traceId as TraceId,
    ...(turnId ? { turnId: turnId as TurnId } : {}),
    type: SessionEventType.TargetCompletionVerification,
  };
}

export function applyRewindBranch(
  activeMessages: MessageWithParts[],
  allMessages: MessageWithParts[],
  options: {
    createdMessageId?: MessageId;
    keptMessageIds?: readonly MessageId[];
    targetMessageId?: MessageId;
  },
): MessageWithParts[] {
  if (!options.targetMessageId) {
    return activeMessages;
  }

  if (options.keptMessageIds) {
    // 连续 rewind 后，账本里的 target 前缀不等于 active branch 前缀。
    // 优先使用 runtime 在 rewind 当时保存的 keptMessageIDs，避免旧分支在 snapshot/readMessages 中复活。
    const messagesById = new Map(allMessages.map((message) => [message.info.id, message]));
    const keptMessages = options.keptMessageIds
      .map((messageId) => messagesById.get(messageId))
      .filter((message): message is MessageWithParts => message !== undefined);
    if (!options.createdMessageId) {
      return keptMessages;
    }

    const createdIndex = allMessages.findIndex(
      (message) => message.info.id === options.createdMessageId,
    );
    return createdIndex >= 0 ? [...keptMessages, ...allMessages.slice(createdIndex)] : keptMessages;
  }

  const targetIndex = activeMessages.findIndex(
    (message) => message.info.id === options.targetMessageId,
  );
  if (targetIndex < 0) {
    return activeMessages;
  }
  const keptMessages = activeMessages.slice(0, targetIndex);
  if (!options.createdMessageId) {
    return keptMessages;
  }

  const createdIndex = allMessages.findIndex(
    (message) => message.info.id === options.createdMessageId,
  );
  if (createdIndex < 0) {
    return keptMessages;
  }

  // conversation rewind 的持久化账本会保留被回滚的旧分支。
  // UI snapshot/readMessages 必须投影 active branch，否则编辑重发后会同时看到错发原文和新消息。
  return [...keptMessages, ...allMessages.slice(createdIndex)];
}

export async function afterStateMutation(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  reason: string,
) {
  if (!record.activeAbortController) {
    // provider registry 可能在 turn 运行中删除当前模型。更新时不能改写在途请求；turn/compact/
    // goal continuation 释放 active lock 后统一经过此安全边界，立即完成同一 Agent fallback，
    // 无需等待用户下一次发送，也不把兜底职责重新交给 renderer。
    await ensureSessionModelAvailable(context, record);
  }
  record.stateRevision++;
  const configOnlyMutation = CONFIG_ONLY_MUTATION_REASONS.has(reason);
  if (!configOnlyMutation) {
    record.updatedAt = Date.now();
  }
  const stateSnapshot = await snapshot(context, record, undefined, {
    modelAvailability: "current",
  });
  emitStateUpdated(context, record, reason, stateSnapshot.settings);
  return stateSnapshot;
}

export function getLiveProtocolStreamingDeltaBatchState(
  record: ZCodeProtocolSessionRecord,
  deliveryKind?: ZCodeDeliveryKind,
): LiveProtocolStreamingDeltaBatch {
  let byDeliveryKind = liveProtocolStreamingDeltaBatches.get(record);
  if (!byDeliveryKind) {
    byDeliveryKind = new Map();
    liveProtocolStreamingDeltaBatches.set(record, byDeliveryKind);
  }
  const key = protocolEventSequenceKey(deliveryKind);
  const existing = byDeliveryKind.get(key);
  if (existing) {
    return existing;
  }
  const created: LiveProtocolStreamingDeltaBatch = {
    flushedFirstDeltaBatchKeys: new Set(),
    lastFlushAtByBatchKey: new Map(),
  };
  byDeliveryKind.set(key, created);
  return created;
}

export function mapProtocolSessionEvent(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  event: SessionEvent,
  deliveryKind?: ZCodeDeliveryKind,
  options: {
    toolInputTransmissions?: ZCodeProtocolToolInputTransmissionState;
  } = {},
): ZCodeSessionEvent | null {
  if (shouldHideProtocolSessionEvent(record, event)) {
    return null;
  }
  if (!shouldExposeSessionEventToProtocol(event)) {
    const payload = asRecord(event.payload);
    context.logger?.debug("ZCode Protocol session event filtered", {
      event: "zcode_protocol.session_event.filtered",
      eventId: String(event.id),
      module: "bootstrap.zcode_protocol",
      payloadKind: stringValue(payload.kind),
      sessionEventSequenceNumber: event.sequenceNumber,
      sessionEventType: event.type,
      sessionId: String(event.sessionId),
      turnId: event.turnId ? String(event.turnId) : undefined,
    });
    return null;
  }
  // eventStore 的 sequenceNumber 是内部全量账本，包含被协议过滤的
  // tool_input_delta 等高频模型中间态。ZCode Protocol 的 seq 是 UI/replay 的恢复键，
  // 必须按“协议实际可见事件流”重新连续编号，不能直接暴露内部 sequenceNumber。
  // sequenceNumber=0 的 subagent mirror/live-only 事件没有进入父 eventStore，也必须
  // 按 eventId 分配独立 seq，不能全部复用同一个 0 号映射。
  const protocolSeq = assignProtocolEventSeq(record, event, deliveryKind);
  const mappedEvent = mapSessionEventForProtocol(event, deliveryKind, {
    seq: protocolSeq,
  });
  if (!mappedEvent) {
    return null;
  }
  return omitDuplicateScheduledToolInput(
    event,
    mappedEvent,
    options.toolInputTransmissions ?? getProtocolToolInputTransmissionState(record, deliveryKind),
  );
}

export function activateSessionForResume(
  context: ZCodeProtocolAgentServerContext,
  params: ZCodeSessionResumeParams,
  options: { reusePersistedMessages?: boolean; persistedMessages?: MessageWithParts[] } = {},
): Promise<ResumeActivation> {
  let flights = resumeActivationFlights.get(context);
  if (!flights) {
    flights = new Map();
    resumeActivationFlights.set(context, flights);
  }
  const inFlight = flights.get(params.sessionId);
  if (inFlight) {
    context.logger?.debug("ZCode Protocol session resume joined in-flight activation", {
      event: "zcode_protocol.session.resume_joined",
      module: "bootstrap.zcode_protocol",
      sessionId: params.sessionId,
    });
    return inFlight;
  }
  const flight = activateSessionForResumeInner(context, params, options).finally(() => {
    if (flights.get(params.sessionId) === flight) {
      flights.delete(params.sessionId);
    }
  });
  flights.set(params.sessionId, flight);
  return flight;
}

export async function runCompactTurnInBackground(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  params: {
    abortController: AbortController;
    command: string;
    inputId?: string;
  },
): Promise<void> {
  const startedAt = Date.now();
  let mutationReason = "session_compacted";
  context.logger?.info("ZCode Protocol background compact started", {
    inputId: params.inputId,
    sessionId: record.app.sessionId,
    workspacePath: record.workspace.workspacePath,
  });
  try {
    await record.app.submitPrompt(params.command, {
      abortSignal: params.abortController.signal,
      inputId: params.inputId,
    });
    context.logger?.info("ZCode Protocol background compact completed", {
      durationMs: Date.now() - startedAt,
      inputId: params.inputId,
      sessionId: record.app.sessionId,
      workspacePath: record.workspace.workspacePath,
    });
  } catch (error) {
    mutationReason = params.abortController.signal.aborted
      ? "session_compact_cancelled"
      : "session_compact_failed";
    context.logger?.warn("ZCode Protocol background compact failed", {
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      inputId: params.inputId,
      sessionId: record.app.sessionId,
      workspacePath: record.workspace.workspacePath,
    });
  } finally {
    if (record.activeAbortController === params.abortController) {
      // compact 结束后必须先释放 active lock 再广播状态；否则 queued prompt
      // 或后续 `/compact` 会在 ready 边界短暂撞上旧 controller。
      record.activeAbortController = undefined;
    }
  }
  await afterStateMutation(context, record, mutationReason);
}

export async function runPromptTurnInBackground(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  params: {
    abortController: AbortController;
    intent?: SendInputOptions["intent"];
    modelExecution?: SendInputOptions["modelExecution"];
    attachments?: unknown[];
    browserAmbientContext?: {
      tabCount: number;
      currentUrl?: string;
    };
    inputId?: string;
    queryId?: QueryId;
    content: string;
    toolDenylist?: readonly string[];
    botDeliveryTarget?: ZCodeAutomationBotDeliveryTarget;
  } & TurnBackgroundAttribution,
): Promise<void> {
  const startedAt = Date.now();
  context.logger?.info("ZCode Protocol background turn started", {
    inputId: params.inputId,
    queryId: params.queryId,
    sessionId: record.app.sessionId,
    textLength: params.content.length,
    workspacePath: record.workspace.workspacePath,
  });
  let mutationReason = "prompt_completed";
  const previousAutomationId = record.activeAutomationId;
  const previousOffPeakTaskId = record.activeOffPeakTaskId;
  const previousBotDeliveryTarget = record.activeBotDeliveryTarget;
  const activeAutomationId = resolvePromptTurnAutomationId(params);
  const activeOffPeakTaskId = resolvePromptTurnOffPeakTaskId(params);
  const turnToolDisallowlist = buildPromptTurnToolDisallowlist(
    params,
    activeAutomationId,
    activeOffPeakTaskId,
  );
  if (activeAutomationId) {
    // 附件输入仍走旧 session/send；automation 派发可能漏传 automationId，
    // 但 inputId 会保留 automation-* runId。这里兜底标记，避免 CronCreate 在绑定 active
    // 会话里递归创建定时任务。
    record.activeAutomationId = activeAutomationId;
  }
  if (activeOffPeakTaskId) {
    // 闲时派发轮同型兜底标记，供 offpeak-port 拒绝递归 OffPeakCreate。
    record.activeOffPeakTaskId = activeOffPeakTaskId;
  }
  record.activeBotDeliveryTarget = params.botDeliveryTarget;
  try {
    const admission = await record.app.sendInput(
      {
        attachments: mapProtocolPromptAttachments(params.attachments),
        text: params.content,
      },
      {
        abortSignal: params.abortController.signal,
        intent: params.intent,
        modelExecution: params.modelExecution,
        browserAmbientContext: params.browserAmbientContext,
        inputId: params.inputId,
        queryId: params.queryId,
        ...(params.automationId
          ? { automationId: params.automationId }
          : params.offPeakTaskId
            ? {
                offPeakTaskId: params.offPeakTaskId,
                ...(params.offPeakRunType ? { offPeakRunType: params.offPeakRunType } : {}),
              }
            : {}),
        // legacy session/send 同样可能复用 active runtime；只做 port 拒绝时模型仍看得到
        // CronCreate，并可能在失败后改调 CronDelete。automation turn 与 cron task 会话后续输入
        // 都直接从本轮 provider 工具面移除。
        ...(turnToolDisallowlist ? { toolDisallowlist: turnToolDisallowlist } : {}),
      },
    );
    // admission 不是整轮结束。提前清理会丢失 automation 归属及 Stop controller；
    // ACK 已由 session/send 返回，后台只在真实 completion 后释放本轮资源。
    if (admission.kind === "rejected") {
      throw new ProtocolRequestError(-32010, `Prompt admission rejected: ${admission.reason}`);
    }
    if (admission.kind === "started_turn") await admission.completion;
    context.logger?.info("ZCode Protocol background turn completed", {
      durationMs: Date.now() - startedAt,
      inputId: params.inputId,
      queryId: params.queryId,
      sessionId: record.app.sessionId,
      workspacePath: record.workspace.workspacePath,
    });
  } catch (error) {
    mutationReason = "prompt_failed";
    context.logger?.warn("ZCode Protocol background turn failed", {
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      inputId: params.inputId,
      sessionId: record.app.sessionId,
      workspacePath: record.workspace.workspacePath,
    });
  } finally {
    if (record.activeAbortController === params.abortController) {
      // prompt_completed/prompt_failed 是下游 host queue 的 ready 边界。
      // 必须先释放 active lock 再广播状态，否则手机端收到 ready 后立刻 drain 会被
      // session/send 拒绝为 "A prompt is already running for this session"。
      record.activeAbortController = undefined;
      context.logger?.info("ZCode Protocol background turn cleared active controller", {
        durationMs: Date.now() - startedAt,
        inputId: params.inputId,
        sessionId: record.app.sessionId,
        workspacePath: record.workspace.workspacePath,
      });
    }
    record.activeAutomationId = previousAutomationId;
    record.activeOffPeakTaskId = previousOffPeakTaskId;
    // Bug 原因：legacy record 会跨 turn 复用；必须恢复 Bot 地址，避免后续普通 UI turn
    // 创建的定时任务错误继承上一轮 Bot 会话。
    record.activeBotDeliveryTarget = previousBotDeliveryTarget;
  }
  await afterStateMutation(context, record, mutationReason);
}

export async function runGoalContinuationInBackground(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  params: {
    abortController: AbortController;
    inputId?: string;
  },
): Promise<void> {
  let mutationReason = "goal_continuation_completed";
  try {
    await record.app.continueActiveTarget?.({
      abortSignal: params.abortController.signal,
      inputId: params.inputId,
    });
  } catch {
    mutationReason = "goal_continuation_failed";
  } finally {
    if (record.activeAbortController === params.abortController) {
      // 续跑本身结束后应立刻释放活跃锁；snapshot/command discovery 只是后续广播，
      // 如果继续占锁，连续 `/goal` 会被误判为已有活跃 turn。
      record.activeAbortController = undefined;
    }
  }
  await afterStateMutation(context, record, mutationReason);
}

export async function stopSession(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionStopParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  const hadActivePrompt = Boolean(record.activeAbortController);
  let pausedTarget: ProtocolGoalTarget | null = null;
  context.logger?.info("ZCode Protocol session/stop received", {
    hadActivePrompt,
    sessionId: params.sessionId,
    workspacePath: record.workspace.workspacePath,
  });
  if (hadActivePrompt) {
    pausedTarget = await pauseActiveGoalForSessionStop(context, record, {
      sessionId: params.sessionId,
    });
  }
  record.activeAbortController?.abort(new Error("ZCode Protocol session stopped"));
  if (pausedTarget) {
    await afterStateMutation(context, record, "session_stop_goal_paused");
  }
  return {};
}

export async function cancelBackgroundTask(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeSessionCancelBackgroundTaskParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  context.logger?.info("ZCode Protocol session/cancelBackgroundTask received", {
    sessionId: params.sessionId,
    taskId: params.taskId,
    workspacePath: record.workspace.workspacePath,
  });

  if (!record.app.cancelBackgroundTask) {
    throw new ProtocolRequestError(
      -32031,
      "Background task cancellation is not supported by this session runtime",
      {
        sessionId: params.sessionId,
        taskId: params.taskId,
      },
    );
  }

  const result = await record.app.cancelBackgroundTask(params.taskId);
  // 后台 bash 取消是运行态变更，不会经过普通 prompt 终态。
  // 取消后立即发 state.updated，让桌面 continuous 和手机 replayable 都通过各自 snapshot 边界刷新投影。
  await afterStateMutation(context, record, "background_task_cancelled");
  return result;
}

export async function setModel(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionSetModelParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  assertExpectedRevision(record, params.expectedRevision);
  await runSessionModelConfigMutation(record.app, async () => {
    // 完整 Session 配置命令不能经身份字符串丢掉 reasoning；由共享 setter 原子校验/保存。
    await record.app.setModel(params.model);
  });
  return await afterStateMutation(context, record, "model_changed");
}

export async function setThoughtLevel(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeSessionSetThoughtLevelParamsSchema, rawParams);
  if (!params.thoughtLevel) {
    throw new ProtocolRequestError(-32602, "thoughtLevel is required");
  }
  const thoughtLevel = params.thoughtLevel;
  const record = requireSession(context, params.sessionId);
  assertExpectedRevision(record, params.expectedRevision);
  await runSessionModelConfigMutation(record.app, async () => {
    await record.app.setThoughtLevel(thoughtLevel);
  });
  return await afterStateMutation(context, record, "thought_level_changed");
}

export async function setMode(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionSetModeParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  assertExpectedRevision(record, params.expectedRevision);
  await record.app.setMode(params.mode);
  return await afterStateMutation(context, record, "mode_changed");
}

export async function readSessionTargetCompletionVerificationEvents(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
): Promise<SessionEvent[]> {
  const sessionStore = context.deps.sessionStore;
  if (!sessionStore?.sessionEntries) {
    return [];
  }
  try {
    const entries = await sessionStore.sessionEntries({
      sessionID: record.app.sessionId as SessionId,
      type: SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
    });
    return entries
      .map((entry, index) =>
        sessionEntryToTargetCompletionVerificationEvent(entry, record.app.sessionId, index),
      )
      .filter((event): event is SessionEvent => event !== null);
  } catch (error) {
    // goal verifier timeline 是 UI 轮次的持久事实；读取失败时不能影响
    // session 主体恢复，但必须留下日志，否则冷启动后分组丢失很难排查。
    context.logger?.warn("Failed to read persisted goal verification entries", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "zcode_protocol.snapshot.goal_verification_entries_read_failed",
      sessionId: record.app.sessionId,
    });
    return [];
  }
}
