import type { ConversationTelemetryFact } from "@zcode/shared/zcode-protocol-v4";
import {
  legacyTelemetryModelValue,
  legacyTelemetryProviderId,
} from "@/lib/providerTelemetryIdentity.js";
import {
  activateDetachedAgentStepTelemetry,
  discardPromptTelemetry,
  recordAgentStepTelemetryEvent,
  recordPromptModelRequestStarted,
  recordPromptPermissionRequest,
  recordPromptPermissionResponse,
  recordSubagentToolAttribution,
} from "@/lib/messageTelemetry.js";
import {
  childAgentRole,
  childStepExtraDetail,
  mergeUsage,
  runtimeTelemetryModelName,
  scopedChildToolCallId,
  terminalOutcomeOf,
  terminalToolCallIdOf,
  toLegacyNetworkEvent,
  toToolLifecycleEvent,
  toUsage,
  type DetachedChildTerminalOutcome,
} from "@/v4/telemetry/supervisor/events.js";
import {
  enqueueReport,
  reportFinalizedSteps,
  withWorkspaceTelemetryDetail,
} from "@/v4/telemetry/supervisor/sending.js";
import { handleTerminal } from "@/v4/telemetry/supervisor/terminal.js";
import type {
  BackgroundSubagentTelemetry,
  FinalizedAgentStep,
  ForegroundSubagentUsage,
  SupervisorState,
} from "@/v4/telemetry/supervisor/state.js";

export function handleSubagentLifecycle(
  state: SupervisorState,
  fact: Extract<ConversationTelemetryFact, { kind: "subagent.lifecycle" }>,
  receivedAt: number,
): void {
  if (fact.phase === "spawned") {
    if (fact.background) {
      if (!fact.sourceCommandId || !fact.parentToolCallId) return;
      const parentLifecycle = state.lifecyclesByCommandId.get(fact.sourceCommandId);
      const child: BackgroundSubagentTelemetry = {
        kind: "background",
        parentSessionId: fact.sessionId,
        sourceCommandId: fact.sourceCommandId,
        parentToolCallId: fact.parentToolCallId,
        childSessionId: fact.childSessionId,
        agentId: fact.agentId,
        taskKey: state.taskKey(fact.childSessionId),
        // child 启动事实可能早于父消息 ACK；直接使用同源父会话事实，避免丢失开关。
        stepSourceDetail: parentLifecycle?.stepSourceDetail ?? {
          memory_enabled: fact.memoryEnabled === undefined ? "" : fact.memoryEnabled ? "1" : "0",
        },
        startedToolCallIds: new Set(),
        usageReported: false,
        openToolCallIds: new Set(),
        startedAt: state.now(),
        requestIds: [],
        requestCount: 0,
        usage: null,
        modelName: "",
        modelProvider: "",
        providerName: "",
      };
      state.backgroundSubagentTelemetryByChildSession.set(fact.childSessionId, child);
      activateDetachedAgentStepTelemetry({
        taskId: child.taskKey,
        messageId: child.sourceCommandId,
        sendTime: fact.occurredAt,
        extraDetail: child.stepSourceDetail,
      });
      return;
    }
    if (!fact.parentToolCallId) return;
    const parentCommandId = state.resolveCommandId(fact);
    if (!parentCommandId) return;
    const lifecycle = state.lifecyclesByCommandId.get(parentCommandId);
    if (!lifecycle?.active) return;
    const child: ForegroundSubagentUsage = {
      agentId: fact.agentId,
      parentCommandId,
      parentToolCallId: fact.parentToolCallId,
      requestIds: [],
      requestCount: 0,
      modelName: "",
      modelProvider: "",
      providerName: "",
      usage: null,
      stopped: false,
      pendingFinalizedSteps: [],
    };
    state.foregroundSubagentUsageByChildSession.set(fact.childSessionId, child);
    syncForegroundSubagentToolAttribution(state, child);
    return;
  }

  const backgroundChild = state.backgroundSubagentTelemetryByChildSession.get(fact.childSessionId);
  if (backgroundChild && fact.background) {
    reportBackgroundAgentUsage(state, backgroundChild, terminalOutcomeOf(fact), receivedAt);
    maybeCleanupBackgroundSubagentTelemetry(state, backgroundChild);
    return;
  }

  const child = state.foregroundSubagentUsageByChildSession.get(fact.childSessionId);
  if (!child) return;
  if (fact.background) {
    child.stopped = true;
    reportPendingForegroundSubagentSteps(state, child, false);
    flushDeferredTerminal(state, child.parentCommandId);
    return;
  }
  // mirror 与 lifecycle 分属不同 event stream，stopped 之后仍可能收到已发出的 child tool
  // 终态。保留映射到父 message 收口，保证迟到工具仍能取得 child model 与 agent_id。
  syncForegroundSubagentToolAttribution(state, child);
  child.stopped = true;
  const lifecycle = state.lifecyclesByCommandId.get(child.parentCommandId);
  if (lifecycle) lifecycle.hasForegroundSubagentResult = true;
  reportPendingForegroundSubagentSteps(state, child);
  flushDeferredTerminal(state, child.parentCommandId);
}

