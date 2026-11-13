import { traceContextToLogContext } from "../deps.js";
import { appendTurnOutcomeEvent, createTurnFailureError } from "../helpers/index.js";
import {
  matchExecutionSelectionCreationFallback,
  resolveExecutionFallbackCandidates,
} from "./turn-execution-fallback.js";
import {
  MODEL_CREATION_FAILED_MESSAGE,
  MODEL_CREATION_TURN_PHASE,
  type TurnCommandContext,
} from "./turn-command-context.js";
import { createTurnModel, resolveExecutionModelRetryBudget } from "./turn-model.js";

/**
 * Создаёт модель исполнения и фиксирует fallback-факты.
 * При невозможности создать модель для /compact сразу пишет терминальное событие и бросает ошибку;
 * для обычного Turn ошибка сохраняется в состоянии, а персистенция и терминальный статус
 * остаются в основной стадии.
 */
export async function resolveTurnExecutionModel(ctx: TurnCommandContext): Promise<void> {
  const { runtime, options, turnAbortSignal, turnTraceContext, events } = ctx;
  const model = ctx.state.model;
  const { admittedModelSelection, highspeedFallbackSelection, compactInstructions } = ctx;
  const rewindCommand = ctx.rewindCommand;

  try {
    model.admittedModel =
      rewindCommand === null
        ? createTurnModel(runtime, {
            requestDependencies: options?.modelExecution?.requestDependencies,
            selection: admittedModelSelection,
            // 带退回声明的执行句柄 0 次重试：失败立刻交给 turn step 退回会话模型。
            retryBudget: resolveExecutionModelRetryBudget({
              selection: admittedModelSelection,
              selectionFallback: options?.modelExecution?.selectionFallback,
            }),
          })
        : undefined;
  } catch (error) {
    let reportedCreationError = error;
    const creationFallbackMatch = matchExecutionSelectionCreationFallback({
      error,
      selection: admittedModelSelection,
      selectionFallback: options?.modelExecution?.selectionFallback,
      selectionScope: options?.modelExecution?.selectionScope,
    });
    const selectionFallback = options?.modelExecution?.selectionFallback;
    if (creationFallbackMatch && admittedModelSelection && selectionFallback) {
      const skippedCandidates: Array<{
        source: string;
        providerId: string;
        modelId: string;
        error: string;
      }> = [];
      const candidates = resolveExecutionFallbackCandidates({
        declaredTarget: selectionFallback.target,
        executionProviderId: admittedModelSelection.providerId,
        sessionSelection: highspeedFallbackSelection,
      });
      for (const candidate of candidates) {
        try {
          model.admittedModel = createTurnModel(runtime, { selection: candidate.selection });
          model.effectiveExecutionSelection = candidate.selection;
          model.effectiveRequestDependencies = undefined;
          model.creationFallback = {
            reason: creationFallbackMatch.reason,
            fromModelSelection: admittedModelSelection,
            toModelSelection: candidate.selection,
          };
          runtime.logger?.warn(
            "Execution model selection was unavailable; falling back before the request",
            {
              ...traceContextToLogContext(turnTraceContext),
              event: "model.execution_selection.creation_fallback",
              module: "core.runtime",
              status: "completed",
              reason: creationFallbackMatch.reason,
              fromProviderId: admittedModelSelection.providerId,
              fromModelId: admittedModelSelection.modelId,
              toProviderId: candidate.selection.providerId,
              toModelId: candidate.selection.modelId,
              toSource: candidate.source,
              ...(skippedCandidates.length > 0 ? { skippedCandidates } : {}),
              errorMessage: error instanceof Error ? error.message : String(error),
            },
          );
          break;
        } catch (fallbackError) {
          // Highspeed 已确认不可用后，若普通模型也无法创建，用户应看到可操作的普通模型错误，
          // 不能继续暴露隐藏执行 Provider 的 Registry 错误。
          reportedCreationError = fallbackError;
          skippedCandidates.push({
            source: candidate.source,
            providerId: candidate.selection.providerId,
            modelId: candidate.selection.modelId,
            error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
          });
        }
      }
      if (!model.creationFallback) {
        model.creationFallbackUnavailable = true;
        runtime.logger?.warn(
          "Execution model selection was unavailable and no fallback model could be created",
          {
            ...traceContextToLogContext(turnTraceContext),
            event: "model.execution_selection.creation_fallback_unavailable",
            module: "core.runtime",
            status: "failed",
            reason: creationFallbackMatch.reason,
            fromProviderId: admittedModelSelection.providerId,
            fromModelId: admittedModelSelection.modelId,
            skippedCandidates,
            errorMessage: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }
    // Bug 根因：Provider/Model 在 Registry 中短暂缺失时，旧逻辑在请求前直接结束 Turn，
    // 请求期 selectionFallback 永远没有机会运行。成功创建声明目标后继续既有 Turn 主链。
    if (!model.admittedModel) {
      if (compactInstructions === null) {
        // Bug 根因：edit/retry 的 branch cut 已提交后，Registry 仍可能在 Core 创建模型前变化；
        // 已接纳输入必须提升为 TurnStarted + 持久消息，否则只剩历史截断，重启也无法恢复文本。
        // CR-01：上一版复制了一份落库流程并在主 try 外执行，附件、取消或存储失败会直接穿出，
        // TurnStarted 之后没有终态，原始创建错误也被覆盖。这里只记下错误，落库与终态交给主链。
        model.creationFailure = { error: reportedCreationError };
      } else {
        // /compact 不产生用户消息，创建失败直接写终态。
        ctx.state.turnFailureHandled = true;
        const coreError = createTurnFailureError(
          reportedCreationError,
          turnAbortSignal,
          MODEL_CREATION_FAILED_MESSAGE,
        );
        await appendTurnOutcomeEvent(runtime, {
          coreError,
          events,
          durationMs: Date.now() - ctx.turnStartedAtMs,
          turnPhase: MODEL_CREATION_TURN_PHASE,
          inputId: options?.inputId,
          // 卡身份仍以接纳时冻结的 intent 为准，不能依赖分页窗口中的 userInput 反查。
          highspeedCardId: options?.intent?.highspeed?.cardId,
          highspeedFallbackUnavailable: model.creationFallbackUnavailable,
          traceContext: turnTraceContext,
          fallbackMessage: MODEL_CREATION_FAILED_MESSAGE,
          logEvent: "turn.failed",
          logLabel: "Turn",
        });
        throw coreError;
      }
    }
  }
}
