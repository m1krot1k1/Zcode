/**
 * zcodeTaskServiceAdapterStreamingToolInput.ts: Стриминг tool input: модель, превью и накопление дельт.
 */
import type {
  InputId,
  TraceId,
  ZCodeContextCompactionTimelineMeta,
  ZCodeMessagePart,
  ZCodeStreamEvent,
  ZCodeToolProjectionMemory,
} from "@zcode/shared";
import { logger } from "./zcodeTaskServiceAdapterCore.js";
import { extractSyntheticTimelineFromTextPart } from "./zcodeTaskServiceAdapterMessageMapping.js";
import {
  asRecord,
  booleanValue,
  numberValue,
  stringValue,
  timelineStatusValue,
  timelineTriggerValue,
} from "./zcodeTaskServiceAdapterRuntimePayloads.js";
import { parentToolUseIdFromToolPayload } from "./zcodeTaskServiceAdapterToolUpdateMapping.js";
import {
  appendZCodeStreamingToolInputDelta,
  buildZCodeStreamingToolInputPreview,
  finalizeZCodeToolProjectionInput,
  isZCodeModelRetryRecoveryProgressPayload,
  markZCodeStreamingToolInputPreviewMaterialized,
  shouldMaterializeZCodeStreamingToolInputPreview,
} from "@zcode/shared";

export function maybeBuildApiRetryClearOnModelProgress(
  hasActiveApiRetry: boolean,
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
): Extract<ZCodeStreamEvent, { type: "session_info_update" }> | null {
  if (!hasActiveApiRetry || !isZCodeModelRetryRecoveryProgressPayload(payload)) {
    return null;
  }
  // 重试请求开始不代表恢复成功，立即清会让输入栏闪烁；
  // 只有 retry attempt 真的产出模型内容，才清掉“重试中”运行态。
  return {
    type: "session_info_update",
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    apiRetry: null,
  };
}

export function mapModelStreaming(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
  toolProjectionMemory?: ZCodeToolProjectionMemory,
): ZCodeStreamEvent | null {
  const kind = stringValue(payload.kind);
  const delta = stringValue(payload.delta);
  const parentToolUseId = parentToolUseIdFromToolPayload(payload);
  if (kind === "text_delta") {
    if (!delta) {
      return null;
    }
    return {
      type: "agent_message_chunk",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      ...(parentToolUseId ? { parentToolUseId } : {}),
      messageId: stringValue(payload.assistantMessageId),
      content: delta,
    };
  }
  if (kind === "reasoning_delta") {
    if (!delta) {
      return null;
    }
    return {
      type: "agent_thought_chunk",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      ...(parentToolUseId ? { parentToolUseId } : {}),
      content: delta,
    };
  }
  return mapToolInputStreaming(taskId, traceId, inputId, payload, toolProjectionMemory);
}