export function handleForegroundSubagentFact(
  state: SupervisorState,
  child: ForegroundSubagentUsage,
  fact: ConversationTelemetryFact,
): void {
  if (fact.kind === "model.request.status") {
    if (fact.status !== "model_request_started") return;
    child.modelName = runtimeTelemetryModelName(fact.providerId, fact.modelId);
    child.modelProvider = fact.providerId;
    child.providerName = fact.providerHostname ?? "";
    syncForegroundSubagentToolAttribution(state, child);
    return;
  }
  if (fact.kind !== "usage.delta") return;

  child.usage = mergeUsage(child.usage, toUsage(fact));
  child.requestCount += 1;
  if (fact.requestId && !child.requestIds.includes(fact.requestId)) {
    child.requestIds.push(fact.requestId);
  }
  // Subagent 的 runtime model 在一次同步 Agent 调用内固定；usage fact 的 request identity
  // 比 spawned 配置更接近真实 provider 请求，因此到达时覆盖前一请求的同源值。
  if (fact.providerId || fact.modelId) {
    child.modelName = runtimeTelemetryModelName(fact.providerId, fact.modelId);
    child.modelProvider = fact.providerId ?? child.modelProvider;
    child.providerName = fact.providerHostname ?? child.providerName;
  }
  syncForegroundSubagentToolAttribution(state, child);
}

export function syncForegroundSubagentToolAttribution(
  state: SupervisorState,
  child: ForegroundSubagentUsage,
): void {
  const lifecycle = state.lifecyclesByCommandId.get(child.parentCommandId);
  if (!lifecycle?.active) return;
  recordSubagentToolAttribution({
    taskId: lifecycle.taskKey,
    toolCallId: child.parentToolCallId,
    requestIds: child.requestIds,
    requestCount: child.requestCount,
    modelName: child.modelName,
    modelProvider: child.modelProvider,
    providerName: child.providerName,
    agentId: child.agentId,
    ...(child.usage ? { usage: child.usage } : {}),
  });
}

