import {
  CoreErrorType,
  createPartId,
  type ModelToolCall,
  type PartId,
  type ToolCallId,
} from "@zcode/contracts";
import { validateJsonSchemaValue } from "../json-schema.js";
import type { ToolEntry, ToolExecutionResult } from "../types.js";
import {
  TOOL_CALL_TRUNCATED_BY_MAX_TOKENS,
  type TruncationRecoveryPromptParams,
} from "./contract.js";
import { readRawMalformedToolInput, utf8ByteLength } from "./json-repair.js";

export const MAX_TRUNCATED_INPUT_PREVIEW_CHARS = 16_384;

export function buildTruncationRecoveryPrompt(params: TruncationRecoveryPromptParams): string {
  const maxTokensLabel =
    params.maxOutputTokens !== undefined ? String(params.maxOutputTokens) : "provider_limit";
  const metrics = [
    `maxOutputTokens=${maxTokensLabel}`,
    ...(params.reasoningTokens !== undefined ? [`reasoningTokens=${params.reasoningTokens}`] : []),
    ...(params.outputTokens !== undefined ? [`outputTokens=${params.outputTokens}`] : []),
    `rawInputBytes=${params.rawInputBytes}`,
  ].join(", ");

  const isFileMutationTool =
    params.toolName === "Write" ||
    params.toolName === "Edit" ||
    params.toolName === "ApplyPatch" ||
    params.toolName === "MultiEdit";

  const recoverySteps = isFileMutationTool
    ? [
        `1. Do NOT retry writing the entire large file in a single ${params.toolName} call.`,
        `2. First create a minimal valid module skeleton (<= 200 lines) with Write.`,
        `3. Add remaining functions/sections incrementally using Edit or ApplyPatch.`,
      ]
    : [
        `1. Do NOT retry emitting the entire oversized "${params.toolName}" payload in a single tool call.`,
        `2. Split the operation into smaller incremental tool calls with compact arguments.`,
        `3. Keep reasoning concise before emitting large structured tool arguments.`,
      ];

  return [
    `<tool_use_error code="${TOOL_CALL_TRUNCATED_BY_MAX_TOKENS}">`,
    `[${TOOL_CALL_TRUNCATED_BY_MAX_TOKENS}] Tool call "${params.toolName}" (id: ${params.toolCallId}) was truncated because the response hit ${metrics}.`,
    `REQUIRED RECOVERY ACTION:`,
    ...recoverySteps,
    `</tool_use_error>`,
  ].join("\n");
}

export interface TruncatedToolInspectionItem {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly truncated: boolean;
  readonly rawInputBytes: number;
  readonly rawTruncatedInputPreview?: string;
}

export function extractTruncatedInputSnapshot(rawInput: unknown): {
  hasMalformedRawEnvelope: boolean;
  rawInputBytes: number;
  rawTruncatedInputPreview?: string;
} {
  const rawEnvelope = readRawMalformedToolInput(rawInput);
  if (rawEnvelope) {
    return {
      hasMalformedRawEnvelope: true,
      rawInputBytes: rawEnvelope.byteLength,
      rawTruncatedInputPreview: truncatePreview(rawEnvelope.rawText),
    };
  }

  try {
    const serialized = JSON.stringify(rawInput ?? {});
    return {
      hasMalformedRawEnvelope: false,
      rawInputBytes: utf8ByteLength(serialized),
      rawTruncatedInputPreview: truncatePreview(serialized),
    };
  } catch {
    const fallback = String(rawInput ?? "");
    return {
      hasMalformedRawEnvelope: false,
      rawInputBytes: utf8ByteLength(fallback),
      rawTruncatedInputPreview: truncatePreview(fallback),
    };
  }
}

export interface SynthesizedTruncatedToolEntry {
  readonly input: Record<string, unknown>;
  readonly ledgerRecorded: false;
  readonly partID: PartId;
  readonly result: ToolExecutionResult;
  readonly toolCallId: ToolCallId;
}

