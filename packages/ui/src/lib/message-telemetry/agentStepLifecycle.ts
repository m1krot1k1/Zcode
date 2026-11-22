import { createUuid, sanitizeTelemetrySkillName } from "@zcode/shared";

import {
  legacyTelemetryModelValue,
  legacyTelemetryProviderId,
} from "@/lib/providerTelemetryIdentity.js";
import { settlePermissionWaitsForTool } from "./permissionWaits.js";
import type {
  ActiveAgentStep,
  AgentStepSkillMetadata,
  AgentStepTelemetryClientMode,
  AgentStepTelemetryState,
  AgentStepType,
  FinalizedAgentStepTelemetry,
  GenerationCloseReason,
  PromptTelemetryState,
} from "./types.js";

export function createAgentStep(
  state: AgentStepTelemetryState,
  stepType: AgentStepType,
  startedAt: number,
  options: {
    toolId?: string;
    toolName?: string;
    skillMetadata?: AgentStepSkillMetadata;
  } = {},
): ActiveAgentStep {
  const step: ActiveAgentStep = {
    stepId: createUuid(),
    stepType,
    loopIndex: state.nextLoopIndex,
    startedAt,
    waitingMs: 0,
    ...(state.currentModelRequest ? { model: { ...state.currentModelRequest } } : {}),
    ...options,
  };
  const requestId = step.model?.requestId;
  if (requestId) {
    const pendingUsage = state.pendingUsageByRequestId.get(requestId);
    if (pendingUsage) {
      step.usage = pendingUsage;
      state.pendingUsageByRequestId.delete(requestId);
    }
  }
  state.nextLoopIndex += 1;
  return step;
}

export function normalizeAgentStepStatus(status: string): string {
  if (status === "failed" || status === "fail" || status === "denied") {
    return "fail";
  }
  if (status === "timeout") {
    return "timeout";
  }
  return "success";
}

export function cronCreateAutomationId(content: unknown): string | undefined {
  let value = content;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const automation = (value as { automation?: unknown }).automation;
  if (!automation || typeof automation !== "object" || Array.isArray(automation)) return undefined;
  const automationId = (automation as { automationId?: unknown }).automationId;
  return typeof automationId === "string" && automationId.trim() ? automationId.trim() : undefined;
}

export function markPromptFirstToken(prompt: PromptTelemetryState, now: number): void {
  if (prompt.firstTokenAt !== null) {
    return;
  }

  prompt.firstTokenAt = now;
}