export function handleBackgroundSubagentFact(
  state: SupervisorState,
  child: BackgroundSubagentTelemetry,
  fact: ConversationTelemetryFact,
  receivedAt: number,
): void {
  switch (fact.kind) {
    case "model.request.status":
      if (child.usageReported) return;
      recordPromptModelRequestStarted(child.taskKey, toLegacyNetworkEvent(fact));
      if (fact.status === "model_request_started") {
        child.modelName = runtimeTelemetryModelName(fact.providerId, fact.modelId);
        child.modelProvider = fact.providerId;
        child.providerName = fact.providerHostname ?? "";
      }
      return;
    case "usage.delta": {
      if (child.usageReported) return;
      if (fact.requestId && child.requestIds.includes(fact.requestId)) return;
      if (fact.requestId) child.requestIds.push(fact.requestId);
      child.requestCount += 1;
      child.usage = mergeUsage(child.usage, toUsage(fact));
      if (fact.providerId || fact.modelId) {
        child.modelName = runtimeTelemetryModelName(fact.providerId, fact.modelId);
        child.modelProvider = fact.providerId ?? child.modelProvider;
        child.providerName = fact.providerHostname ?? child.providerName;
      }
      return;
    }
    case "stream.chunk":
      return;
    case "tool.lifecycle":
      handleBackgroundToolLifecycle(state, child, fact, receivedAt);
      return;
    case "permission.lifecycle": {
      if (child.usageReported && !child.openToolCallIds.has(fact.toolCallId)) return;
      const toolCallId = scopedChildToolCallId(child, fact.toolCallId);
      const requestId = fact.requestId ?? fact.toolCallId;
      if (fact.phase === "requested") {
        recordPromptPermissionRequest({
          taskId: child.taskKey,
          requestId,
          toolCallId,
          now: receivedAt,
        });
      } else {
        recordPromptPermissionResponse({
          taskId: child.taskKey,
          requestId,
          now: receivedAt,
        });
      }
      return;
    }
    case "turn.terminal":
      // 工作流子代理会话承接多次 ask，每次 ask 是一个 turn：这里的终态只是一次 ask 结束，
      // 汇总 step 等 run-settled。
      if (child.kind === "workflow") return;
      reportBackgroundAgentUsage(state, child, terminalOutcomeOf(fact), receivedAt);
      cleanupBackgroundSubagentTelemetry(state, child);
      return;
    case "turn.started":
    case "subagent.lifecycle":
    case "workflow.lifecycle":
    case "compaction.terminal":
      return;
  }
}

/**
 * 动态工作流子代理的登记与结算。与后台子代理共用同一本
 * detached 账本，差异只在登记事实、终态时机与 step 上的归属字段。
 */
export function handleWorkflowLifecycle(
  state: SupervisorState,
  fact: Extract<ConversationTelemetryFact, { kind: "workflow.lifecycle" }>,
  receivedAt: number,
): void {
  if (fact.phase === "actor-spawned") {
    // 缺锚点（升级前的 run）或缺子会话身份：不猜测归属，不上报。
    if (!fact.sourceCommandId || !fact.childSessionId || !fact.agentId) return;
    // resume 会再发一遍 actor-created；同一子会话的账本只建一次。
    if (state.backgroundSubagentTelemetryByChildSession.has(fact.childSessionId)) return;
    const parentLifecycle = state.lifecyclesByCommandId.get(fact.sourceCommandId);
    const child: BackgroundSubagentTelemetry = {
      kind: "workflow",
      runId: fact.runId,
      parentSessionId: fact.sessionId,
      sourceCommandId: fact.sourceCommandId,
      parentToolCallId: fact.toolCallId ?? "",
      childSessionId: fact.childSessionId,
      agentId: fact.agentId,
      taskKey: state.taskKey(fact.childSessionId),
      // child 启动事实可能早于父消息 ACK；直接使用同源父会话事实，避免丢失开关。
      stepSourceDetail: parentLifecycle?.stepSourceDetail ?? {
        memory_enabled: fact.memoryEnabled === undefined ? "" : fact.memoryEnabled ? "1" : "0",
      },
      startedToolCallIds: new Set(),
      usageReported: false,
      openToolCallIds: new Set(),
      startedAt: state.now(),
      requestIds: [],
      requestCount: 0,
      usage: null,
      modelName: "",
      modelProvider: "",
      providerName: "",
    };
    state.backgroundSubagentTelemetryByChildSession.set(fact.childSessionId, child);
    const siblings = state.workflowActorsByRun.get(fact.runId) ?? new Set<string>();
    siblings.add(fact.childSessionId);
    state.workflowActorsByRun.set(fact.runId, siblings);
    activateDetachedAgentStepTelemetry({
      taskId: child.taskKey,
      messageId: child.sourceCommandId,
      sendTime: fact.occurredAt,
      extraDetail: child.stepSourceDetail,
    });
    return;
  }

  // run-settled：该 run 全部子代理的终态。每个子代理一条汇总 step，然后排空迟到工具终态后清理。
  const actors = state.workflowActorsByRun.get(fact.runId);
  if (!actors) return;
  state.workflowActorsByRun.delete(fact.runId);
  for (const childSessionId of actors) {
    const child = state.backgroundSubagentTelemetryByChildSession.get(childSessionId);
    if (!child) continue;
    reportBackgroundAgentUsage(
      state,
      child,
      {
        eventId: fact.eventId,
        success: fact.status === "completed",
        ...(fact.errorMessage === undefined ? {} : { errorMessage: fact.errorMessage }),
      },
      receivedAt,
    );
    maybeCleanupBackgroundSubagentTelemetry(state, child);
  }
}