export function mapToolInputStreaming(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
  toolProjectionMemory?: ZCodeToolProjectionMemory,
): ZCodeStreamEvent | null {
  const streamingToolInputById = toolProjectionMemory?.streamingToolInputById;
  const toolNameById = toolProjectionMemory?.toolNameById;
  const kind = stringValue(payload.kind);
  const toolId = stringValue(payload.toolCallId);
  if (!toolId) {
    return null;
  }
  const toolName = stringValue(payload.toolName) ?? toolNameById?.get(toolId);
  if (toolName) {
    toolNameById?.set(toolId, toolName);
  }
  const title = toolName ?? "tool";
  const parentToolUseId = parentToolUseIdFromToolPayload(payload);
  const buildRaw = (input: unknown, rawInput: string | undefined) => ({
    ...payload,
    ...(input !== undefined ? { input } : {}),
    ...(rawInput ? { streamingRawInputLength: rawInput.length } : {}),
  });

  if (kind === "tool_input_start") {
    streamingToolInputById?.set(toolId, { rawInput: "" });
    logStreamingToolInputProjection(traceId, {
      inputKeys: [],
      kind,
      projectedType: "tool_call",
      rawInputLength: 0,
      taskId,
      toolId,
      toolName,
    });
    return {
      type: "tool_call",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      toolId,
      parentToolUseId,
      input: {},
      toolName,
      kind: title,
      title,
      raw: buildRaw({}, undefined),
    };
  }

  if (kind === "tool_input_delta") {
    const state = appendZCodeStreamingToolInputDelta(
      streamingToolInputById?.get(toolId),
      stringValue(payload.delta) ?? "",
    );
    streamingToolInputById?.set(toolId, state);
    if (!shouldMaterializeZCodeStreamingToolInputPreview(state, { toolName })) {
      // 性能修复：services 兼容投影曾经每个 delta 都解析累计 JSON，并把 rawInput 全量塞进 raw。
      // 这里先只维护 tombstone buffer，达到预算或控制边界再 emit，避免 host/renderer 双端 O(n²)。
      return null;
    }
    const preview = buildZCodeStreamingToolInputPreview(state.rawInput);
    markZCodeStreamingToolInputPreviewMaterialized(state);
    const previewToolName = toolName ?? inferStreamingToolInputToolName(preview.input);
    const previewTitle = previewToolName ?? title;
    if (previewToolName && !toolName) {
      toolNameById?.set(toolId, previewToolName);
    }
    logStreamingToolInputProjection(traceId, {
      inputKeys: inputPreviewKeys(preview.input),
      kind,
      projectedType: "tool_call_update",
      rawInputLength: state.rawInput.length,
      taskId,
      toolId,
      toolName: previewToolName,
    });
    return {
      type: "tool_call_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      toolId,
      parentToolUseId,
      status: "pending",
      title: previewTitle,
      toolName: previewToolName,
      kind: previewTitle,
      input: preview.input,
      raw: buildRaw(preview.input, preview.rawInput),
    };
  }

  if (kind === "tool_input_end") {
    const state = streamingToolInputById?.get(toolId) ?? { rawInput: "" };
    const previewToolName = toolName ?? title;
    const previewTitle = previewToolName ?? title;
    logStreamingToolInputProjection(traceId, {
      inputKeys: [],
      kind,
      projectedType: "tool_call_update",
      rawInputLength: state.rawInput.length,
      taskId,
      toolId,
      toolName: previewToolName,
    });
    return {
      type: "tool_call_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      toolId,
      parentToolUseId,
      status: "pending",
      title: previewTitle,
      toolName: previewToolName,
      kind: previewTitle,
      // 性能修复：tool_input_end 与最终 tool_call 相邻时不再重复解析同一份大 JSON；
      // end 只作为生命周期边界，完整 input 交给 tool_call 一次性落库/渲染。
      raw: buildRaw(undefined, state.rawInput),
    };
  }

  if (kind === "tool_call") {
    const state = streamingToolInputById?.get(toolId);
    const rawInput = state?.rawInput ?? "";
    const hasCompleteInput = "input" in payload;
    const completeInput = hasCompleteInput ? payload.input : undefined;
    const preview = buildZCodeStreamingToolInputPreview(
      rawInput,
      hasCompleteInput ? completeInput : undefined,
    );
    const previewToolName = toolName ?? inferStreamingToolInputToolName(preview.input);
    const previewTitle = previewToolName ?? title;
    if (previewToolName && !toolName) {
      toolNameById?.set(toolId, previewToolName);
    }
    if ((hasCompleteInput || preview.complete) && toolProjectionMemory) {
      finalizeZCodeToolProjectionInput(toolId, preview.input, toolProjectionMemory);
    }
    streamingToolInputById?.set(toolId, {
      // 性能修复：最终 tool_call 已经持有完整 input，compat projection 不再长期保留
      // streaming raw buffer，避免并发长任务时 host 侧内存和序列化成本继续放大。
      rawInput: "",
      deltaCount: state?.deltaCount,
      lastPreviewAt: Date.now(),
      lastPreviewRawInputLength: rawInput.length,
    });
    logStreamingToolInputProjection(traceId, {
      inputKeys: inputPreviewKeys(preview.input),
      kind,
      projectedType: "tool_call_update",
      rawInputLength: rawInput.length,
      taskId,
      toolId,
      toolName: previewToolName,
    });
    return {
      type: "tool_call_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      toolId,
      parentToolUseId,
      status: "pending",
      title: previewTitle,
      toolName: previewToolName,
      kind: previewTitle,
      input: preview.input,
      raw: buildRaw(preview.input, preview.rawInput),
    };
  }

  return null;
}

export function logStreamingToolInputProjection(
  traceId: TraceId,
  details: {
    inputKeys: string[];
    kind: string;
    projectedType: "tool_call" | "tool_call_update";
    rawInputLength: number;
    taskId: string;
    toolId: string;
    toolName?: string;
  },
): void {
  logger.debug(traceId, "ZCode streaming tool input projected", {
    ...details,
    event: "zcode.task.streaming_tool_input.projected",
  });
}

