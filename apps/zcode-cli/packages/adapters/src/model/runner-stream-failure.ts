import type { TextStreamPart, ToolSet } from "ai";
import type { Logger, ModelStatusSink } from "@zcode/contracts";
import {
  ModelErrorCode,
  ModelFailureReason as ModelFailureReasonValue,
  ModelProtocolError,
  ModelRetryReason,
  type ModelRetryBudget,
} from "@zcode/contracts";
import {
  classifyModelFailure,
  type ClassifiedModelFailure,
} from "./failure-classifier.js";
import { getResponseHeaders, unwrapRetryError } from "./failure-inspection.js";
import { offPeakTicketExpiredMessage, resolveOffPeakFailureDecision } from "./offpeak-retry.js";
import {
  createStreamDiagnostics,
  logStreamFailureDiagnostics,
} from "./runner-diagnostics.js";
import { recordStreamTextDebug } from "./runner-debug.js";
import type { createStreamTextOptions } from "./runner-options.js";
import { AiSdkModelAdapterError } from "./errors.js";
import {
  calculateRetryDelay,
  logRetryDelayDecision,
  sleep,
  TerminalStreamChunkError,
  toAdapterError,
} from "./runner-retry.js";
import { sanitizeModelNetworkHeaders } from "./runner-network-headers.js";
import type { ResolvedAiSdkModelRetryOptions } from "./retry-policy.js";
import type {
  AiSdkModelTextRequest,
  AiSdkStreamTextResult,
  ResolvedAiSdkModel,
} from "./runner-runtime.js";
import { AccountRequestRetry } from "./account-request-retry.js";
import { RuntimeHeadersRefreshError } from "./runner-runtime-headers.js";
import { modelFailureStatusFields, readModelFailureErrorPhase } from "./runner-telemetry.js";
import { createStatusContext, publishModelStatus } from "./runner-status.js";
import type { AttemptAdmission } from "./request-admission.js";
import { StreamingToolCallAssembler } from "./streaming-tool-call-assembler.js";
import {
  publishRetryScheduledStatus,
  resolveStreamFailureDecision,
  statusPublishOptions,
} from "./runner-stream-handlers.js";

/** 单次 stream 尝试失败后的控制流结果。`retry` 为真时由外层 for 继续下一次尝试。 */
export interface StreamAttemptFailureOutcome {
  /** true → 回到尝试循环；false → 用 `error` 抛出。 */
  retry: boolean;
  /** off-peak 排队不消耗重试预算：外层 for 自增后需要回退计数。 */
  attemptRewind: boolean;
  /** 交给外层 finally 的 iterator 清理策略。 */
  awaitIteratorClose: boolean;
  /** 已发布失败终态，finally 不应再补发 cancelled 状态。 */
  terminalStatusPublished: boolean;
  error?: unknown;
}

/**
 * 处理一次 stream 尝试的失败：记录 model-io、分类失败、发布失败/重试状态并等待退避。
 * 原样搬运自 `runStreamText` 的 catch 分支；控制流以返回值表达，状态标志显式回传，
 * 保证 yield/await 顺序与外层 finally 语义不变。
 */