export function reportBackgroundAgentUsage(
  state: SupervisorState,
  child: BackgroundSubagentTelemetry,
  outcome: DetachedChildTerminalOutcome,
  receivedAt: number,
): void {
  // Bug 根因：只等 child terminal 会漏掉准备阶段失败/取消；stopped 也必须结算。
  // 对齐 foreground 的已知 usage 快照：首个终态只报一次，后续不补算迟到 usage。
  if (child.usageReported) return;
  child.usageReported = true;
  // 无 usage 不代表调用未发生；真实终态仍上报，缺失 token 沿用 foreground builder 的零值。
  const toolId = scopedChildToolCallId(child, terminalToolCallIdOf(child));
  // Bug 根因：后台只报内部工具并丢弃 usage，缺少 foreground 外层 Agent 的 token owner。
  // 在 child 终态用共享 builder 结算一次；内部工具继续逐条上报，避免重复计算同一份 token。
  recordAgentStepTelemetryEvent({
    taskId: child.taskKey,
    event: {
      type: "tool_call",
      taskId: child.childSessionId,
      traceId: outcome.eventId,
      toolId,
      toolName: "Agent",
      kind: "Agent",
      input: {},
      title: "Agent",
      raw: {},
    },
    now: child.startedAt,
  });
  recordSubagentToolAttribution({
    taskId: child.taskKey,
    toolCallId: toolId,
    agentId: child.agentId,
    agentRole: childAgentRole(child),
    requestIds: child.requestIds,
    requestCount: child.requestCount,
    modelName: child.modelName,
    modelProvider: child.modelProvider,
    providerName: child.providerName,
    ...(child.usage ? { usage: child.usage } : {}),
  });
  const finalized = recordAgentStepTelemetryEvent({
    taskId: child.taskKey,
    event: {
      type: "tool_call_update",
      taskId: child.childSessionId,
      traceId: outcome.eventId,
      toolId,
      toolName: "Agent",
      kind: "Agent",
      raw: {},
      status: outcome.success ? "completed" : "failed",
      error: outcome.errorMessage,
    },
    now: receivedAt,
  });
  reportBackgroundFinalizedSteps(state, child, finalized, childStepExtraDetail(child));
}

export function handleBackgroundToolLifecycle(
  state: SupervisorState,
  child: BackgroundSubagentTelemetry,
  fact: Extract<ConversationTelemetryFact, { kind: "tool.lifecycle" }>,
  receivedAt: number,
): void {
  // stopped 后仅排空已经开始的工具，避免重放/迟到事件重新创建已收口的 step。
  if (child.usageReported && !child.openToolCallIds.has(fact.toolCallId)) return;
  const hasStarted = child.startedToolCallIds.has(fact.toolCallId);
  child.startedToolCallIds.add(fact.toolCallId);
  const isTerminal = fact.phase === "completed" || fact.phase === "failed";
  if (isTerminal) {
    child.openToolCallIds.delete(fact.toolCallId);
  } else {
    child.openToolCallIds.add(fact.toolCallId);
  }
  const finalized = recordAgentStepTelemetryEvent({
    taskId: child.taskKey,
    event: toToolLifecycleEvent({
      fact,
      toolId: scopedChildToolCallId(child, fact.toolCallId),
      hasStarted,
    }),
    clientMode: "desktop-continuous",
    toolAttribution: {
      agentId: child.agentId,
      agentRole: childAgentRole(child),
    },
    now: receivedAt,
  });
  const extraDetail = {
    ...childStepExtraDetail(child),
    ...(fact.automationId ? { automation_id: fact.automationId } : {}),
  };
  reportBackgroundFinalizedSteps(state, child, finalized, extraDetail);
  if (isTerminal) maybeCleanupBackgroundSubagentTelemetry(state, child);
}

