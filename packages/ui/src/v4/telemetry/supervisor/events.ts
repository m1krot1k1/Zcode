import type { ZCodeStreamEvent, ZCodeUsage } from "@zcode/shared";
import type { ConversationTelemetryFact } from "@zcode/shared/zcode-protocol-v4";
import type { AgentStepRole } from "@/lib/messageTelemetry.js";
import type {
  AcceptedConversationPromptTelemetrySeed,
  BackgroundSubagentTelemetry,
} from "@/v4/telemetry/supervisor/state.js";

export function backgroundSeedFromTurnStarted(
  fact: Extract<ConversationTelemetryFact, { kind: "turn.started" }>,
): AcceptedConversationPromptTelemetrySeed | null {
  if (!fact.sourceCommandId) return null;
  if (fact.offPeakTaskId) {
    return {
      sessionId: fact.sessionId,
      sourceCommandId: fact.sourceCommandId,
      sendTime: fact.occurredAt,
      extraDetail: {
        message_source: "off_peak_task",
        off_peak_task_id: fact.offPeakTaskId,
        ...(fact.offPeakRunType ? { off_peak_run_type: fact.offPeakRunType } : {}),
      },
    };
  }
  if (!fact.automationId || !fact.taskTrigger) {
    if (fact.inputSource !== "background_task") return null;
    return {
      sessionId: fact.sessionId,
      sourceCommandId: fact.sourceCommandId,
      sendTime: fact.occurredAt,
      extraDetail: { message_source: "background_task" },
      ...(fact.backgroundSource === "subagent"
        ? { completionMessageSource: "background_subagent" as const }
        : fact.backgroundSource === "workflow"
          ? { completionMessageSource: "background_workflow" as const }
          : {}),
    };
  }
  const scheduledAt = fact.taskTrigger === "schedule" ? fact.scheduledAt : undefined;
  return {
    sessionId: fact.sessionId,
    sourceCommandId: fact.sourceCommandId,
    sendTime: fact.occurredAt,
    extraDetail: {
      message_source: "scheduled_task",
      task_trigger: fact.taskTrigger,
      automation_id: fact.automationId,
      ...(scheduledAt !== undefined
        ? {
            scheduled_at: String(scheduledAt),
            schedule_lag_ms: String(Math.max(0, fact.occurredAt - scheduledAt)),
          }
        : {}),
    },
  };
}

/**
 * 冻结到每条 agent_step 的来源字段（与 completion 同值）。只挑来源归因字段：seed 里的模型/套餐
 * 维度不属于 step 契约，scheduled_at / schedule_lag_ms 描述整次运行、只随 completion 上报。
 */
const STEP_SOURCE_DETAIL_KEYS = [
  "memory_enabled",
  "message_source",
  "task_trigger",
  "automation_id",
  "off_peak_task_id",
  "off_peak_run_type",
] as const;

export function stepSourceDetailOf(extraDetail: Record<string, string>): Record<string, string> {
  const detail: Record<string, string> = {};
  for (const key of STEP_SOURCE_DETAIL_KEYS) {
    const value = extraDetail[key];
    if (value !== undefined) detail[key] = value;
  }
  return detail;
}

export function toLegacyNetworkEvent(
  fact: Extract<ConversationTelemetryFact, { kind: "model.request.status" }>,
): Extract<ZCodeStreamEvent, { type: "task_network_debug_status" }> {
  return {
    type: "task_network_debug_status",
    taskId: fact.sessionId,
    traceId: fact.eventId,
    ...(fact.sourceCommandId ? { inputId: fact.sourceCommandId } : {}),
    ...(fact.queryId ? { queryId: fact.queryId } : {}),
    eventKey: fact.eventId,
    eventId: fact.eventId,
    statusType: fact.status,
    requestId: fact.requestId,
    providerId: fact.providerId,
    modelId: fact.modelId,
    providerKind: fact.providerKind,
    transport: fact.transport,
    // messageTelemetry 的旧入口只接受 baseURL；fact 已提前裁成 hostname，重新包装不扩大隐私面。
    baseURL: fact.providerHostname ? `https://${fact.providerHostname}` : undefined,
    querySource: fact.querySource,
    attempt: fact.attempt,
    maxAttempts: fact.maxAttempts,
    nextAttempt: fact.nextAttempt,
    retryable: fact.retryable,
    statusCode: fact.statusCode,
    durationMs: fact.durationMs,
    delayMs: fact.delayMs,
    idleMs: fact.idleMs,
    timeoutMs: fact.timeoutMs,
    reason: fact.reason,
    requestHeaders: {},
    responseHeaders: {},
    requestHeaderCount: 0,
    responseHeaderCount: 0,
  } as Extract<ZCodeStreamEvent, { type: "task_network_debug_status" }>;
}

function scopedSubagentToolCallId(agentId: string, childToolCallId: string): string {
  return `tool_subagent_${agentId}_${childToolCallId}`;
}

/** detached 子会话的 step 用来源前缀区分：Agent 工具子代理 `tool_subagent_`，工作流子代理 `tool_workflow_`。 */
export function scopedChildToolCallId(
  child: BackgroundSubagentTelemetry,
  childToolCallId: string,
): string {
  return child.kind === "workflow"
    ? `tool_workflow_${child.agentId}_${childToolCallId}`
    : scopedSubagentToolCallId(child.agentId, childToolCallId);
}

/** 终态汇总 step 的收尾 id：后台子代理是父 Agent 工具调用，工作流子代理是 run。 */
export function terminalToolCallIdOf(child: BackgroundSubagentTelemetry): string {
  return child.kind === "workflow"
    ? (child.runId ?? child.parentToolCallId)
    : child.parentToolCallId;
}

