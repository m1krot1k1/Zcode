import type {
  JSONValue,
  LanguageModelV3Prompt,
  LanguageModelV3ToolResultOutput,
} from "@ai-sdk/provider";
import { APICallError } from "@ai-sdk/provider";
import type { Logger } from "@zcode/contracts";
import { asRecord } from "./record-utils.js";

/** Cursor schema `result.subtype` — единственный авторитетный признак успеха. */
interface CursorResultEvent {
  readonly isError: boolean;
  readonly subtype: string | undefined;
  readonly text: string | undefined;
}

export interface CursorToolCallEvent {
  readonly callId: string;
  readonly toolName: string;
  readonly input: string;
  readonly result: NonNullable<JSONValue> | undefined;
}

export type CursorParsedEvent =
  | { readonly type: "assistant-text"; readonly text: string }
  | { readonly type: "reasoning-delta"; readonly text: string }
  | { readonly type: "reasoning-end" }
  | { readonly type: "tool-call-start"; readonly call: CursorToolCallEvent }
  | { readonly type: "tool-call-complete"; readonly call: CursorToolCallEvent }
  | { readonly type: "result"; readonly result: CursorResultEvent };

export function parseCursorLine(line: string, logger: Logger | undefined): CursorParsedEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // Не-JSON строки в stdout (например, предупреждения Cursor) не должны рвать поток.
    logger?.debug("cursor-agent non-JSON stdout line", { line: line.slice(0, 512) });
    return undefined;
  }
  const record = asRecord(parsed);
  if (!record) return undefined;
  const type = record.type;
  if (type === "assistant") {
    // Причина: --stream-partial-output печатает и дельты (timestamp_ms без model_call_id),
    // и финальное агрегированное сообщение. Дедупликация по документированному правилу.
    if (record.timestamp_ms === undefined || record.model_call_id !== undefined) return undefined;
    const message = asRecord(record.message);
    const content = message?.content;
    if (!Array.isArray(content)) return undefined;
    const text = content
      .map((part) => {
        const entry = asRecord(part);
        return entry?.type === "text" && typeof entry.text === "string" ? entry.text : "";
      })
      .join("");
    return text.length > 0 ? { type: "assistant-text", text } : undefined;
  }
  if (type === "thinking") {
    const subtype = typeof record.subtype === "string" ? record.subtype : undefined;
    if (subtype === "delta" && typeof record.text === "string" && record.text.length > 0) {
      return { type: "reasoning-delta", text: record.text };
    }
    if (subtype === "completed" || subtype === "end") {
      return { type: "reasoning-end" };
    }
    return undefined;
  }
  if (type === "tool_call") {
    const subtype = record.subtype;
    if (subtype !== "started" && subtype !== "completed") return undefined;
    const callId = typeof record.call_id === "string" ? record.call_id : undefined;
    if (!callId) return undefined;
    const toolCall = asRecord(record.tool_call);
    if (!toolCall) return undefined;
    const key = Object.keys(toolCall)[0];
    if (!key) return undefined;
    const value = asRecord(toolCall[key]) ?? {};
    const rawInput = value.args ?? value.arguments ?? {};
    if (subtype === "started") {
      return {
        type: "tool-call-start",
        call: {
          callId,
          toolName: key,
          input: safeStringify(rawInput),
          result: undefined,
        },
      };
    }
    return {
      type: "tool-call-complete",
      call: {
        callId,
        toolName: key,
        input: safeStringify(rawInput),
        result: toToolResult(value.result ?? value.success ?? value),
      },
    };
  }
  if (type === "result") {
    const subtype = typeof record.subtype === "string" ? record.subtype : undefined;
    return {
      type: "result",
      result: {
        isError: record.is_error === true || subtype !== "success",
        subtype,
        text: typeof record.result === "string" ? record.result : undefined,
      },
    };
  }
  return undefined;
}

function toToolResult(value: unknown): NonNullable<JSONValue> {
  const record = asRecord(value);
  const candidate = record && "result" in record ? record.result : value;
  try {
    const serialized = JSON.stringify(candidate);
    if (serialized === undefined) return { value: String(candidate) };
    return JSON.parse(serialized) as NonNullable<JSONValue>;
  } catch {
    return { value: String(candidate) };
  }
}

function safeStringify(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? "{}" : serialized;
  } catch {
    return "{}";
  }
}

export function buildCursorArgs(
  modelId: string,
  cwd: string,
  force: boolean,
  prompt: string,
): readonly string[] {
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--model",
    modelId,
    "--workspace",
    cwd,
    ...(force ? ["--force"] : []),
    // cursor-agent принимает prompt позиционным аргументом; без него `-p` ждёт stdin.
    prompt,
  ];
}

export function projectPrompt(prompt: LanguageModelV3Prompt): string {
  const blocks: string[] = [];
  for (const message of prompt) {
    switch (message.role) {
      case "system":
        if (message.content.trim()) blocks.push(message.content);
        break;
      case "user": {
        const text = message.content
          .map((part) =>
            part.type === "text" ? part.text : `[file: ${part.mediaType}]`,
          )
          .join("");
        if (text.trim()) blocks.push(text);
        break;
      }
      case "assistant": {
        const text = message.content
          .map((part) => {
            switch (part.type) {
              case "text":
                return part.text;
              case "tool-call":
                return `[tool-call ${part.toolName} ${safeStringify(part.input)}]`;
              case "tool-result":
                return `[tool-result ${part.toolName}] ${stringifyToolResultOutput(part.output)}`;
              case "file":
                return `[file: ${part.mediaType}]`;
              case "reasoning":
                return "";
            }
          })
          .filter((part) => part.length > 0)
          .join("\n");
        if (text.trim()) blocks.push(`Assistant:\n${text}`);
        break;
      }
      case "tool": {
        const text = message.content
          .map((part) => {
            if (part.type === "tool-result") {
              return `[tool-result ${part.toolName}] ${stringifyToolResultOutput(part.output)}`;
            }
            const approved = part.approved ? "approved" : "denied";
            return `[tool-approval ${approved}${part.reason ? `: ${part.reason}` : ""}]`;
          })
          .join("\n");
        if (text.trim()) blocks.push(text);
        break;
      }
    }
  }
  return blocks.join("\n\n");
}

function stringifyToolResultOutput(output: LanguageModelV3ToolResultOutput): string {
  switch (output.type) {
    case "text":
    case "error-text":
      return output.value;
    case "json":
    case "error-json":
      return safeStringify(output.value);
    case "execution-denied":
      return `[execution denied${output.reason ? `: ${output.reason}` : ""}]`;
    case "content":
      return output.value
        .map((part) => {
          if (part.type === "text") return part.text;
          if (part.type === "file-url") return `[file: ${part.url}]`;
          if ("mediaType" in part) return `[file: ${part.mediaType}]`;
          return "[file]";
        })
        .join("\n");
  }
}

export function createCursorResultError(result: CursorResultEvent, stderr: string): Error {
  const message = result.text?.trim() || stderr.trim() || `cursor-agent result: ${result.subtype}`;
  return new APICallError({
    message: `Cursor CLI вернул ошибку: ${message}`,
    url: "cursor-cli://local",
    requestBodyValues: {},
    responseBody: stderr,
    isRetryable: false,
  });
}
