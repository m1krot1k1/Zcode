import type { Logger, ModelStreamEvent, ModelToolCall } from "@zcode/contracts";
import {
  attachRawMalformedInputEnvelope,
  normalizeModelToolInput,
} from "./tool-input-normalization.js";
import { normalizeModelToolName } from "./tool-call-validation.js";

const OUTPUT_LIMIT_RAW_REASONS = new Set([
  "max_tokens",
  "max_output_tokens",
  "model_context_window_exceeded",
]);

interface StreamingToolCallAssemblerOptions {
  logger?: Logger;
}

export class StreamingToolCallAssembler {
  private readonly completedStreamingInputIds = new Set<string>();
  private readonly logger?: Logger;
  private readonly normalizedToolCalls = new Map<string, ModelToolCall>();
  private readonly providerExecutedById = new Map<string, boolean>();
  private readonly streamingInputIds = new Set<string>();
  private readonly streamingInputBuffers = new Map<
    string,
    { toolName: string; rawText: string }
  >();

  constructor(options: StreamingToolCallAssemblerOptions = {}) {
    this.logger = options.logger;
  }

  snapshotNormalizedToolCalls(): ModelToolCall[] {
    return Array.from(this.normalizedToolCalls.values(), (toolCall) => ({ ...toolCall }));
  }

  handle(event: ModelStreamEvent): ModelStreamEvent[] {
    switch (event.type) {
      case "tool_input_start":
        return this.handleToolInputStart(event);
      case "tool_input_delta":
        return this.handleToolInputDelta(event);
      case "tool_input_end":
        return this.handleToolInputEnd(event);
      case "tool_call":
        return this.handleToolCall(event.toolCall);
      case "finish":
        return [...this.flush(event), event];
      default:
        return [event];
    }
  }

  flush(finishEvent?: Extract<ModelStreamEvent, { type: "finish" }>): ModelStreamEvent[] {
    const synthesized: ModelStreamEvent[] = [];
    if (finishEvent && isLengthTruncatedFinish(finishEvent)) {
      // Причина фикса F-01: при усечении ответа по maxOutputTokens (finishReason === "length")
      // провайдер обрывает поток аргументов без tool_input_end / final tool_call;
      // материализуем оборванный вызов, чтобы Core выдал TOOL_CALL_TRUNCATED_BY_MAX_TOKENS.
      for (const id of this.streamingInputIds) {
        if (this.normalizedToolCalls.has(id)) continue;
        const buffered = this.streamingInputBuffers.get(id);
        if (!buffered) continue;
        const providerExecuted = this.providerExecutedById.get(id);
        const fallbackInput = attachRawMalformedInputEnvelope({}, buffered.rawText);
        const truncatedCall: ModelToolCall = {
          id,
          name: buffered.toolName,
          input: fallbackInput,
          ...(providerExecuted === undefined ? {} : { providerExecuted }),
        };
        this.normalizedToolCalls.set(id, truncatedCall);
        synthesized.push({ type: "tool_call", toolCall: truncatedCall });
      }
    }
    this.completedStreamingInputIds.clear();
    this.providerExecutedById.clear();
    this.streamingInputIds.clear();
    this.streamingInputBuffers.clear();
    return synthesized;
  }

  private handleToolInputStart(
    event: Extract<ModelStreamEvent, { type: "tool_input_start" }>,
  ): ModelStreamEvent[] {
    if (this.normalizedToolCalls.has(event.id)) {
      return [];
    }

    const toolName = normalizeModelToolName(event.toolName, {
      providerExecuted: event.providerExecuted,
      source: "streamText",
      streamEventType: event.type,
      toolCallId: event.id,
    });
    if (event.providerExecuted !== undefined) {
      this.providerExecutedById.set(event.id, event.providerExecuted);
    }
    this.streamingInputIds.add(event.id);
    this.streamingInputBuffers.set(event.id, { toolName, rawText: "" });
    return [{ ...event, toolName }];
  }

  private handleToolInputDelta(
    event: Extract<ModelStreamEvent, { type: "tool_input_delta" }>,
  ): ModelStreamEvent[] {
    if (this.normalizedToolCalls.has(event.id)) {
      return [];
    }
    const buffered = this.streamingInputBuffers.get(event.id);
    if (buffered) {
      buffered.rawText += event.delta;
    }
    return [event];
  }

  private handleToolInputEnd(
    event: Extract<ModelStreamEvent, { type: "tool_input_end" }>,
  ): ModelStreamEvent[] {
    if (this.normalizedToolCalls.has(event.id)) {
      return [];
    }
    this.completedStreamingInputIds.add(event.id);
    return [event];
  }

  private handleToolCall(toolCall: ModelToolCall): ModelStreamEvent[] {
    if (this.normalizedToolCalls.has(toolCall.id)) {
      return [];
    }
    if (
      this.streamingInputIds.has(toolCall.id) &&
      !this.completedStreamingInputIds.has(toolCall.id)
    ) {
      // 已经进入流式 input 生命周期时，final call 不能替代缺失的
      // tool-input-end；只移除“首次 JSON 可解析”合成，不改变既有 end gate。
      return [];
    }

    const providerExecuted =
      toolCall.providerExecuted ?? this.providerExecutedById.get(toolCall.id);
    const toolName = normalizeModelToolName(toolCall.name, {
      providerExecuted,
      source: "streamText",
      streamEventType: "tool_call",
      toolCallId: toolCall.id,
    });
    const normalizedToolCall = {
      ...toolCall,
      input: normalizeModelToolInput(toolCall.input, {
        logger: this.logger,
        source: "streamText",
        toolName,
      }),
      name: toolName,
      // 流式 start 可能携带 final call 省略的 provider 执行标记。
      // 这里只补回原有元数据，不改变工具提交、重试或执行语义。
      providerExecuted,
    };
    this.completedStreamingInputIds.delete(toolCall.id);
    this.providerExecutedById.delete(toolCall.id);
    this.streamingInputIds.delete(toolCall.id);
    this.streamingInputBuffers.delete(toolCall.id);
    this.normalizedToolCalls.set(normalizedToolCall.id, normalizedToolCall);
    return [{ type: "tool_call", toolCall: normalizedToolCall }];
  }
}

function isLengthTruncatedFinish(event: Extract<ModelStreamEvent, { type: "finish" }>): boolean {
  if (event.finishReason === "length") return true;
  const rawReason = event.providerMetadata?.rawFinishReason;
  return typeof rawReason === "string" && OUTPUT_LIMIT_RAW_REASONS.has(rawReason);
}