export function finalizeAgentStep(input: {
  prompt: PromptTelemetryState;
  step: ActiveAgentStep;
  finishedAt: number;
  status: string;
  errorType?: string;
  errorMsg?: string;
  generationTailFinalizeMs?: number;
  automationId?: string;
}): FinalizedAgentStepTelemetry {
  const normalizedStatus = normalizeAgentStepStatus(input.status);
  const isToolCall = input.step.stepType === "tool_call";
  const usage = input.step.usage?.usage;
  const model = input.step.model;
  // Bugfix：completion 之前扫描整个 taskMessages，导致后一轮把历史 step/tool
  // 重复计入。逐 step 收口才是当前 message 的事实源，因此聚合必须在这里同步累计。
  input.prompt.finalizedAgentStepCount += 1;
  if (isToolCall) {
    input.prompt.toolCallTotal += 1;
    const isFailed = normalizedStatus !== "success" || Boolean(input.errorMsg);
    if (isFailed) {
      input.prompt.toolCallFailed += 1;
      if (!input.prompt.firstToolCallError && input.errorMsg) {
        input.prompt.firstToolCallError = input.errorMsg;
      }
    }
  }

  return {
    taskId: input.prompt.taskId,
    messageId: input.prompt.messageId,
    eventExtraDetail: {
      step_id: input.step.stepId,
      is_tftt_cached: "0",
      loop_index: String(input.step.loopIndex),
      step_type: input.step.stepType,
      // Bug 根因：旧实现从 prompt 共享字段取模型，后续主请求或 child 请求会覆盖已创建 step。
      // step 必须冻结其真实请求模型；只有旧事实缺少 request identity 时才回退 prompt seed。
      model_name: legacyTelemetryModelValue(
        model?.modelName ?? input.prompt.baseEventExtraDetail.model_name ?? "",
      ),
      model_provider: legacyTelemetryProviderId(
        model?.modelProvider ?? input.prompt.baseEventExtraDetail.model_provider ?? "",
      ),
      provider_name: model?.providerName ?? input.prompt.baseEventExtraDetail.provider_name ?? "",
      model_request_id:
        input.step.usage?.requestIds.length === 1 ? (input.step.usage.requestIds[0] ?? "") : "",
      model_request_count: String(input.step.usage?.requestCount ?? 0),
      token_usage_scope: input.step.usage?.scope ?? "",
      is_tool_call: isToolCall ? "1" : "0",
      tool_name: input.step.toolName ?? "",
      tool_call_id: isToolCall ? (input.step.toolId ?? "") : "",
      ...(input.step.agentId ? { agent_id: input.step.agentId } : {}),
      ...(input.step.agentRole ? { agent_role: input.step.agentRole } : {}),
      duration_ms: String(Math.max(input.finishedAt - input.step.startedAt, 0)),
      waiting_ms: String(input.step.waitingMs),
      generation_tail_finalize_ms:
        input.generationTailFinalizeMs !== undefined ? String(input.generationTailFinalizeMs) : "",
      status: normalizedStatus,
      input_tokens: String(usage?.inputTokens ?? 0),
      output_tokens: String(usage?.outputTokens ?? 0),
      reasoning_tokens: String(usage?.reasoningTokens ?? 0),
      cached_tokens: String(usage?.cachedInputTokens ?? 0),
      cache_write_input_tokens: String(usage?.cachedWriteInputTokens ?? 0),
      total_tokens: String(usage?.totalTokens ?? 0),
      error_type: normalizedStatus === "success" ? "" : (input.errorType ?? "UNKNOWN"),
      error_msg: normalizedStatus === "success" ? "" : (input.errorMsg ?? ""),
      ...(input.automationId ? { automation_id: input.automationId } : {}),
      ...(isToolCall && (input.step.pluginMetadata?.pluginId || input.step.skillMetadata?.pluginId)
        ? {
            plugin_id: input.step.pluginMetadata?.pluginId ?? input.step.skillMetadata!.pluginId!,
            plugin_component: input.step.pluginMetadata?.component ?? "skill",
          }
        : {}),
      ...(isToolCall && input.step.toolName === "Skill"
        ? { skill_name: sanitizeTelemetrySkillName(input.step.skillMetadata?.name) }
        : {}),
      ...(isToolCall && input.step.toolName === "Skill" && input.step.skillMetadata?.qualifiedName
        ? { skill_qualified_name: input.step.skillMetadata.qualifiedName }
        : {}),
      ...(isToolCall && input.step.toolName === "Skill" && input.step.skillMetadata?.pluginId
        ? { skill_plugin_id: input.step.skillMetadata.pluginId }
        : {}),
      ...(isToolCall && input.step.toolName === "Skill" && input.step.skillMetadata?.source
        ? { skill_source: input.step.skillMetadata.source }
        : {}),
    },
  };
}

export function closeReasoningStep(
  prompt: PromptTelemetryState,
  state: AgentStepTelemetryState,
  now: number,
  output: FinalizedAgentStepTelemetry[],
): void {
  if (!state.reasoningStep) {
    return;
  }

  output.push(
    finalizeAgentStep({
      prompt,
      step: state.reasoningStep,
      finishedAt: now,
      status: "success",
    }),
  );
  state.reasoningStep = null;
}

export function closeGenerationStep(
  prompt: PromptTelemetryState,
  state: AgentStepTelemetryState,
  now: number,
  status: string,
  output: FinalizedAgentStepTelemetry[],
  error?: { type?: string; msg?: string },
  closeReason?: GenerationCloseReason,
  clientMode: AgentStepTelemetryClientMode = "desktop-continuous",
): void {
  if (!state.generationStep) {
    return;
  }

  // 修复原因：replayable 恢复会把历史 chunk/terminal 在客户端重放，
  // Date.now() 只能代表本地处理时间，不能代表源端正文尾包到终态的真实尾延迟。
  const canReportGenerationTailFinalize = clientMode === "desktop-continuous";
  const generationTailFinalizeMs =
    canReportGenerationTailFinalize &&
    (closeReason === "task_complete" || closeReason === "task_error") &&
    state.generationStep.lastMessageChunkAt !== undefined
      ? Math.max(now - state.generationStep.lastMessageChunkAt, 0)
      : undefined;

  output.push(
    finalizeAgentStep({
      prompt,
      step: state.generationStep,
      finishedAt: now,
      status,
      errorType: error?.type,
      errorMsg: error?.msg,
      generationTailFinalizeMs,
    }),
  );
  state.generationStep = null;
}

export function closeToolSteps(
  prompt: PromptTelemetryState,
  state: AgentStepTelemetryState,
  now: number,
  status: string,
  output: FinalizedAgentStepTelemetry[],
  error?: { type?: string; msg?: string },
): void {
  for (const [toolId, toolStep] of state.toolStepsById) {
    settlePermissionWaitsForTool(prompt, state, toolId, now);
    output.push(
      finalizeAgentStep({
        prompt,
        step: toolStep,
        finishedAt: now,
        status,
        errorType: error?.type,
        errorMsg: error?.msg,
      }),
    );
  }
  state.toolStepsById.clear();
}