export function inputPreviewKeys(input: unknown): string[] {
  return Object.keys(asRecord(input));
}

export function inferStreamingToolInputToolName(input: unknown): string | undefined {
  const record = asRecord(input);
  const filePath = readStreamingToolInputStringField(record, [
    "file_path",
    "filePath",
    "path",
    "target_path",
    "targetPath",
    "filename",
    "file",
  ]);
  if (!filePath) {
    return undefined;
  }
  if (
    readStreamingToolInputStringField(record, ["old_string", "oldString", "old_text", "oldText"])
  ) {
    return "Edit";
  }
  if (
    readStreamingToolInputStringField(record, [
      "content",
      "new_string",
      "newString",
      "new_text",
      "newText",
    ]) !== undefined
  ) {
    return "Write";
  }
  return undefined;
}

export function readStreamingToolInputStringField(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

export function mapCompactTimelinePayload(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
): Extract<ZCodeStreamEvent, { type: "agent_message_chunk" }> | null {
  const timeline = compactTimelineMetaFromPayload(payload, inputId);
  if (!timeline) {
    return null;
  }
  const messageId = stringValue(payload.messageId);
  return {
    type: "agent_message_chunk",
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    ...(messageId ? { messageId } : {}),
    // compact lifecycle 是结构化状态事件，不是 assistant 正文。
    // 即使上游误带 text，也不能把内部 summary/prompt 投影到聊天区。
    content: "",
    zcodeTimeline: timeline,
  };
}

export function mapSyntheticTimelinePartPayload(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
): Extract<ZCodeStreamEvent, { type: "agent_message_chunk" }> | null {
  const part = asRecord(payload.part);
  if (part.type !== "text") {
    return null;
  }
  const timeline = extractSyntheticTimelineFromTextPart(
    part as Extract<ZCodeMessagePart, { type: "text" }>,
  );
  if (!timeline) {
    return null;
  }
  const messageId = stringValue(part.messageId) ?? stringValue(payload.messageId);
  return {
    type: "agent_message_chunk",
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    ...(messageId ? { messageId } : {}),
    content: stringValue(part.text) ?? "",
    // fork notice 是 part.upserted 里的结构化 synthetic text，不是模型正文 delta。
    // 这里提前投成 timeline divider，避免 UI 按普通消息渲染后丢掉横线。
    zcodeTimeline: timeline,
  };
}

export function compactTimelineMetaFromPayload(
  payload: Record<string, unknown>,
  inputId: InputId | undefined,
): ZCodeContextCompactionTimelineMeta | null {
  const operationId = stringValue(payload.operationId);
  const status = timelineStatusValue(payload.status ?? payload.timelineStatus);
  if (!operationId || !status) {
    return null;
  }
  const trigger = timelineTriggerValue(payload.trigger) ?? "manual";
  const replace = booleanValue(payload.replace);
  const reason = stringValue(payload.reason);
  const boundaryId = stringValue(payload.boundaryId);
  const summaryMessageId = stringValue(payload.summaryMessageId);
  const preCompactTokenCount = numberValue(payload.preCompactTokenCount);
  const postCompactTokenCount = numberValue(payload.postCompactTokenCount);
  const truePostCompactTokenCount = numberValue(payload.truePostCompactTokenCount);
  const attempt = numberValue(payload.attempt);
  const maxAttempts = numberValue(payload.maxAttempts);
  const startedAt = numberValue(payload.startedAt);
  const endedAt = numberValue(payload.endedAt);
  return {
    version: 1,
    kind: "synthetic",
    type: "context_compaction",
    operationId,
    status,
    trigger,
    display: "separator",
    ...(inputId ? { inputId } : {}),
    ...(replace !== undefined ? { replace } : {}),
    ...(reason ? { reason } : {}),
    ...(boundaryId ? { boundaryId } : {}),
    ...(summaryMessageId ? { summaryMessageId } : {}),
    ...(preCompactTokenCount !== undefined ? { preCompactTokenCount } : {}),
    ...(postCompactTokenCount !== undefined ? { postCompactTokenCount } : {}),
    ...(truePostCompactTokenCount !== undefined ? { truePostCompactTokenCount } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
  };
}
