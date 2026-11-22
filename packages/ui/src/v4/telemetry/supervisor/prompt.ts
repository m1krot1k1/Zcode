import type { ZCodeContextCompactionTimelineMeta, ZCodeStreamEvent } from "@zcode/shared";
import type { ConversationTelemetryFact } from "@zcode/shared/zcode-protocol-v4";
import {
  activatePromptTelemetry,
  buildCompactionTelemetryExtraDetail,
  discardQueuedPromptTelemetry,
  getActivePromptMessageId,
  getActivePromptModelName,
  queuePromptTelemetry,
  recordAgentStepTelemetryEvent,
  recordPromptModelRequestStarted,
  recordPromptPermissionRequest,
  recordPromptPermissionResponse,
  recordPromptTokenUsageDelta,
} from "@/lib/messageTelemetry.js";
import { reportPlanUsageModelRequestStartedToArms } from "@/lib/planUsageArmsTelemetry.js";
import {
  clearStreamStallTracking,
  recordStreamChunkArrival,
  reportUiToolCallDetail,
} from "@/lib/uiPerfArmsTelemetry.js";
import { resolveLegacyRuntimeModelValue } from "@/v4/telemetry/conversationPromptTelemetry.js";
import {
  MAX_DEDUPE_KEYS,
  bufferFact,
  drainPendingFacts,
  hasDeferredTerminalForTask,
} from "@/v4/telemetry/supervisor/budgets.js";
import {
  backgroundSeedFromTurnStarted,
  isToolTimeout,
  mergeUsage,
  runtimeTelemetryModelName,
  stepSourceDetailOf,
  toLegacyNetworkEvent,
  toToolLifecycleEvent,
  toUsage,
} from "@/v4/telemetry/supervisor/events.js";
import { enqueueReport, reportFinalizedSteps } from "@/v4/telemetry/supervisor/sending.js";
import {
  applyForegroundSubagentAttribution,
  flushDeferredTerminal,
  handleBackgroundSubagentFact,
  handleForegroundSubagentFact,
  handleSubagentLifecycle,
  handleWorkflowLifecycle,
  shouldIgnoreBackgroundMirror,
} from "@/v4/telemetry/supervisor/subagents.js";
import type {
  AcceptedConversationPromptTelemetrySeed,
  FinalizedAgentStep,
  PromptLifecycle,
  SupervisorState,
} from "@/v4/telemetry/supervisor/state.js";
import { handleTerminal } from "@/v4/telemetry/supervisor/terminal.js";

