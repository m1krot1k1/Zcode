import type { InputId } from "@zcode/shared";

import type {
  AgentStepTelemetryState,
  ComposerInputTimingState,
  PromptTelemetryState,
} from "./types.js";

export const composerInputTimingByWorkspace = new Map<string, ComposerInputTimingState>();
export const queuedPromptTelemetryByTask = new Map<string, PromptTelemetryState[]>();
export const activePromptTelemetryByTask = new Map<string, PromptTelemetryState>();
export const agentStepTelemetryByTask = new Map<string, AgentStepTelemetryState>();

export function createAgentStepTelemetryState(): AgentStepTelemetryState {
  return {
    nextLoopIndex: 1,
    currentModelRequest: null,
    pendingUsageByRequestId: new Map(),
    reasoningStep: null,
    generationStep: null,
    toolStepsById: new Map(),
    settledPermissionWaitsByToolId: new Map(),
  };
}

export function getAgentStepTelemetryState(taskId: string): AgentStepTelemetryState {
  const existing = agentStepTelemetryByTask.get(taskId);
  if (existing) {
    return existing;
  }

  const created = createAgentStepTelemetryState();
  agentStepTelemetryByTask.set(taskId, created);
  return created;
}

export function ensureComposerInputTiming(workspacePath: string): ComposerInputTimingState {
  const existing = composerInputTimingByWorkspace.get(workspacePath);
  if (existing) {
    return existing;
  }

  const created: ComposerInputTimingState = {
    inputStartTime: 0,
    inputFirstCharTime: 0,
  };
  composerInputTimingByWorkspace.set(workspacePath, created);
  return created;
}

export function consumeComposerInputTiming(workspacePath: string, sendTime: number) {
  const current = ensureComposerInputTiming(workspacePath);
  const inputStartTime = current.inputStartTime || current.inputFirstCharTime || sendTime;
  const inputFirstCharTime = current.inputFirstCharTime || inputStartTime || sendTime;

  composerInputTimingByWorkspace.set(workspacePath, {
    inputStartTime: 0,
    inputFirstCharTime: 0,
  });

  return {
    inputStartTime,
    inputFirstCharTime,
  };
}

export function createPromptTelemetryState(input: {
  taskId: string;
  messageId: string;
  inputId?: InputId;
  sendTime: number;
  inputStartTime: number;
  inputFirstCharTime: number;
  extraDetail?: Record<string, string>;
}): PromptTelemetryState {
  return {
    taskId: input.taskId,
    messageId: input.messageId,
    ...(input.inputId ? { inputId: input.inputId } : {}),
    baseEventExtraDetail: input.extraDetail ? { ...input.extraDetail } : {},
    sendTime: input.sendTime,
    inputStartTime: input.inputStartTime,
    inputFirstCharTime: input.inputFirstCharTime,
    waitingMs: 0,
    permissionWaitsByRequestId: new Map(),
    firstTokenAt: null,
    usage: null,
    usageEventKeys: new Set(),
    finalizedAgentStepCount: 0,
    toolCallTotal: 0,
    toolCallFailed: 0,
    firstToolCallError: "",
  };
}

export function resetMessageTelemetryForTest(): void {
  composerInputTimingByWorkspace.clear();
  queuedPromptTelemetryByTask.clear();
  activePromptTelemetryByTask.clear();
  agentStepTelemetryByTask.clear();
}

/** workspace telemetry attachment 释放时只清自己的内部 task key，不影响其它 workspace。 */
export function discardPromptTelemetry(taskId: string): void {
  queuedPromptTelemetryByTask.delete(taskId);
  activePromptTelemetryByTask.delete(taskId);
  agentStepTelemetryByTask.delete(taskId);
}

/** 仅丢弃尚未激活的单条 prompt，避免同 session 其它排队消息被一并清空。 */
export function discardQueuedPromptTelemetry(taskId: string, messageId: string): void {
  const queue = queuedPromptTelemetryByTask.get(taskId);
  if (!queue) return;
  const next = queue.filter((item) => item.messageId !== messageId);
  if (next.length === 0) {
    queuedPromptTelemetryByTask.delete(taskId);
    return;
  }
  queuedPromptTelemetryByTask.set(taskId, next);
}
