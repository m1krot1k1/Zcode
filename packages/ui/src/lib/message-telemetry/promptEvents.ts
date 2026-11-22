import type { ZCodeStreamEvent, ZCodeUsage } from "@zcode/shared";

import { assignUsageToStep, findModelOutputStepForRequest } from "./agentStepAttribution.js";
import { readProviderIdFromModelValue, resolveProviderHostname } from "./modelIdentity.js";
import { settlePermissionWait } from "./permissionWaits.js";
import {
  activePromptTelemetryByTask,
  agentStepTelemetryByTask,
  getAgentStepTelemetryState,
} from "./state.js";
import { mergePromptUsage } from "./usage.js";

export function recordPromptModelRequestStarted(
  taskId: string,
  event: Extract<ZCodeStreamEvent, { type: "task_network_debug_status" }>,
  activeInputId?: string,
): void {
  if (event.statusType !== "model_request_started") {
    return;
  }

  const active = activePromptTelemetryByTask.get(taskId);
  if (!active) {
    return;
  }

  const expectedInputId = activeInputId ?? active.inputId;
  if (expectedInputId && event.inputId && expectedInputId !== event.inputId) {
    return;
  }

  const modelProvider = event.providerId?.trim();
  const rawModelName = event.modelId?.trim();
  const providerHostname = resolveProviderHostname(event.baseURL);
  const modelName =
    rawModelName && modelProvider && !readProviderIdFromModelValue(rawModelName)
      ? `${modelProvider}/${rawModelName}`
      : rawModelName;
  if (!modelProvider && !modelName) {
    return;
  }

  const state = getAgentStepTelemetryState(taskId);
  state.currentModelRequest = {
    ...(event.requestId?.trim() ? { requestId: event.requestId.trim() } : {}),
    modelName: modelName ?? active.baseEventExtraDetail.model_name ?? "",
    modelProvider: modelProvider ?? active.baseEventExtraDetail.model_provider ?? "",
    providerName: providerHostname || active.baseEventExtraDetail.provider_name || "",
  };
  active.baseEventExtraDetail = {
    ...active.baseEventExtraDetail,
    // 修复原因：send_btn 是 UI 选择快照，但 message_completion/agent_step 要尽量代表真实模型请求。
    // 自定义供应商切换时 workspace configOptions 可能仍是 builtin 模型；这里用运行时 request_started 回包覆盖完成态模型维度。
    ...(modelName ? { model_name: modelName } : {}),
    ...(modelProvider ? { model_provider: modelProvider } : {}),
    ...(providerHostname ? { provider_name: providerHostname } : {}),
  };
}

export function recordPromptFirstToken(taskId: string, now = Date.now()): void {
  const active = activePromptTelemetryByTask.get(taskId);
  if (!active || active.firstTokenAt !== null) {
    return;
  }

  active.firstTokenAt = now;
}

// 当前激活 prompt 的模型名,供 ARMS 镜像事件(stream_stall 等)补齐 model 维度;
// 无激活 prompt 或未带 model_name 时返回 undefined,由调用方留空。
export function getActivePromptModelName(taskId: string): string | undefined {
  const active = activePromptTelemetryByTask.get(taskId);
  return active?.baseEventExtraDetail.model_name || undefined;
}

export function getActivePromptMessageId(taskId: string): string | undefined {
  return activePromptTelemetryByTask.get(taskId)?.messageId;
}

export function recordPromptTokenUsageDelta(input: {
  taskId: string;
  eventKey: string;
  usage: ZCodeUsage;
  requestId?: string;
  modelName?: string;
  modelProvider?: string;
  providerName?: string;
}): void {
  const active = activePromptTelemetryByTask.get(input.taskId);
  const eventKey = input.eventKey.trim();
  if (!active || eventKey.length === 0 || active.usageEventKeys.has(eventKey)) {
    return;
  }

  active.usageEventKeys.add(eventKey);
  active.usage = mergePromptUsage(active.usage, input.usage);

  const requestId = input.requestId?.trim();
  if (!requestId) return;
  const state = getAgentStepTelemetryState(input.taskId);
  const modelName = input.modelName?.trim();
  const modelProvider = input.modelProvider?.trim();
  const providerName = input.providerName?.trim();
  const step = findModelOutputStepForRequest(state, requestId);
  if (step) {
    step.model = {
      requestId,
      modelName: modelName ?? step.model?.modelName ?? "",
      modelProvider: modelProvider ?? step.model?.modelProvider ?? "",
      providerName: providerName ?? step.model?.providerName ?? "",
    };
    assignUsageToStep(step, {
      requestIds: [requestId],
      requestCount: 1,
      scope: "model_request",
      usage: input.usage,
    });
    return;
  }

  state.pendingUsageByRequestId.set(requestId, {
    requestIds: [requestId],
    requestCount: 1,
    scope: "model_request",
    usage: input.usage,
  });
}

export function recordPromptPermissionRequest(input: {
  taskId: string;
  requestId: string;
  toolCallId?: string;
  raw?: unknown;
  now?: number;
}): void {
  const active = activePromptTelemetryByTask.get(input.taskId);
  const requestId = input.requestId.trim();
  if (!active || requestId.length === 0 || active.permissionWaitsByRequestId.has(requestId)) {
    return;
  }

  const raw =
    input.raw !== null && typeof input.raw === "object"
      ? (input.raw as Record<string, unknown>)
      : {};
  const rawToolCallId =
    typeof raw.toolCallId === "string" && raw.toolCallId.trim().length > 0
      ? raw.toolCallId.trim()
      : undefined;
  const toolCallId = input.toolCallId?.trim() || rawToolCallId || requestId;
  active.permissionWaitsByRequestId.set(requestId, {
    requestedAt: input.now ?? Date.now(),
    ...(toolCallId ? { toolCallId } : {}),
  });
}

export function recordPromptPermissionResponse(input: {
  taskId: string;
  requestId: string;
  now?: number;
}): void {
  const active = activePromptTelemetryByTask.get(input.taskId);
  if (!active) {
    return;
  }

  settlePermissionWait(
    active,
    agentStepTelemetryByTask.get(input.taskId),
    input.requestId,
    input.now ?? Date.now(),
  );
}