export function handleFact(state: SupervisorState, fact: ConversationTelemetryFact): void {
  // 主 session 与 detached child 的 eventId 都只保证各自 session 内唯一；
  // 若只按 eventId 去重，同号 child fact 会在 renderer 再次被主会话事实误杀。
  const eventKey = `${fact.sessionId}\0${fact.eventId}`;
  if (state.disposed || !state.eventIds.remember(eventKey)) {
    return;
  }
  const receivedAt = state.now();
  const foregroundAtReceipt = state.isForeground(fact.sessionId);

  // plan_request 只依赖真实模型网络事实，可前后台上报，也不要求本地 prompt seed。
  if (fact.kind === "model.request.status") {
    reportPlanUsageModelRequestStartedToArms(state.platform, toLegacyNetworkEvent(fact));
  }
  if (fact.kind === "subagent.lifecycle") {
    handleSubagentLifecycle(state, fact, receivedAt);
    return;
  }
  if (fact.kind === "workflow.lifecycle") {
    handleWorkflowLifecycle(state, fact, receivedAt);
    return;
  }
  const backgroundSubagent = state.backgroundSubagentTelemetryByChildSession.get(fact.sessionId);
  if (backgroundSubagent) {
    handleBackgroundSubagentFact(state, backgroundSubagent, fact, receivedAt);
    return;
  }
  if (shouldIgnoreBackgroundMirror(state, fact)) {
    return;
  }
  const foregroundSubagent = state.foregroundSubagentUsageByChildSession.get(fact.sessionId);
  if (foregroundSubagent) {
    handleForegroundSubagentFact(state, foregroundSubagent, fact);
    return;
  }
  // Вложенный агент (`start` → `orchestrator`): его spawn не привязан к lifecycle этого
  // renderer, но usage.delta всё равно должен питать живое дерево токенов.
  const nestedSubagent = state.nestedSubagentUsageByChildSession.get(fact.sessionId);
  if (nestedSubagent) {
    if (fact.kind === "usage.delta") {
      nestedSubagent.requestCount += 1;
      nestedSubagent.usage = mergeUsage(nestedSubagent.usage, toUsage(fact));
      if (fact.requestId && !nestedSubagent.requestIds.includes(fact.requestId)) {
        nestedSubagent.requestIds.push(fact.requestId);
      }
      state.onSubagentUsageChanged?.(
        fact.sessionId,
        nestedSubagent.usage,
        nestedSubagent.parentSessionId,
      );
    } else if (fact.kind === "turn.terminal") {
      // Запись сохраняется: поздние факты той же child-сессии не должны попасть
      // в buffer неизвестной команды; dispose очистит её вместе с supervisor.
      state.onSubagentUsageChanged?.(fact.sessionId, null, nestedSubagent.parentSessionId);
    }
    return;
  }
  if (fact.kind === "compaction.terminal") {
    handleCompaction(state, fact, foregroundAtReceipt);
    return;
  }
  if (fact.kind === "turn.started") {
    const backgroundSeed = backgroundSeedFromTurnStarted(fact);
    if (backgroundSeed) {
      // 原因：后台任务不经过 renderer ACK；用 Host admission 透传的无正文事实建 seed，
      // 但不能伪造只代表用户点击的 send_btn。
      acceptPromptSeed(
        state,
        { ...backgroundSeed, memoryEnabled: fact.memoryEnabled },
        { reportSendButton: false },
      );
    }
  }

  const commandId = state.resolveCommandId(fact);
  if (!commandId) {
    return;
  }
  const lifecycle = state.lifecyclesByCommandId.get(commandId);
  const blockedByDeferredTerminal =
    lifecycle !== undefined &&
    fact.kind === "turn.started" &&
    hasDeferredTerminalForTask(state, lifecycle.taskKey, lifecycle.sourceCommandId);
  if (
    !lifecycle ||
    blockedByDeferredTerminal ||
    (!lifecycle.active && fact.kind !== "turn.started")
  ) {
    bufferFact(state, commandId, { fact, receivedAt, foregroundAtReceipt });
    return;
  }
  processPromptFact(state, lifecycle, fact, receivedAt, foregroundAtReceipt);
  if (fact.kind === "turn.started") {
    drainPendingFacts(state, commandId);
  }
}

/** ACK=accepted 后才建立 seed；duplicate/retry/promotion 不会重复上报 send_btn。 */
export function acceptPromptSeed(
  state: SupervisorState,
  seed: AcceptedConversationPromptTelemetrySeed,
  options: { reportSendButton?: boolean } = {},
): void {
  if (state.disposed || !state.acceptedCommandIds.remember(seed.sourceCommandId)) {
    return;
  }
  const taskKey = state.taskKey(seed.sessionId);
  const extraDetail = {
    ...seed.extraDetail,
    memory_enabled: seed.memoryEnabled === undefined ? "" : seed.memoryEnabled ? "1" : "0",
  };
  const eventExtraDetail = queuePromptTelemetry({
    workspacePath: state.workspaceScopeKey,
    taskId: taskKey,
    messageId: seed.sourceCommandId,
    sendTime: seed.sendTime,
    extraDetail,
  });
  state.lifecyclesByCommandId.set(seed.sourceCommandId, {
    sessionId: seed.sessionId,
    sourceCommandId: seed.sourceCommandId,
    taskKey,
    sendTime: seed.sendTime,
    foregroundFirstTokenAt: null,
    legacyFirstTokenObserved: false,
    active: false,
    completionMessageSource: seed.completionMessageSource,
    hasForegroundSubagentResult: false,
    hasBackgroundSubagentResult: false,
    hasWorkflowResult: false,
    startedToolCallIds: new Set(),
    stepSourceDetail: stepSourceDetailOf(extraDetail),
  });
  if (state.lifecyclesByCommandId.size > MAX_DEDUPE_KEYS) {
    const oldestInactive = [...state.lifecyclesByCommandId].find(
      ([commandId, lifecycle]) => commandId !== seed.sourceCommandId && !lifecycle.active,
    );
    if (oldestInactive) {
      state.lifecyclesByCommandId.delete(oldestInactive[0]);
      discardQueuedPromptTelemetry(oldestInactive[1].taskKey, oldestInactive[1].sourceCommandId);
    }
  }
  if (options.reportSendButton !== false) {
    enqueueReport(state, {
      elementName: "send_btn",
      eventRegion: "app",
      eventType: "ck",
      eventExtraDetail,
      talkId: seed.sessionId,
      messageId: seed.sourceCommandId,
    });
  }
  drainPendingFacts(state, seed.sourceCommandId);
}