export function reportBackgroundFinalizedSteps(
  state: SupervisorState,
  child: BackgroundSubagentTelemetry,
  finalized: FinalizedAgentStep[],
  extraDetail: Record<string, string>,
): void {
  for (const step of finalized) {
    enqueueReport(state, {
      elementName: "agent_step",
      eventRegion: "app",
      eventType: "agent_trace",
      eventExtraDetail: withWorkspaceTelemetryDetail(state, {
        ...child.stepSourceDetail,
        ...step.eventExtraDetail,
        ...extraDetail,
      }),
      talkId: child.parentSessionId,
      messageId: child.sourceCommandId,
    });
  }
}

export function cleanupBackgroundSubagentTelemetry(
  state: SupervisorState,
  child: BackgroundSubagentTelemetry,
): void {
  discardPromptTelemetry(child.taskKey);
  state.backgroundSubagentTelemetryByChildSession.delete(child.childSessionId);
}

export function maybeCleanupBackgroundSubagentTelemetry(
  state: SupervisorState,
  child: BackgroundSubagentTelemetry,
): void {
  // 汇总上报与工具排空分开：stopped 不再丢汇总，也不丢已开始工具的迟到终态。
  if (child.usageReported && child.openToolCallIds.size === 0) {
    cleanupBackgroundSubagentTelemetry(state, child);
  }
}

export function reportPendingForegroundSubagentSteps(
  state: SupervisorState,
  child: ForegroundSubagentUsage,
  applyAttribution = true,
): void {
  const lifecycle = state.lifecyclesByCommandId.get(child.parentCommandId);
  if (!lifecycle?.active) return;
  for (const pending of child.pendingFinalizedSteps.splice(0)) {
    if (applyAttribution) applyForegroundSubagentAttribution(pending.step, child);
    reportFinalizedSteps(state, lifecycle, [pending.step], pending.extraDetail);
  }
}

export function applyForegroundSubagentAttribution(
  step: FinalizedAgentStep,
  child: ForegroundSubagentUsage,
): void {
  const detail = step.eventExtraDetail;
  detail.agent_id = child.agentId;
  if (child.modelName || child.modelProvider || child.providerName) {
    detail.model_name = legacyTelemetryModelValue(child.modelName);
    detail.model_provider = legacyTelemetryProviderId(child.modelProvider);
    detail.provider_name = child.providerName;
  }
  if (!child.usage) return;
  detail.model_request_id = child.requestIds.length === 1 ? (child.requestIds[0] ?? "") : "";
  detail.model_request_count = String(child.requestCount);
  detail.token_usage_scope = "subagent_requests";
  detail.input_tokens = String(child.usage.inputTokens);
  detail.output_tokens = String(child.usage.outputTokens);
  detail.reasoning_tokens = String(child.usage.reasoningTokens ?? 0);
  detail.cached_tokens = String(child.usage.cachedInputTokens ?? 0);
  detail.cache_write_input_tokens = String(child.usage.cachedWriteInputTokens ?? 0);
  detail.total_tokens = String(child.usage.totalTokens);
}

export function flushDeferredTerminal(state: SupervisorState, commandId: string): void {
  const deferred = state.deferredTerminalsByCommandId.get(commandId);
  if (
    !deferred ||
    [...state.foregroundSubagentUsageByChildSession.values()].some(
      (child) => child.parentCommandId === commandId && !child.stopped,
    )
  ) {
    return;
  }
  state.deferredTerminalsByCommandId.delete(commandId);
  handleTerminal(
    state,
    deferred.lifecycle,
    deferred.fact,
    deferred.receivedAt,
    deferred.foregroundAtReceipt,
  );
}

export function shouldIgnoreBackgroundMirror(
  state: SupervisorState,
  fact: ConversationTelemetryFact,
): boolean {
  if (fact.kind !== "tool.lifecycle" && fact.kind !== "permission.lifecycle") return false;
  return (
    fact.background === true &&
    (!fact.childSessionId || !state.foregroundSubagentUsageByChildSession.has(fact.childSessionId))
  );
}
