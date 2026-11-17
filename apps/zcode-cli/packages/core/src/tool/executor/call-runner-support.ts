import {
  type AgentTelemetryErrorCategory,
  CoreErrorType,
  createCoreError,
  type ToolExecutionSpanWriter,
  type TraceContext,
  type TurnId,
} from "@zcode/contracts";
import { OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION } from "@zcode/zcode-cua/frame-contract";
import { hasOfficialCuaFrameAuthority } from "../../mcp/image-normalization.js";
import { prepareInitialToolExecutionInput } from "../input-normalization.js";
import {
  mergeValidationModelContentWithSelfRepairDiff,
  runExecutorSelfRepairAdmission,
} from "../self-repair/index.js";
import type { ExecutableToolCall, ToolEntry, ToolExecutionResult } from "../types.js";
import { createErrorResult } from "./errors.js";
import { emitToolCallError } from "./events.js";
import { formatHookAdditionalContexts } from "./hook-flow.js";
import type { ToolExecuteOptions, ToolExecutorDeps } from "./types.js";
import { validateInitialModelToolInput } from "./validation.js";

const UNDISCOVERED_TOOL_SCHEMA_EXPLANATION =
  "\n\nThis tool's schema was not sent to the API — it was not in the discovered-tool set derived from message history. " +
  "Without the schema in your prompt, typed parameters (arrays, numbers, booleans) get emitted as strings and the client-side parser rejects them. ";

export async function admitAndPrepareToolCallInput(params: {
  readonly canonicalToolCall: ExecutableToolCall;
  readonly deps: ToolExecutorDeps;
  readonly entry: ToolEntry;
  readonly options?: ToolExecuteOptions;
  readonly pluginId?: string;
  readonly telemetry?: ToolExecutionSpanWriter;
  readonly traceContext: TraceContext;
  readonly turnId?: TurnId;
}): Promise<
  | {
      readonly ok: true;
      readonly executionInput: unknown;
      readonly repairAttempts?: ToolExecutionResult["repairAttempts"];
    }
  | {
      readonly ok: false;
      readonly errorResult: ToolExecutionResult;
    }
> {
  const { canonicalToolCall, deps, entry, options, pluginId, telemetry, traceContext, turnId } =
    params;
  const preparedInitialInput = prepareInitialToolExecutionInput({
    entry,
    input: canonicalToolCall.input,
    logger: deps.logger,
  });
  let executionInput = preparedInitialInput.input;
  const initialInputValidation = validateInitialModelToolInput(
    executionInput,
    entry,
    preparedInitialInput.runtimeValidationIssues,
  );
  const selfRepairAdmission = runExecutorSelfRepairAdmission({
    canonicalToolName: canonicalToolCall.name,
    rawInput: canonicalToolCall.input,
    initialPreparedInput: executionInput,
    initialValidationError: initialInputValidation,
    inputJsonSchema: entry.inputSchema,
    runtimeInputSchema: entry.runtimeInputSchema,
    finishReason: options?.finishReason,
    enableSelfRepair: deps.enableToolCallSelfRepair,
    failureTracker:
      options?.consecutiveSchemaFailuresByTool ?? deps.consecutiveSchemaFailuresByTool,
  });
  const repairAttempts = selfRepairAdmission.repairAttempts;
  if (!selfRepairAdmission.ok) {
    const validationError =
      initialInputValidation ??
      createCoreError(
        CoreErrorType.ToolExecutionFailed,
        "Tool input failed inputSchema validation",
        { recoverable: true },
      );
    const result: ToolExecutionResult = {
      ...createErrorResult(canonicalToolCall, validationError),
      ...(repairAttempts ? { repairAttempts } : {}),
      failureDiagnostics: selfRepairAdmission.failureDiagnostics,
    };
    const search = options?.toolSearch;
    const isUndiscoveredDeferred =
      search?.enabled &&
      !search.discovered.has(canonicalToolCall.name) &&
      search.catalog.some((tool) => tool.name === canonicalToolCall.name && tool.deferred);
    if (isUndiscoveredDeferred) {
      result.modelContent =
        (result.modelContent ?? validationError.message) +
        UNDISCOVERED_TOOL_SCHEMA_EXPLANATION +
        `Load the tool first: call ToolSearch with query "select:${canonicalToolCall.name}", then retry this call. ` +
        `For reference, this tool's input schema is: ${JSON.stringify(entry.inputSchema)}` +
        (search.mode === "local"
          ? `\nCall DeferredToolCall with {name: "${canonicalToolCall.name}", input: {...}}.`
          : "");
    } else if (typeof result.modelContent === "string") {
      result.modelContent = mergeValidationModelContentWithSelfRepairDiff(
        result.modelContent,
        selfRepairAdmission.diagnosticSuffix,
      );
    } else if (selfRepairAdmission.diagnosticSuffix) {
      result.modelContent = selfRepairAdmission.diagnosticSuffix;
    }
    await emitToolCallError(
      deps,
      canonicalToolCall.id,
      traceContext,
      turnId,
      result.error,
      undefined,
      pluginId,
    );
    telemetry?.finishFailed("validation", "parse", result.error);
    return { ok: false, errorResult: result };
  }
  if (selfRepairAdmission.executionInput !== executionInput) {
    executionInput = prepareInitialToolExecutionInput({
      entry,
      input: selfRepairAdmission.executionInput,
      logger: deps.logger,
    }).input;
  }
  return {
    ok: true,
    executionInput,
    ...(repairAttempts ? { repairAttempts } : {}),
  };
}