export function processPromptFact(
  state: SupervisorState,
  lifecycle: PromptLifecycle,
  fact: ConversationTelemetryFact,
  receivedAt: number,
  foregroundAtReceipt: boolean,
): void {
  switch (fact.kind) {
    case "turn.started":
      lifecycle.active = true;
      lifecycle.turnId = fact.turnId;
      state.activeCommandBySessionId.set(fact.sessionId, lifecycle.sourceCommandId);
      if (fact.turnId) {
        state.commandIdByTurnKey.set(
          `${fact.sessionId}\u0000${fact.turnId}`,
          lifecycle.sourceCommandId,
        );
      }
      activatePromptTelemetry(lifecycle.taskKey, lifecycle.sourceCommandId);
      return;

    case "model.request.status": {
      const legacyEvent = toLegacyNetworkEvent(fact);
      recordPromptModelRequestStarted(lifecycle.taskKey, legacyEvent, lifecycle.sourceCommandId);
      if (fact.status === "model_request_failed") {
        lifecycle.lastErrorMessage = fact.reason;
      }
      return;
    }

    case "stream.chunk": {
      lifecycle.legacyFirstTokenObserved = true;
      if (foregroundAtReceipt && lifecycle.foregroundFirstTokenAt === null) {
        lifecycle.foregroundFirstTokenAt = receivedAt;
      }
      const legacyEvent = {
        type: fact.channel === "thought" ? "agent_thought_chunk" : "agent_message_chunk",
        taskId: fact.sessionId,
        traceId: fact.eventId,
        inputId: lifecycle.sourceCommandId,
        content: "",
        ...(fact.channel === "text" && fact.assistantMessageId
          ? { messageId: fact.assistantMessageId }
          : {}),
        ...(fact.parentToolCallId ? { parentToolUseId: fact.parentToolCallId } : {}),
      } as Extract<ZCodeStreamEvent, { type: "agent_thought_chunk" | "agent_message_chunk" }>;
      reportFinalizedSteps(
        state,
        lifecycle,
        recordAgentStepTelemetryEvent({
          taskId: lifecycle.taskKey,
          event: legacyEvent,
          activeInputId: lifecycle.sourceCommandId,
          clientMode: "desktop-continuous",
          now: receivedAt,
        }),
      );
      if (foregroundAtReceipt) {
        recordStreamChunkArrival(lifecycle.taskKey, {
          now: receivedAt,
          talkId: fact.sessionId,
          waitingTool: false,
          model: getActivePromptModelName(lifecycle.taskKey),
          messageId: fact.assistantMessageId,
          chunkType: fact.channel === "thought" ? "thought" : "message",
        });
      }
      return;
    }

    case "tool.lifecycle":
      handleToolLifecycle(state, lifecycle, fact, receivedAt, foregroundAtReceipt);
      return;

    case "permission.lifecycle": {
      const requestId = fact.requestId ?? fact.toolCallId;
      if (fact.phase === "requested") {
        recordPromptPermissionRequest({
          taskId: lifecycle.taskKey,
          requestId,
          toolCallId: fact.toolCallId,
          now: receivedAt,
        });
      } else {
        recordPromptPermissionResponse({
          taskId: lifecycle.taskKey,
          requestId,
          now: receivedAt,
        });
      }
      return;
    }

    case "usage.delta":
      recordPromptTokenUsageDelta({
        taskId: lifecycle.taskKey,
        eventKey: fact.eventId,
        usage: toUsage(fact),
        requestId: fact.requestId,
        modelName: runtimeTelemetryModelName(fact.providerId, fact.modelId),
        modelProvider: fact.providerId,
        providerName: fact.providerHostname,
      });
      return;

    case "turn.terminal":
      // active-loop 没有独立 TurnStarted；消费事实随终态到达后再更新本轮 composition。
      if (fact.backgroundSubagentResultConsumed) {
        lifecycle.hasBackgroundSubagentResult = true;
      }
      if (fact.workflowResultConsumed) {
        lifecycle.hasWorkflowResult = true;
      }
      handleTerminal(state, lifecycle, fact, receivedAt, foregroundAtReceipt);
      return;

    case "compaction.terminal":
    case "workflow.lifecycle":
      return;
  }
}

