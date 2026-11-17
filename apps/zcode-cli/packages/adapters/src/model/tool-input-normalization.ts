import type { Logger } from "@zcode/contracts";

const RAW_MALFORMED_TOOL_INPUT_SYMBOL = Symbol.for("zcode.model.rawMalformedToolInput");
const utf8Encoder = new TextEncoder();

interface NormalizeModelToolInputOptions {
  logger?: Logger;
  source: "generateText" | "streamText";
  toolName?: string;
}

export function attachRawMalformedInputEnvelope(
  target: Record<string, unknown>,
  rawText: string,
): Record<string, unknown> {
  Object.defineProperty(target, RAW_MALFORMED_TOOL_INPUT_SYMBOL, {
    value: {
      rawText,
      byteLength: utf8Encoder.encode(rawText).byteLength,
    },
    enumerable: false,
    configurable: true,
    writable: false,
  });
  return target;
}

export function normalizeModelToolInput(
  input: unknown,
  options: NormalizeModelToolInputOptions,
): unknown {
  if (input === undefined) {
    return {};
  }
  if (input === null) {
    // 上游会先把合法 JSON 字面量 "null" 解析成原生 null；
    // 这里必须与 string parse-null 使用相同恢复语义，且不能伪造原始长度。
    warnAndRecoverMalformedToolInput(new TypeError("Model tool input must not be null"), options, {
      inputType: "null",
    });
    return {};
  }
  if (typeof input !== "string") {
    return input;
  }
  if (input.length === 0) {
    return {};
  }

  try {
    const normalizedInput = JSON.parse(stripByteOrderMark(input));
    if (normalizedInput === null) {
      // JSON null 虽然语法合法，但不能表示工具参数。与 malformed
      // JSON 一样降级为空对象，让既有工具 schema 决定后续结果。
      throw new TypeError("Model tool input must not be null");
    }
    return normalizedInput;
  } catch (error) {
    warnAndRecoverMalformedToolInput(error, options, {
      inputLength: input.length,
    });
    // AI SDK 已提供 final tool-call；此处抛 invalid_model_response
    // 会把参数错误错误地升级为整个模型请求失败。严格解析失败后只降级为
    // 空对象，并通过非枚举 Symbol 附带原始串字节信息，供 Core 区分 length 截断与自修复。
    const fallback: Record<string, unknown> = {};
    if (!(error instanceof TypeError)) {
      attachRawMalformedInputEnvelope(fallback, input);
    }
    return fallback;
  }
}

function warnAndRecoverMalformedToolInput(
  error: unknown,
  options: NormalizeModelToolInputOptions,
  inputContext: { inputLength: number } | { inputType: "null" },
): void {
  options.logger?.warn("Model tool input JSON normalization failed", {
    event: "model.tool_input.normalize_failed",
    ...inputContext,
    module: "adapters.model.tool-input-normalization",
    parseErrorType: parseErrorType(error),
    recovery: "empty_object",
    source: options.source,
    status: "failed",
    toolName: options.toolName,
  });
}

function stripByteOrderMark(input: string): string {
  return input.startsWith("\uFEFF") ? input.slice(1) : input;
}

function parseErrorType(error: unknown): string {
  return error instanceof Error && error.name ? error.name : typeof error;
}
