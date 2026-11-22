import type {
  JsonSchema,
  PersistedToolFailureDiagnostics,
  PersistedToolRepairAttemptRecord,
} from "@zcode/contracts";
import { validateJsonSchemaValue } from "../json-schema.js";
import {
  MAX_CONSECUTIVE_TOOL_SCHEMA_RETRIES,
  RAW_MALFORMED_TOOL_INPUT_SYMBOL,
  RepairStageSchema,
  TOOL_CALL_TRUNCATED_BY_MAX_TOKENS,
  ToolRepairAttemptRecordSchema,
  type IToolCallSelfRepair,
  type RawMalformedToolInputEnvelope,
  type RepairStage,
  type RepairToolInputParams,
  type RepairToolInputResult,
  type ToolRepairAttemptRecord,
  type TruncationRecoveryPromptParams,
} from "./contract.js";
import {
  attachRawMalformedToolInput,
  readRawMalformedToolInput,
  repairJsonStringDeterministic,
  utf8ByteLength,
} from "./json-repair.js";
import {
  MAX_TRUNCATED_INPUT_PREVIEW_CHARS,
  buildTruncationRecoveryPrompt,
  extractTruncatedInputSnapshot,
  synthesizeTruncatedToolCallSettlements,
  type SynthesizedTruncatedToolEntry,
  type TruncatedToolInspectionItem,
} from "./truncation-recovery.js";
import { buildSchemaDiffDiagnosticFeedback, coerceInputBySchema } from "./zod-coercion.js";

export {
  MAX_CONSECUTIVE_TOOL_SCHEMA_RETRIES,
  MAX_TRUNCATED_INPUT_PREVIEW_CHARS,
  RAW_MALFORMED_TOOL_INPUT_SYMBOL,
  RepairStageSchema,
  TOOL_CALL_TRUNCATED_BY_MAX_TOKENS,
  ToolRepairAttemptRecordSchema,
  attachRawMalformedToolInput,
  buildSchemaDiffDiagnosticFeedback,
  buildTruncationRecoveryPrompt,
  coerceInputBySchema,
  extractTruncatedInputSnapshot,
  readRawMalformedToolInput,
  repairJsonStringDeterministic,
  synthesizeTruncatedToolCallSettlements,
  type IToolCallSelfRepair,
  type RawMalformedToolInputEnvelope,
  type RepairStage,
  type RepairToolInputParams,
  type RepairToolInputResult,
  type SynthesizedTruncatedToolEntry,
  type ToolRepairAttemptRecord,
  type TruncatedToolInspectionItem,
  type TruncationRecoveryPromptParams,
};