export function handleToolLifecycle(
  state: SupervisorState,
  lifecycle: PromptLifecycle,
  fact: Extract<ConversationTelemetryFact, { kind: "tool.lifecycle" }>,
  receivedAt: number,
  foregroundAtReceipt: boolean,
): void {
  lifecycle.legacyFirstTokenObserved = true;
  if (foregroundAtReceipt && lifecycle.foregroundFirstTokenAt === null) {
    lifecycle.foregroundFirstTokenAt = receivedAt;
  }
  clearStreamStallTracking(lifecycle.taskKey);
  const child =
    fact.childSessionId !== undefined
      ? state.foregroundSubagentUsageByChildSession.get(fact.childSessionId)
      : undefined;
  const agentId = fact.agentId ?? child?.agentId;
  const toolAttribution =
    agentId || child
      ? {
          ...(agentId ? { agentId } : {}),
          ...(child?.modelName ? { modelName: child.modelName } : {}),
          ...(child?.modelProvider ? { modelProvider: child.modelProvider } : {}),
          ...(child?.providerName ? { providerName: child.providerName } : {}),
        }
      : undefined;
  const hasStarted = lifecycle.startedToolCallIds.has(fact.toolCallId);
  lifecycle.startedToolCallIds.add(fact.toolCallId);
  const event = toToolLifecycleEvent({
    fact,
    toolId: fact.toolCallId,
    inputId: lifecycle.sourceCommandId,
    hasStarted,
  });
  const finalized = recordAgentStepTelemetryEvent({
    taskId: lifecycle.taskKey,
    event,
    activeInputId: lifecycle.sourceCommandId,
    clientMode: "desktop-continuous",
    ...(toolAttribution ? { toolAttribution } : {}),
    now: receivedAt,
  });
  const extraDetail = fact.automationId ? { automation_id: fact.automationId } : undefined;
  const isTerminal = fact.phase === "completed" || fact.phase === "failed";
  const foregroundChild = isTerminal
    ? [...state.foregroundSubagentUsageByChildSession.values()].find(
        (candidate) =>
          candidate.parentCommandId === lifecycle.sourceCommandId &&
          candidate.parentToolCallId === fact.toolCallId,
      )
    : undefined;
  if (foregroundChild && !foregroundChild.stopped) {
    const timeoutWon = isToolTimeout(fact);
    const immediate: FinalizedAgentStep[] = [];
    for (const step of finalized) {
      if (step.eventExtraDetail.tool_call_id === fact.toolCallId) {
        if (timeoutWon) {
          applyForegroundSubagentAttribution(step, foregroundChild);
          immediate.push(step);
        } else {
          // Bug 根因：父 Agent 工具终态可能早于 child usage。非 timeout 终态继续冻结，
          // 等 Runtime 的 SubagentStopped 后以 child 最终累计值回填，避免丢 token。
          foregroundChild.pendingFinalizedSteps.push({ step, extraDetail });
        }
      } else {
        immediate.push(step);
      }
    }
    reportFinalizedSteps(state, lifecycle, immediate, extraDetail);
    if (timeoutWon) {
      // 外层 Agent timeout 是 Runtime 的真实终态；与 SubagentStopped 谁先到谁收口，
      // 不再额外等待 telemetry grace，迟到 stopped 只会命中已完成生命周期。
      foregroundChild.stopped = true;
      flushDeferredTerminal(state, foregroundChild.parentCommandId);
    }
  } else {
    reportFinalizedSteps(state, lifecycle, finalized, extraDetail);
  }
  if (fact.errorMessage) lifecycle.lastErrorMessage = fact.errorMessage;

  const performance = fact.performance;
  if (
    !foregroundAtReceipt ||
    !isTerminal ||
    !performance ||
    Object.keys(performance).length === 0
  ) {
    return;
  }
  reportUiToolCallDetail({
    toolName: fact.toolName,
    status: fact.phase === "completed" ? "completed" : "failed",
    talkId: fact.sessionId,
    messageId: getActivePromptMessageId(lifecycle.taskKey),
    toolCallId: fact.toolCallId,
    parentToolCallId: fact.parentToolCallId,
    childSessionId: fact.childSessionId,
    childToolCallId: fact.childToolCallId,
    agentId: fact.agentId,
    agentType: fact.agentType,
    totalMs: performance.totalMs ?? fact.durationMs,
    permissionWaitMs: performance.permissionWaitMs,
    commandRunMs: performance.commandRunMs,
    firstOutputMs: performance.firstOutputMs,
    noOutputMs: performance.noOutputMs,
    exitCode: performance.exitCode,
    timedOut: performance.timedOut,
    outputBytes: performance.outputBytes,
    commandCategory: performance.commandCategory,
    commandName: performance.commandName,
    commandCount: performance.commandCount,
    commandStatus: performance.commandStatus,
    fsReadMs: performance.fsReadMs,
    fsWriteMs: performance.fsWriteMs,
    patchMatchMs: performance.patchMatchMs,
    fileCount: performance.fileCount,
    totalBytes: performance.totalBytes,
    maxFileBytes: performance.maxFileBytes,
    hunkCount: performance.hunkCount,
    matchAttempts: performance.matchAttempts,
    workspaceKind: performance.workspaceKind,
  });
}