export async function handleStreamAttemptFailure(input: {
  admission: AttemptAdmission;
  attempt: number;
  attemptRequest: AiSdkModelTextRequest;
  authRetry: AccountRequestRetry;
  diagnostics: ReturnType<typeof createStreamDiagnostics>;
  emittedError: boolean;
  emittedEvent: boolean;
  emittedRetryBoundaryEvent: boolean;
  error: unknown;
  isDev: boolean;
  modelInput: {
    debugDir?: string;
    logger?: Logger;
    modelIoFullRetentionEnabled: boolean;
    request: AiSdkModelTextRequest;
    resolved: ResolvedAiSdkModel;
    retry: ResolvedAiSdkModelRetryOptions;
    statusSink?: ModelStatusSink;
  };
  options?: ReturnType<typeof createStreamTextOptions>;
  /** 签名修复标志可能被 `repairThinkingSignatureRejection` 改写，必须读取实时值。 */
  readSignatureRepairAttempted: () => boolean;
  recordModelIO: boolean;
  repairThinkingSignatureRejection: (error: unknown) => boolean;
  requestHeaderCount: number;
  requestHeaders: Record<string, string>;
  resolved: ResolvedAiSdkModel;
  result?: AiSdkStreamTextResult;
  retryBudget?: ModelRetryBudget;
  retryBudgetAttempt: number;
  startedAt: number;
  statusContext: ReturnType<typeof createStatusContext>;
  statusMaxAttempts: (extraAttempts: number) => number;
  streamIterator: AsyncIterator<TextStreamPart<ToolSet>> | undefined;
  streamOutputCommitted: boolean;
  toolCallAssembler: StreamingToolCallAssembler;
}): Promise<StreamAttemptFailureOutcome> {
  const {
    admission,
    attempt,
    attemptRequest,
    authRetry,
    diagnostics,
    emittedError,
    emittedEvent,
    emittedRetryBoundaryEvent,
    error,
    isDev,
    modelInput,
    options,
    readSignatureRepairAttempted,
    recordModelIO,
    repairThinkingSignatureRejection,
    requestHeaderCount,
    requestHeaders,
    resolved,
    result,
    retryBudget,
    retryBudgetAttempt,
    startedAt,
    statusMaxAttempts,
    streamIterator,
    streamOutputCommitted,
    toolCallAssembler,
  } = input;
  let statusContext = input.statusContext;

  if (recordModelIO && options) {
    await recordStreamTextDebug({
      modelIoFullRetentionEnabled: modelInput.modelIoFullRetentionEnabled,
      attempt,
      debugDir: modelInput.debugDir,
      error,
      isDev,
      normalizedToolCalls: toolCallAssembler.snapshotNormalizedToolCalls(),
      options,
      recordModelIO,
      request: attemptRequest,
      requestId: statusContext.requestId,
      resolved,
      result,
      startedAt,
    });
  }
  if (error instanceof TerminalStreamChunkError) {
    return {
      attemptRewind: false,
      awaitIteratorClose: true,
      error: error.adapterError,
      retry: false,
      terminalStatusPublished: false,
    };
  }
  if (error instanceof ModelProtocolError && error.code === ModelErrorCode.ModelRequestAuthMissing) {
    // stream 在 attempt try 内解析请求鉴权，过去会把网络前的类型化
    // 鉴权缺失错误重新归一化为通用请求失败；generate 则直接保留原始协议错误。
    return {
      attemptRewind: false,
      awaitIteratorClose: false,
      error,
      retry: false,
      terminalStatusPublished: false,
    };
  }

  const completedAt = Date.now();
  const retryWithRepairedHistory =
    !emittedRetryBoundaryEvent && repairThinkingSignatureRejection(error);
  if (retryWithRepairedHistory) {
    statusContext = {
      ...statusContext,
      maxAttempts: statusMaxAttempts(1 + authRetry.extraAttempts),
    };
  }
  const classified = classifyModelFailure(error, modelInput.request.abortSignal);
  if (error instanceof RuntimeHeadersRefreshError) {
    classified.message = error.message;
    classified.retryable = false;
  }
  // off-peak 特判（仅 idle plan provider）：排队 429 豁免预算无限探测；3102 标记落败触发续跑。
  const offPeak = resolveOffPeakFailureDecision({
    offPeak: resolved.accountAccess?.mode === "off-peak",
    failure: classified,
    error: unwrapRetryError(error),
  });
  const failure: ClassifiedModelFailure =
    offPeak?.kind === "ticketExpired"
      ? {
          ...classified,
          retryable: false,
          message: offPeakTicketExpiredMessage(classified.message),
        }
      : offPeak?.kind === "queued"
        ? {
            ...classified,
            retryable: true,
            retryReason: ModelRetryReason.OffpeakQueued,
          }
        : classified;
  const errorPhase =
    readModelFailureErrorPhase(error) ?? (streamIterator === undefined ? "prepare" : "stream");
  let awaitIteratorClose = failure.reason !== ModelFailureReasonValue.Cancelled;
  const responseHeaders = sanitizeModelNetworkHeaders(getResponseHeaders(unwrapRetryError(error)));
  const failureDecision = resolveStreamFailureDecision({
    attempt: retryBudgetAttempt,
    emittedRetryBoundaryEvent,
    error,
    failure,
    maxAttempts: modelInput.retry.maxAttempts,
    preserveProviderStreamBoundaries: modelInput.request.preserveProviderStreamBoundaries,
    responseHeaders,
    retryBudget,
    streamIteratorCreated: streamIterator !== undefined,
    streamErrorChunkObserved: Boolean(diagnostics.lastErrorChunk || diagnostics.lastFinishChunk),
  });
  const retryWithAuth = authRetry.claim(
    error,
    options === undefined ||
      emittedRetryBoundaryEvent ||
      streamOutputCommitted ||
      (modelInput.request.preserveProviderStreamBoundaries === true &&
        failureDecision.context?.streamFailurePhase === "response_body"),
  );
  if (retryWithAuth) {
    failureDecision.canRetry = true;
    statusContext = {
      ...statusContext,
      maxAttempts: statusMaxAttempts(
        Number(readSignatureRepairAttempted()) + authRetry.extraAttempts,
      ),
    };
  }
  // off-peak 排队 429 豁免预算：不消耗 maxAttempts，SSE 可见输出边界仍适用。
  if (offPeak?.kind === "queued" && !emittedRetryBoundaryEvent) {
    failureDecision.canRetry = true;
  }
  if (retryWithRepairedHistory) {
    failureDecision.canRetry = true;
  }

  logStreamFailureDiagnostics({
    attempt,
    canRetry: failureDecision.canRetry,
    diagnostics,
    durationMs: completedAt - startedAt,
    emittedError,
    emittedEvent,
    emittedRetryBoundaryEvent,
    error,
    failure,
    logger: modelInput.logger,
    statusContext,
  });
  await publishModelStatus(
    {
      ...statusContext,
      attempt,
      durationMs: completedAt - startedAt,
      message: failure.message,
      reason: failure.reason,
      requestHeaderCount,
      requestHeaders,
      responseHeaderCount: Object.keys(responseHeaders).length,
      responseHeaders,
      retryable: failureDecision.canRetry,
      statusCode: failure.statusCode,
      streamOutputCommitted,
      ...modelFailureStatusFields(error, failure, errorPhase),
      timestamp: new Date(completedAt).toISOString(),
      type: "model_request_failed",
      ...(error instanceof AiSdkModelAdapterError && error.usage ? { usage: error.usage } : {}),
    },
    {
      ...statusPublishOptions(modelInput, admission),
      failureError: unwrapRetryError(error),
    },
  );
  const terminalStatusPublished = true;

  if (retryWithAuth) {
    await publishRetryScheduledStatus(
      modelInput,
      statusContext,
      attempt,
      0,
      { ...failure, retryReason: ModelRetryReason.AuthRefresh },
      requestHeaders,
      responseHeaders,
    );
    return { attemptRewind: false, awaitIteratorClose, retry: true, terminalStatusPublished };
  }
  if (retryWithRepairedHistory) {
    await publishRetryScheduledStatus(
      modelInput,
      statusContext,
      attempt,
      0,
      {
        ...failure,
        retryReason: ModelRetryReason.ReasoningSignatureRepair,
      },
      requestHeaders,
      responseHeaders,
      admission,
    );
    return { attemptRewind: false, awaitIteratorClose, retry: true, terminalStatusPublished };
  }

  if (!failureDecision.canRetry) {
    logRetryDelayDecision({
      attempt,
      canRetry: failureDecision.canRetry,
      failure,
      logger: modelInput.logger,
      responseHeaders,
      statusContext,
    });
    return {
      attemptRewind: false,
      awaitIteratorClose,
      error: toAdapterError(error, failure, statusContext, attempt, {
        ...failureDecision.context,
        errorPhase,
      }),
      retry: false,
      terminalStatusPublished,
    };
  }

  const delayMs =
    offPeak?.kind === "queued"
      ? offPeak.delayMs
      : calculateRetryDelay(modelInput.retry, retryBudgetAttempt, failure.retryAfterMs);
  logRetryDelayDecision({
    attempt,
    canRetry: failureDecision.canRetry,
    delayMs,
    failure,
    logger: modelInput.logger,
    responseHeaders,
    statusContext,
  });

  await publishRetryScheduledStatus(
    modelInput,
    statusContext,
    attempt,
    delayMs,
    failure,
    requestHeaders,
    responseHeaders,
    admission,
  );
  // 退避期间不持票：槽位让给别人，重试再准入。
  admission.release();
  try {
    await sleep(delayMs, modelInput.request.abortSignal);
  } catch (sleepError) {
    const sleepFailure = classifyModelFailure(sleepError, modelInput.request.abortSignal);
    await publishModelStatus(
      {
        ...statusContext,
        attempt,
        durationMs: Date.now() - startedAt,
        message: sleepFailure.message,
        reason: sleepFailure.reason,
        requestHeaderCount,
        requestHeaders,
        retryable: false,
        statusCode: sleepFailure.statusCode,
        streamOutputCommitted,
        ...modelFailureStatusFields(sleepError, sleepFailure, "connect"),
        timestamp: new Date().toISOString(),
        type: "model_request_failed",
      },
      {
        // 退避期间票据已归还：这次取消不属于任何一次尝试，不转投票据。
        ...statusPublishOptions(modelInput),
        failureError: unwrapRetryError(sleepError),
      },
    );
    return {
      attemptRewind: false,
      awaitIteratorClose,
      error: toAdapterError(sleepError, sleepFailure, statusContext, attempt, {
        errorPhase: "connect",
      }),
      retry: false,
      terminalStatusPublished: true,
    };
  }
  // 排队等待不消耗重试预算：回退计数让 for 自增后原地重试，无限探测。
  return {
    attemptRewind: offPeak?.kind === "queued",
    awaitIteratorClose,
    retry: true,
    terminalStatusPublished,
  };
}