export function resolveModelOutputEntry(entry: ToolEntry, output: unknown): ToolEntry {
  const isSharedNodeRepl =
    entry.metadata.name === "mcp__node_repl__js" ||
    entry.metadata.mcpPresentation?.serverName === "node_repl";
  if (
    entry.modelContentProtection === OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION ||
    !isSharedNodeRepl ||
    !hasOfficialCuaFrameAuthority(output)
  ) {
    return entry;
  }
  return {
    ...entry,
    modelContentProtection: OFFICIAL_CUA_FRAME_MODEL_CONTENT_PROTECTION,
    resultBudget: {
      ...entry.resultBudget,
      maxInlineBytes: Math.max(entry.resultBudget.maxInlineBytes, 256 * 1024),
      maxModelBytes: Math.max(entry.resultBudget.maxModelBytes, 256 * 1024),
      strategy: "truncate",
      preview: { direction: "head" },
    },
  };
}

export function isEmptyToolName(toolName: string): boolean {
  return toolName.trim().length === 0;
}

export function errorCategoryForToolError(type: string | undefined): AgentTelemetryErrorCategory {
  switch (type) {
    case CoreErrorType.ConfigurationError:
    case CoreErrorType.ToolNotFound:
      return "configuration";
    case CoreErrorType.PermissionDenied:
    case CoreErrorType.PermissionEscalation:
    case CoreErrorType.PermissionTimeout:
      return "permission";
    case CoreErrorType.InvalidInput:
      return "parse";
    case CoreErrorType.ToolCancelled:
      return "cancelled";
    case CoreErrorType.ToolTimeout:
      return "timeout";
    default:
      return "internal";
  }
}

export function appendPreToolAdditionalContextsToErrorResult(
  result: ToolExecutionResult,
  additionalContexts: string[],
): ToolExecutionResult {
  if (result.success || !result.error || additionalContexts.length === 0) return result;

  // PreToolUse deny 和权限拒绝会在 handler 前提前返回，旧逻辑只在 handler 的
  // 成功/异常路径追加 context，导致 Hook 明明返回了 additionalContext，模型却看不到。
  const baseModelContent =
    typeof result.modelContent === "string" ? result.modelContent : result.error.message;
  return {
    ...result,
    modelContent: [baseModelContent, formatHookAdditionalContexts(additionalContexts)].join("\n\n"),
  };
}