export function handleCompaction(
  state: SupervisorState,
  fact: Extract<ConversationTelemetryFact, { kind: "compaction.terminal" }>,
  foregroundAtReceipt: boolean,
): void {
  const dedupeKey = `${fact.sessionId}\u0000${fact.operationId}\u0000context_compaction`;
  if (!state.compactionKeys.remember(dedupeKey)) return;
  // compaction 只按 terminal 到达瞬间是否前台决定；后台到达后切回不能补报。
  if (!foregroundAtReceipt) return;
  const timeline: ZCodeContextCompactionTimelineMeta = {
    version: 1,
    kind: "synthetic",
    type: "context_compaction",
    operationId: fact.operationId,
    status: fact.status,
    trigger: fact.trigger,
    display: "separator",
    reason: fact.reason,
    summaryMessageId: fact.summaryMessageId,
    preCompactTokenCount: fact.preCompactTokenCount,
    postCompactTokenCount: fact.postCompactTokenCount,
    truePostCompactTokenCount: fact.truePostCompactTokenCount,
    attempt: fact.attempt,
    maxAttempts: fact.maxAttempts,
    startedAt: fact.startedAt,
    endedAt: fact.endedAt,
  };
  const eventExtraDetail = buildCompactionTelemetryExtraDetail({
    timeline,
    modelName: resolveLegacyRuntimeModelValue({
      configProvider: fact.modelProvider,
      modelName: fact.modelName,
    }),
    modelProvider: fact.modelProvider,
  });
  if (!eventExtraDetail) return;
  enqueueReport(state, {
    elementName: "context_compaction",
    eventRegion: "app",
    eventType: "agent_trace",
    eventExtraDetail,
    talkId: fact.sessionId,
    messageId: fact.summaryMessageId ?? fact.operationId,
  });
}