export function createToolCallSelfRepair(): IToolCallSelfRepair {
  return {
    repairToolInput(params: RepairToolInputParams): RepairToolInputResult {
      if (params.finishReason === "length") {
        return {
          status: "skipped_due_to_truncation",
          repairedInput: params.rawInput,
        };
      }

      const startedAt = performance.now();
      const rawEnvelope = readRawMalformedToolInput(params.rawInput);
      const originalRawByteLength = rawEnvelope
        ? rawEnvelope.byteLength
        : estimateRawByteLength(params.rawInput);

      // Быстрый путь: нет сырого битого JSON, и вход уже валиден по runtimeZodSchema + JSON Schema
      if (!rawEnvelope) {
        const directCheck = validateCandidate(params.rawInput, params);
        if (directCheck.valid) {
          return {
            status: "valid_as_is",
            repairedInput: directCheck.data,
          };
        }
      }

      const appliedStages: RepairStage[] = [];
      const pushStage = (stage: RepairStage) => {
        if (!appliedStages.includes(stage)) appliedStages.push(stage);
      };

      let candidate: unknown = params.rawInput;
      let jsonParseError: string | undefined;

      if (rawEnvelope) {
        const jsonRepaired = repairJsonStringDeterministic(rawEnvelope.rawText);
        for (const stage of jsonRepaired.appliedStages) {
          pushStage(stage);
        }
        if (jsonRepaired.ok) {
          candidate = jsonRepaired.value;
        } else {
          jsonParseError = jsonRepaired.parseError;
          // Если JSON не удалось безопасно восстановить (например оборванная строка),
          // оставляем пустой объект только для генерации точной дифф-диагностики полей схемы.
          candidate = typeof params.rawInput === "string" ? {} : params.rawInput;
        }
      }

      if (!jsonParseError) {
        const coerced = coerceInputBySchema(candidate, params.inputJsonSchema);
        candidate = coerced.value;
        for (const stage of coerced.appliedStages) {
          pushStage(stage);
        }
      }

      const postValidation = jsonParseError
        ? { valid: false as const, errors: [`Invalid JSON syntax: ${jsonParseError}`] }
        : validateCandidate(candidate, params);

      const durationMs = Math.max(0, performance.now() - startedAt);
      const attemptIndex = params.attemptIndex ?? 0;

      if (postValidation.valid) {
        const record: ToolRepairAttemptRecord = {
          attemptIndex,
          appliedStages,
          repairedSuccessfully: true,
          originalRawByteLength,
          durationMs,
        };
        return {
          status: appliedStages.length > 0 ? "repaired" : "valid_as_is",
          repairedInput: postValidation.data,
          record,
        };
      }

      const consecutiveFailureCount = params.consecutiveFailureCount ?? 1;
      const remainingValidationErrors = postValidation.errors.slice(0, 10);
      const record: ToolRepairAttemptRecord = {
        attemptIndex,
        appliedStages,
        repairedSuccessfully: false,
        originalRawByteLength,
        remainingValidationErrors,
        durationMs,
      };

      const diagnosticFeedbackForModel = buildSchemaDiffDiagnosticFeedback({
        toolName: params.toolName,
        receivedInput: candidate,
        inputJsonSchema: params.inputJsonSchema,
        validationErrors: remainingValidationErrors,
        consecutiveFailureCount,
      });

      return {
        status: "unrecoverable_schema_error",
        repairedInput: candidate,
        record,
        diagnosticFeedbackForModel,
        retryLimitExceeded: consecutiveFailureCount >= MAX_CONSECUTIVE_TOOL_SCHEMA_RETRIES,
      };
    },

    buildTruncationRecoveryPrompt,
  };
}

export const defaultToolCallSelfRepair: IToolCallSelfRepair = createToolCallSelfRepair();

export function runExecutorSelfRepairAdmission(params: {
  canonicalToolName: string;
  rawInput: unknown;
  initialPreparedInput: unknown;
  initialValidationError: Error | undefined;
  inputJsonSchema: JsonSchema;
  runtimeInputSchema?: unknown;
  finishReason?: string;
  enableSelfRepair?: boolean;
  failureTracker?: Map<string, number>;
}):
  | {
      ok: true;
      executionInput: unknown;
      repairAttempts?: PersistedToolRepairAttemptRecord[];
    }
  | {
      ok: false;
      repairAttempts?: PersistedToolRepairAttemptRecord[];
      failureDiagnostics: PersistedToolFailureDiagnostics;
      diagnosticSuffix?: string;
      retryLimitExceeded: boolean;
    } {
  const rawEnvelope = readRawMalformedToolInput(params.rawInput);
  if (!params.initialValidationError && !rawEnvelope) {
    params.failureTracker?.delete(params.canonicalToolName);
    return {
      ok: true,
      executionInput: params.initialPreparedInput,
    };
  }

  const prevFailures = params.failureTracker?.get(params.canonicalToolName) ?? 0;
  const nextFailures = prevFailures + 1;

  if (params.enableSelfRepair === false || params.finishReason === "length") {
    params.failureTracker?.set(params.canonicalToolName, nextFailures);
    const snapshot = extractTruncatedInputSnapshot(params.rawInput);
    const truncationPrompt =
      params.finishReason === "length"
        ? buildTruncationRecoveryPrompt({
            toolName: params.canonicalToolName,
            toolCallId: "truncated_call",
            rawInputBytes: snapshot.rawInputBytes,
          })
        : undefined;
    return {
      ok: false,
      failureDiagnostics: {
        failureKind:
          params.finishReason === "length"
            ? "truncated_by_max_tokens"
            : snapshot.hasMalformedRawEnvelope
              ? "invalid_json"
              : "schema_validation_failed",
        rawTruncatedInputPreview: snapshot.rawTruncatedInputPreview,
        rawTruncatedInputTotalBytes: snapshot.rawInputBytes,
      },
      ...(truncationPrompt ? { diagnosticSuffix: truncationPrompt } : {}),
      retryLimitExceeded: nextFailures >= MAX_CONSECUTIVE_TOOL_SCHEMA_RETRIES,
    };
  }

  const runtimeZodSchema =
    params.runtimeInputSchema &&
    typeof params.runtimeInputSchema === "object" &&
    "safeParse" in params.runtimeInputSchema &&
    typeof (params.runtimeInputSchema as { safeParse?: unknown }).safeParse === "function"
      ? (params.runtimeInputSchema as RepairToolInputParams["runtimeZodSchema"])
      : undefined;

  const repairOutcome = defaultToolCallSelfRepair.repairToolInput({
    toolName: params.canonicalToolName,
    rawInput: params.rawInput,
    inputJsonSchema: params.inputJsonSchema,
    runtimeZodSchema,
    finishReason: params.finishReason,
    attemptIndex: prevFailures,
    consecutiveFailureCount: nextFailures,
  });

  const repairAttempts = repairOutcome.record ? [repairOutcome.record] : undefined;

  if (repairOutcome.status === "repaired" || repairOutcome.status === "valid_as_is") {
    params.failureTracker?.delete(params.canonicalToolName);
    return {
      ok: true,
      executionInput: repairOutcome.repairedInput,
      ...(repairAttempts ? { repairAttempts } : {}),
    };
  }

  params.failureTracker?.set(params.canonicalToolName, nextFailures);
  const snapshot = extractTruncatedInputSnapshot(params.rawInput);
  return {
    ok: false,
    ...(repairAttempts ? { repairAttempts } : {}),
    failureDiagnostics: {
      failureKind: snapshot.hasMalformedRawEnvelope ? "invalid_json" : "schema_validation_failed",
      rawTruncatedInputPreview: snapshot.rawTruncatedInputPreview,
      rawTruncatedInputTotalBytes: snapshot.rawInputBytes,
      ...(repairAttempts ? { repairAttempts } : {}),
    },
    diagnosticSuffix: repairOutcome.diagnosticFeedbackForModel,
    retryLimitExceeded: repairOutcome.retryLimitExceeded === true,
  };
}

