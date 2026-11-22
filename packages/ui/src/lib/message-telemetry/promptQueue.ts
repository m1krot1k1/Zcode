import type { InputId } from "@zcode/shared";

import {
  activePromptTelemetryByTask,
  agentStepTelemetryByTask,
  consumeComposerInputTiming,
  createAgentStepTelemetryState,
  createPromptTelemetryState,
  ensureComposerInputTiming,
  queuedPromptTelemetryByTask,
} from "./state.js";

export function recordComposerFocus(workspacePath: string, now = Date.now()): void {
  const inputTiming = ensureComposerInputTiming(workspacePath);
  inputTiming.inputStartTime = now;
  inputTiming.inputFirstCharTime = 0;
}

export function recordComposerTextChange(
  workspacePath: string,
  nextText: string,
  now = Date.now(),
): void {
  if (nextText.length === 0) {
    return;
  }

  const inputTiming = ensureComposerInputTiming(workspacePath);
  if (inputTiming.inputFirstCharTime !== 0) {
    return;
  }

  inputTiming.inputFirstCharTime = now;
  if (inputTiming.inputStartTime === 0) {
    inputTiming.inputStartTime = now;
  }
}

export function queuePromptTelemetry(input: {
  workspacePath: string;
  taskId: string;
  messageId: string;
  inputId?: InputId;
  sendTime: number;
  extraDetail?: Record<string, string>;
}) {
  const { inputStartTime, inputFirstCharTime } = consumeComposerInputTiming(
    input.workspacePath,
    input.sendTime,
  );
  const promptTelemetry = createPromptTelemetryState({
    taskId: input.taskId,
    messageId: input.messageId,
    ...(input.inputId ? { inputId: input.inputId } : {}),
    sendTime: input.sendTime,
    inputStartTime,
    inputFirstCharTime,
    ...(input.extraDetail ? { extraDetail: input.extraDetail } : {}),
  });

  const existingQueue = queuedPromptTelemetryByTask.get(input.taskId) ?? [];
  queuedPromptTelemetryByTask.set(input.taskId, [...existingQueue, promptTelemetry]);

  return {
    ...promptTelemetry.baseEventExtraDetail,
    input_start_time: String(inputStartTime),
    input_first_char_time: String(inputFirstCharTime),
    input_send_time: String(input.sendTime),
  };
}

export function activatePromptTelemetry(taskId: string, messageId: string): void {
  const queue = queuedPromptTelemetryByTask.get(taskId);
  if (!queue || queue.length === 0) {
    return;
  }

  const targetIndex = queue.findIndex((item) => item.messageId === messageId);
  if (targetIndex === -1) {
    return;
  }

  const [target] = queue.splice(targetIndex, 1);
  if (!target) {
    return;
  }

  if (queue.length === 0) {
    queuedPromptTelemetryByTask.delete(taskId);
  } else {
    queuedPromptTelemetryByTask.set(taskId, queue);
  }

  activePromptTelemetryByTask.set(taskId, target);
  agentStepTelemetryByTask.set(taskId, createAgentStepTelemetryState());
}

/** background child 只复用 agent_step 状态，不创建或上报独立的 message 生命周期。 */
export function activateDetachedAgentStepTelemetry(input: {
  taskId: string;
  messageId: string;
  sendTime: number;
  extraDetail?: Record<string, string>;
}): void {
  activePromptTelemetryByTask.set(
    input.taskId,
    createPromptTelemetryState({
      taskId: input.taskId,
      messageId: input.messageId,
      sendTime: input.sendTime,
      inputStartTime: input.sendTime,
      inputFirstCharTime: input.sendTime,
      ...(input.extraDetail ? { extraDetail: input.extraDetail } : {}),
    }),
  );
  agentStepTelemetryByTask.set(input.taskId, createAgentStepTelemetryState());
}

export function rekeyQueuedPromptTelemetry(
  taskId: string,
  fromMessageId: string,
  toMessageId: string,
): void {
  if (fromMessageId === toMessageId) {
    return;
  }

  const queue = queuedPromptTelemetryByTask.get(taskId);
  if (!queue || queue.length === 0) {
    return;
  }

  const targetIndex = queue.findIndex((item) => item.messageId === fromMessageId);
  if (targetIndex === -1) {
    return;
  }

  const target = queue[targetIndex];
  if (!target) {
    return;
  }

  queue[targetIndex] = {
    ...target,
    messageId: toMessageId,
  };
  queuedPromptTelemetryByTask.set(taskId, queue);
}