export function childAgentRole(child: BackgroundSubagentTelemetry): AgentStepRole {
  return child.kind === "workflow" ? "workflow subagent" : "background subagent";
}

/** step 上的归属字段。 */
export function childStepExtraDetail(child: BackgroundSubagentTelemetry): Record<string, string> {
  if (child.kind === "workflow") {
    return {
      child_session_id: child.childSessionId,
      ...(child.runId === undefined ? {} : { workflow_run_id: child.runId }),
      ...(child.parentToolCallId === "" ? {} : { workflow_tool_call_id: child.parentToolCallId }),
    };
  }
  return {
    child_session_id: child.childSessionId,
    parent_tool_call_id: child.parentToolCallId,
  };
}

/** detached 子会话终态汇总的输入：谁触发（eventId）、成败、错误原文。 */
export interface DetachedChildTerminalOutcome {
  eventId: string;
  success: boolean;
  errorMessage?: string;
}

export function terminalOutcomeOf(
  fact: Extract<ConversationTelemetryFact, { kind: "turn.terminal" | "subagent.lifecycle" }>,
): DetachedChildTerminalOutcome {
  const errorMessage =
    fact.errorMessage ?? (fact.kind === "turn.terminal" ? fact.errorCode : undefined);
  return {
    eventId: fact.eventId,
    success: fact.status === "success" || fact.status === "completed",
    ...(errorMessage === undefined ? {} : { errorMessage }),
  };
}

export function toToolLifecycleEvent(input: {
  fact: Extract<ConversationTelemetryFact, { kind: "tool.lifecycle" }>;
  toolId: string;
  inputId?: string;
  hasStarted: boolean;
}): ZCodeStreamEvent {
  const { fact } = input;
  const skillMetadata =
    fact.skillName || fact.skillQualifiedName || fact.skillPluginId || fact.skillSource
      ? {
          // 旧 CLI 的 scheduled 名称来自任意请求；只接受带解析来源的终态名称。
          ...(fact.skillName &&
          fact.skillSource &&
          (fact.phase === "completed" || fact.phase === "failed")
            ? { name: fact.skillName }
            : {}),
          ...(fact.skillQualifiedName ? { qualifiedName: fact.skillQualifiedName } : {}),
          ...(fact.skillPluginId ? { pluginId: fact.skillPluginId } : {}),
          ...(fact.skillSource ? { source: fact.skillSource } : {}),
        }
      : undefined;
  if (!input.hasStarted && fact.phase !== "completed" && fact.phase !== "failed") {
    return {
      type: "tool_call",
      taskId: fact.sessionId,
      traceId: fact.eventId,
      ...(input.inputId ? { inputId: input.inputId } : {}),
      toolId: input.toolId,
      parentToolUseId: fact.parentToolCallId,
      input: {},
      toolName: fact.toolName,
      kind: fact.toolName ?? "",
      title: "",
      raw: {},
      ...(skillMetadata ? { skillMetadata } : {}),
    } as Extract<ZCodeStreamEvent, { type: "tool_call" }>;
  }
  return {
    type: "tool_call_update",
    taskId: fact.sessionId,
    traceId: fact.eventId,
    ...(input.inputId ? { inputId: input.inputId } : {}),
    toolId: input.toolId,
    parentToolUseId: fact.parentToolCallId,
    status:
      fact.phase === "completed" ? "completed" : fact.phase === "failed" ? "failed" : "in_progress",
    toolName: fact.toolName,
    kind: fact.toolName,
    error: fact.errorMessage,
    raw: {},
    ...(skillMetadata ? { skillMetadata } : {}),
    ...(fact.pluginId
      ? { pluginMetadata: { pluginId: fact.pluginId, component: "mcp" as const } }
      : {}),
  } as Extract<ZCodeStreamEvent, { type: "tool_call_update" }>;
}

export function toUsage(
  fact: Extract<ConversationTelemetryFact, { kind: "usage.delta" }>,
): ZCodeUsage {
  return {
    inputTokens: fact.inputTokens,
    outputTokens: fact.outputTokens,
    totalTokens: fact.totalTokens,
    reasoningTokens: fact.reasoningTokens,
    cachedInputTokens: fact.cacheReadTokens,
    cachedWriteInputTokens: fact.cacheWriteTokens,
  };
}

export function runtimeTelemetryModelName(
  providerId: string | undefined,
  modelId: string | undefined,
) {
  const provider = providerId?.trim() ?? "";
  const model = modelId?.trim() ?? "";
  if (!provider) return model;
  if (!model) return "";
  return model.includes("/") ? model : `${provider}/${model}`;
}

export function mergeUsage(left: ZCodeUsage | null, right: ZCodeUsage): ZCodeUsage {
  if (!left) return { ...right };
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    reasoningTokens: (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0),
    cachedInputTokens: (left.cachedInputTokens ?? 0) + (right.cachedInputTokens ?? 0),
    cachedWriteInputTokens:
      (left.cachedWriteInputTokens ?? 0) + (right.cachedWriteInputTokens ?? 0),
  };
}

export function isToolTimeout(
  fact: Extract<ConversationTelemetryFact, { kind: "tool.lifecycle" }>,
): boolean {
  return fact.errorCode === "tool_timeout" || fact.performance?.timedOut === true;
}

export function terminalStatus(
  status: Extract<ConversationTelemetryFact, { kind: "turn.terminal" }>["status"],
): "success" | "fail" | "user_interrupt" {
  if (status === "success") return "success";
  return status === "interrupted" ? "user_interrupt" : "fail";
}

export function finiteNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function createSendClickId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `send_${Date.now()}_${Math.random().toString(36).slice(2)}`
  );
}
