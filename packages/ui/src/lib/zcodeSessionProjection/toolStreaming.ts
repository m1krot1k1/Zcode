import {
  appendZCodeStreamingToolInputDelta,
  buildZCodeStreamingToolInputPreview,
  finalizeZCodeToolProjectionInput,
  markZCodeStreamingToolInputPreviewMaterialized,
  shouldMaterializeZCodeStreamingToolInputPreview,
  type ZCodeStreamEvent,
  type InputId,
  type TraceId,
  type ZCodeToolProjectionMemory,
} from "@zcode/shared";
import { logger } from "@/logger.js";
import {
  asRecord,
  STREAMING_TOOL_INPUT_INFO_LOG_LINE_BUCKET,
  streamingToolInputProjectionLogBuckets,
  stringValue,
  type ZCodeSessionProjectionMode,
} from "./primitives.js";
import { parentToolUseIdFromToolPayload } from "./tools.js";

export function mapModelStreaming(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
  toolProjectionMemory?: ZCodeToolProjectionMemory,
  projectionMode: ZCodeSessionProjectionMode = "active-live",
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
  return mapToolInputStreaming(
    taskId,
    traceId,
    inputId,
    payload,
    toolProjectionMemory,
    projectionMode,
  );
}

function mapToolInputStreaming(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
  toolProjectionMemory?: ZCodeToolProjectionMemory,
  projectionMode: ZCodeSessionProjectionMode = "active-live",
): ZCodeStreamEvent | null {
  const streamingToolInputById = toolProjectionMemory?.streamingToolInputById;
  const toolNameById = toolProjectionMemory?.toolNameById;
  const kind = stringValue(payload.kind);
  const toolId = stringValue(payload.toolCallId);
  if (!toolId) {
    return null;
  }
  // OpenCode 的工具已经在 provider 侧执行。中间的 input 帧不再各画一张 pending 卡，
  // 最终 tool_call 只投影一次 completed。
  if (payload.providerExecuted === true && kind !== "tool_call") {
    return null;
  }
  const toolName = stringValue(payload.toolName) ?? toolNameById?.get(toolId);
  if (toolName) {
    toolNameById?.set(toolId, toolName);
  }
  const title = toolName ?? "tool";
  const parentToolUseId = parentToolUseIdFromToolPayload(payload);
  const buildRaw = (input: unknown, rawInput: string | undefined) =>
    buildStreamingToolInputRaw(payload, input, rawInput);

  if (kind === "tool_input_start") {
    streamingToolInputById?.set(toolId, { rawInput: "" });
    logStreamingToolInputProjection({
      inputKeys: [],
      kind,
      projectedType: "tool_call",
      rawInputLength: 0,
      taskId,
      toolId,
      toolName,
      traceId,
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
    if (
      !shouldMaterializeZCodeStreamingToolInputPreview(state, {
        mode: projectionMode,
        toolName,
      })
    ) {
      // 性能优化：后台任务和高频 active delta 只更新 tombstone buffer。
      // 完整参数会在预算点、tool_input_end、最终 tool_call 或切回 active 后再落到消息树。
      return null;
    }
    const preview = buildZCodeStreamingToolInputPreview(state.rawInput);
    markZCodeStreamingToolInputPreviewMaterialized(state);
    const previewToolName =
      toolName ?? inferStreamingToolInputToolName(preview.input);
    const previewTitle = previewToolName ?? title;
    if (previewToolName && !toolName) {
      toolNameById?.set(toolId, previewToolName);
    }
    const previewSummary = readStreamingToolInputPreviewLogSummary(
      preview.input,
      state.rawInput.length,
      state.deltaCount,
    );
    logStreamingToolInputProjection({
      ...previewSummary,
      inputKeys: inputPreviewKeys(preview.input),
      kind,
      projectedType: "tool_call_update",
      rawInputLength: state.rawInput.length,
      taskId,
      toolId,
      toolName: previewToolName,
      traceId,
    });
    logStreamingToolInputProjectionSample({
      ...previewSummary,
      kind,
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
    logStreamingToolInputProjection({
      inputKeys: [],
      kind,
      projectedType: "tool_call_update",
      rawInputLength: state.rawInput.length,
      taskId,
      toolId,
      toolName: previewToolName,
      traceId,
    });
    logStreamingToolInputProjectionSample({
      force: true,
      kind,
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
      // 性能修复：tool_input_end 和紧随其后的 tool_call 过去会连续解析同一份大 JSON。
      // end 只表达流式参数结束，完整 input 由最终 tool_call 一次性 materialize。
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
    const previewToolName =
      toolName ?? inferStreamingToolInputToolName(preview.input);
    const previewTitle = previewToolName ?? title;
    if ((hasCompleteInput || preview.complete) && toolProjectionMemory) {
      finalizeZCodeToolProjectionInput(
        toolId,
        preview.input,
        toolProjectionMemory,
      );
    }
    streamingToolInputById?.set(toolId, {
      // 性能修复：最终 tool_call 后，消息树已经持有完整 input；projection tombstone 不再保留
      // 大 raw JSON，避免长任务并发时后台 state 持续占用 renderer 内存。
      rawInput: "",
      deltaCount: state?.deltaCount,
      lastPreviewAt: Date.now(),
      lastPreviewRawInputLength: rawInput.length,
    });
    const previewSummary = readStreamingToolInputPreviewLogSummary(
      preview.input,
      rawInput.length,
      state?.deltaCount,
    );
    logStreamingToolInputProjection({
      ...previewSummary,
      inputKeys: inputPreviewKeys(preview.input),
      kind,
      projectedType: "tool_call_update",
      rawInputLength: rawInput.length,
      taskId,
      toolId,
      toolName: previewToolName,
      traceId,
    });
    logStreamingToolInputProjectionSample({
      ...previewSummary,
      force: true,
      kind,
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
      status: payload.providerExecuted === true ? "completed" : "pending",
      title: previewTitle,
      toolName: previewToolName,
      kind: previewTitle,
      input: preview.input,
      raw: buildRaw(preview.input, preview.rawInput),
    };
  }

  return null;
}

function buildStreamingToolInputRaw(
  payload: Record<string, unknown>,
  input: unknown,
  rawInput: string | undefined,
): Record<string, unknown> {
  return {
    ...payload,
    ...(input !== undefined ? { input } : {}),
    ...(rawInput ? { streamingRawInputLength: rawInput.length } : {}),
  };
}

function logStreamingToolInputProjection(details: {
  contentLength?: number;
  contentLineCount?: number;
  deltaCount?: number;
  filePath?: string;
  inputKeys: string[];
  kind: string;
  projectedType: "tool_call" | "tool_call_update";
  rawInputLength: number;
  taskId: string;
  toolId: string;
  toolName?: string;
  traceId: TraceId;
}): void {
  logger.debug("[streamingToolInput] projected", {
    ...details,
    event: "ui.zcode_session.streaming_tool_input.projected",
  });
}

function logStreamingToolInputProjectionSample(details: {
  contentLength?: number;
  contentLineCount?: number;
  deltaCount?: number;
  filePath?: string;
  force?: boolean;
  kind: string;
  taskId: string;
  toolId: string;
  toolName?: string;
}): void {
  const lineCount = details.contentLineCount;
  const bucket =
    lineCount === undefined
      ? -1
      : Math.floor(lineCount / STREAMING_TOOL_INPUT_INFO_LOG_LINE_BUCKET);
  const key = `${details.taskId}:${details.toolId}:projection`;
  if (
    !details.force &&
    streamingToolInputProjectionLogBuckets.get(key) === bucket
  ) {
    return;
  }
  streamingToolInputProjectionLogBuckets.set(key, bucket);
  if (details.kind === "tool_input_end") {
    streamingToolInputProjectionLogBuckets.delete(key);
  }

  // 性能优化：工具输入投影跟工具调用数量同级，生产 info 落盘会放大深度检索的 renderer 开销。
  // 这里保留 debug 采样，排查时仍能打开细节。
  logger.debug("[streamingToolInput] projection sampled", {
    ...details,
    event: "ui.zcode_session.streaming_tool_input.projection_sampled",
  });
}

function readStreamingToolInputPreviewLogSummary(
  input: unknown,
  rawInputLength: number,
  deltaCount: number | undefined,
) {
  const record = asRecord(input);
  const content = readStringField(record, [
    "content",
    "new_string",
    "newString",
    "new_text",
    "newText",
  ]);
  const filePath = readStringField(record, [
    "file_path",
    "filePath",
    "path",
    "target_path",
    "targetPath",
    "filename",
    "file",
  ]);
  return {
    ...(content !== undefined
      ? {
          contentLength: content.length,
          contentLineCount: countTextLines(content),
        }
      : {}),
    ...(deltaCount !== undefined ? { deltaCount } : {}),
    ...(filePath ? { filePath } : {}),
    rawInputLength,
  };
}

function inferStreamingToolInputToolName(input: unknown): string | undefined {
  const record = asRecord(input);
  const filePath = readStringField(record, [
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
    readStringField(record, ["old_string", "oldString", "old_text", "oldText"])
  ) {
    return "Edit";
  }
  if (
    readStringField(record, [
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

function readStringField(
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

function countTextLines(value: string): number {
  return value.length === 0 ? 0 : value.split(/\r\n|\r|\n/u).length;
}

function inputPreviewKeys(input: unknown): string[] {
  return Object.keys(asRecord(input));
}