export function mergeValidationModelContentWithSelfRepairDiff(
  baseModelContent: string | undefined,
  diagnosticFeedback: string | undefined,
): string | undefined {
  if (!diagnosticFeedback) return baseModelContent;
  if (!baseModelContent) return diagnosticFeedback;
  const innerFeedback = diagnosticFeedback
    .replace(/^<tool_use_error[^>]*>\n?/u, "")
    .replace(/\n?<\/tool_use_error>$/u, "");
  if (baseModelContent.endsWith("</tool_use_error>")) {
    return `${baseModelContent.slice(0, -"</tool_use_error>".length)}\n\n${innerFeedback}</tool_use_error>`;
  }
  return `${baseModelContent}\n\n${innerFeedback}`;
}

function validateCandidate(
  candidate: unknown,
  params: RepairToolInputParams,
): { valid: true; data: unknown } | { valid: false; errors: string[] } {
  let resolvedValue = candidate;
  const runtimeErrors: string[] = [];

  if (params.runtimeZodSchema && typeof params.runtimeZodSchema.safeParse === "function") {
    const parsed = params.runtimeZodSchema.safeParse(resolvedValue);
    if (parsed.success) {
      resolvedValue = parsed.data ?? resolvedValue;
    } else {
      runtimeErrors.push(...extractZodIssueMessages(parsed.error));
    }
  }

  const jsonValidation = validateJsonSchemaValue(resolvedValue, params.inputJsonSchema);
  if (jsonValidation.valid && runtimeErrors.length === 0) {
    return { valid: true, data: resolvedValue };
  }

  const errors = [...new Set([...jsonValidation.errors, ...runtimeErrors])];
  return {
    valid: false,
    errors: errors.length > 0 ? errors : ["Input failed tool schema validation"],
  };
}

function extractZodIssueMessages(error: unknown): string[] {
  if (!error || typeof error !== "object") return [];
  const issues = (error as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return [];
  return issues.flatMap((issue) => {
    if (!issue || typeof issue !== "object") return [];
    const path = Array.isArray((issue as { path?: unknown }).path)
      ? ((issue as { path: Array<string | number> }).path.join(".") || "<root>")
      : "<root>";
    const message =
      typeof (issue as { message?: unknown }).message === "string"
        ? (issue as { message: string }).message
        : "Invalid value";
    return [`${path}: ${message}`];
  });
}

function estimateRawByteLength(value: unknown): number {
  try {
    return utf8ByteLength(JSON.stringify(value ?? null));
  } catch {
    return 0;
  }
}
