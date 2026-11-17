/**
 * cli-tool-self-repair 对外契约：调用方要想正确调用就必须知道的一切都写在这里；其余对外不可见。
 * 每个方法注释写清：前置/后置条件、幂等性、发出哪些事件、是否等待持久化。
 */
import { z } from "zod";
import type { JsonSchema } from "@zcode/contracts";

export const TOOL_CALL_TRUNCATED_BY_MAX_TOKENS = "TOOL_CALL_TRUNCATED_BY_MAX_TOKENS" as const;

export const MAX_CONSECUTIVE_TOOL_SCHEMA_RETRIES = 2;

/**
 * Неперечисляемый символ для передачи сырой повреждённой JSON-строки от адаптера модели к ядру
 * без изменения публичной сериализуемой формы `ModelToolCall.input` (`JSON.stringify`).
 */
export const RAW_MALFORMED_TOOL_INPUT_SYMBOL = Symbol.for("zcode.model.rawMalformedToolInput");

export interface RawMalformedToolInputEnvelope {
  readonly rawText: string;
  readonly byteLength: number;
}

export const RepairStageSchema = z.enum([
  "strip_markdown_fences",
  "fix_trailing_commas",
  "escape_unescaped_control_chars",
  "unwrap_nested_arguments_key",
  "coerce_scalar_types_by_schema",
  "trim_parameter_keys",
  "alias_known_field_names",
]);

export type RepairStage = z.infer<typeof RepairStageSchema>;

export const ToolRepairAttemptRecordSchema = z.object({
  attemptIndex: z.number().int().nonnegative(),
  appliedStages: z.array(RepairStageSchema),
  repairedSuccessfully: z.boolean(),
  originalRawByteLength: z.number().int().nonnegative(),
  remainingValidationErrors: z.array(z.string()).max(10).optional(),
  durationMs: z.number().nonnegative(),
});

export type ToolRepairAttemptRecord = z.infer<typeof ToolRepairAttemptRecordSchema>;

export interface RepairToolInputParams {
  toolName: string;
  rawInput: unknown;
  inputJsonSchema: JsonSchema;
  runtimeZodSchema?: { safeParse(value: unknown): { success: boolean; data?: unknown; error?: unknown } };
  finishReason?: string;
  attemptIndex?: number;
  consecutiveFailureCount?: number;
}

export interface RepairToolInputResult {
  status:
    | "valid_as_is"
    | "repaired"
    | "unrecoverable_schema_error"
    | "skipped_due_to_truncation";
  repairedInput: unknown;
  record?: ToolRepairAttemptRecord;
  diagnosticFeedbackForModel?: string;
  retryLimitExceeded?: boolean;
}

export interface TruncationRecoveryPromptParams {
  toolCallId: string;
  toolName: string;
  maxOutputTokens?: number;
  reasoningTokens?: number;
  outputTokens?: number;
  rawInputBytes: number;
  rawTruncatedInputPreview?: string;
}

export interface IToolCallSelfRepair {
  /**
   * Выполняет детерминированное самовосстановление JSON и коэрцию скалярных/структурных типов
   * по схеме инструмента. При `finishReason === "length"` немедленно возвращает
   * `skipped_due_to_truncation` без попытки додумывать оборванный JSON.
   */
  repairToolInput(params: RepairToolInputParams): RepairToolInputResult;

  /**
   * Формирует детерминированный XML-ответ `<tool_use_error code="TOOL_CALL_TRUNCATED_BY_MAX_TOKENS">`
   * с диагностикой лимитов токенов и инструкцией декомпозиции записи файла.
   */
  buildTruncationRecoveryPrompt(params: TruncationRecoveryPromptParams): string;
}

export type CliToolSelfRepairId = string & { readonly __brand: "CliToolSelfRepairId" };

export interface CliToolSelfRepairContract {
  // TODO(cli-tool-self-repair): 一个意图一个方法，不超过 8 个。
}