/**
 * Для шага модели с `finishReason === "length"` отделяет завершённые без потерь read-only вызовы
 * в начале пакета от оборванных/мутирующих вызовов и синтезирует `TOOL_CALL_TRUNCATED_BY_MAX_TOKENS`
 * без слепого угадывания JSON-хвоста (F-01).
 */
export function synthesizeTruncatedToolCallSettlements(params: {
  toolCalls: readonly ModelToolCall[];
  existingStreamedIds: ReadonlySet<string>;
  resolveEntry: (name: string) => ToolEntry | undefined;
  maxOutputTokens?: number;
  reasoningTokens?: number;
  outputTokens?: number;
}): SynthesizedTruncatedToolEntry[] {
  const synthesized: SynthesizedTruncatedToolEntry[] = [];

  for (const toolCall of params.toolCalls) {
    const snapshot = extractTruncatedInputSnapshot(toolCall.input);
    const entry = params.resolveEntry(toolCall.name);

    const alreadyCompletedSafelyDuringStream =
      params.existingStreamedIds.has(toolCall.id) && !snapshot.hasMalformedRawEnvelope;
    if (alreadyCompletedSafelyDuringStream) {
      continue;
    }

    const runtimeZodSchema =
      entry?.runtimeInputSchema &&
      typeof entry.runtimeInputSchema === "object" &&
      "safeParse" in entry.runtimeInputSchema &&
      typeof (entry.runtimeInputSchema as { safeParse?: unknown }).safeParse === "function"
        ? (entry.runtimeInputSchema as { safeParse(v: unknown): { success: boolean } })
        : undefined;

    const isValidCompleteToolCall =
      !snapshot.hasMalformedRawEnvelope &&
      typeof toolCall.input === "object" &&
      toolCall.input !== null &&
      !Array.isArray(toolCall.input) &&
      entry !== undefined &&
      validateJsonSchemaValue(toolCall.input, entry.inputSchema).valid &&
      (runtimeZodSchema ? runtimeZodSchema.safeParse(toolCall.input).success : true);

    if (isValidCompleteToolCall) {
      continue;
    }

    const now = new Date();
    const modelContent = buildTruncationRecoveryPrompt({
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      maxOutputTokens: params.maxOutputTokens,
      reasoningTokens: params.reasoningTokens,
      outputTokens: params.outputTokens,
      rawInputBytes: snapshot.rawInputBytes,
      rawTruncatedInputPreview: snapshot.rawTruncatedInputPreview,
    });
    const message = `Tool call "${toolCall.name}" was truncated because output hit maxOutputTokens${params.maxOutputTokens !== undefined ? `=${params.maxOutputTokens}` : ""} (rawInputBytes=${snapshot.rawInputBytes}).`;
    const recordInput =
      typeof toolCall.input === "object" &&
      toolCall.input !== null &&
      !Array.isArray(toolCall.input)
        ? (toolCall.input as Record<string, unknown>)
        : {};

    synthesized.push({
      toolCallId: toolCall.id as ToolCallId,
      partID: createPartId(),
      input: recordInput,
      ledgerRecorded: false,
      result: {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        success: false,
        output: null,
        modelContent,
        failureDiagnostics: {
          failureKind: "truncated_by_max_tokens",
          rawTruncatedInputPreview: snapshot.rawTruncatedInputPreview,
          rawTruncatedInputTotalBytes: snapshot.rawInputBytes,
        },
        error: {
          code: TOOL_CALL_TRUNCATED_BY_MAX_TOKENS,
          type: CoreErrorType.ToolExecutionFailed,
          message,
        },
        durationMs: 0,
        startedAt: now,
        completedAt: now,
      },
    });
  }

  return synthesized;
}

function truncatePreview(value: string): string {
  if (value.length <= MAX_TRUNCATED_INPUT_PREVIEW_CHARS) {
    return value;
  }
  return value.slice(0, MAX_TRUNCATED_INPUT_PREVIEW_CHARS);
}
