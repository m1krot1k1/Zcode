import type { TextStreamPart, ToolSet } from "ai";
import type { Logger, ModelStatusSink, ModelStreamEvent } from "@zcode/contracts";
import {
  ModelFailureReason as ModelFailureReasonValue,
  ModelRetryReason,
  type ModelRetryBudget,
} from "@zcode/contracts";
import {
  classifyModelFailure,
  findProviderBusinessError,
  inspectProviderFailure,
  type ClassifiedModelFailure,
} from "./failure-classifier.js";
import {
  getErrorCode,
  getHttpResponseStatus,
  getResponseHeaders,
  unwrapRetryError,
} from "./failure-inspection.js";
import { offPeakTicketExpiredMessage, resolveOffPeakFailureDecision } from "./offpeak-retry.js";
import { isRetrySafePreludeStreamEvent } from "./stream-retry-boundary.js";
import { isModelStreamIdleTimeoutError } from "./stream-idle-timeout.js";
import {
  createStreamDiagnostics,
  logIgnoredStreamChunk,
  recordStreamChunkDiagnostic,
} from "./runner-diagnostics.js";
import { toModelStreamEvent } from "./runner-normalization.js";
import { detectProviderBusinessFinishError } from "./provider-finish-business-error.js";
import { isRequestVerificationRejection } from "./request-security-edition/recovery.js";
import {
  calculateRetryDelay,
  logRetryDelayDecision,
  sleep,
  TerminalStreamChunkError,
  toAdapterError,
} from "./runner-retry.js";
import { createStatusContext, publishModelStatus } from "./runner-status.js";
import { StreamingToolCallAssembler } from "./streaming-tool-call-assembler.js";
import { isRetryAfterBeyondHonoredWait, type ResolvedAiSdkModelRetryOptions } from "./retry-policy.js";
import type {
  AiSdkModelTextRequest,
  AiSdkStreamTextResult,
  ResolvedAiSdkModel,
} from "./runner-runtime.js";
import { retryBudgetAllows, retryBudgetMaxAttempts } from "./retry-budget.js";
import { sanitizeModelNetworkHeaders } from "./runner-network-headers.js";
import { retryAllowedByFailurePolicy } from "./workflow-model-failure-policy.js";
import { modelFailureStatusFields } from "./runner-telemetry.js";
import type { AttemptAdmission } from "./request-admission.js";

type StreamFailurePhase = "request_setup" | "response_body";

const STREAM_ATTEMPT_CLEANUP_TIMEOUT_MS = 1_000;

export async function closeStreamIteratorBestEffort(
  streamIterator: AsyncIterator<TextStreamPart<ToolSet>> | undefined,
  options: { attempt: number; logger?: Logger; result?: AiSdkStreamTextResult },
): Promise<void> {
  const cleanupOperations: Array<{ name: string; promise: Promise<unknown> }> = [];
  if (streamIterator?.return) {
    cleanupOperations.push({
      name: "iterator.return",
      promise: Promise.resolve().then(() => streamIterator.return?.()),
    });
  }
  if (options.result?.consumeStream) {
    cleanupOperations.push({
      name: "result.consumeStream",
      // AI SDK fullStream getter 会 tee 并把另一支保存在 baseStream；
      // 只等待外层 iterator.return() 仍可能让底层 reader/连接槽继续被保留。
      promise: Promise.resolve().then(() => options.result?.consumeStream()),
    });
  }
  if (cleanupOperations.length === 0) return;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    Promise.allSettled(cleanupOperations.map((operation) => operation.promise)).then((results) => ({
      results,
      type: "settled" as const,
    })),
    new Promise<{ type: "timed_out" }>((resolve) => {
      timeout = setTimeout(() => resolve({ type: "timed_out" }), STREAM_ATTEMPT_CLEANUP_TIMEOUT_MS);
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);

  if (outcome.type === "timed_out") {
    options.logger?.warn("Model stream attempt cleanup timed out", {
      attempt: options.attempt,
      cleanupOperations: cleanupOperations.map((operation) => operation.name),
      event: "model.stream_attempt_cleanup.timeout",
      status: "waiting",
      timeoutMs: STREAM_ATTEMPT_CLEANUP_TIMEOUT_MS,
    });
    return;
  }

  const failures = outcome.results.flatMap((result, index) =>
    result.status === "rejected"
      ? [
          {
            errorMessage:
              result.reason instanceof Error ? result.reason.message : String(result.reason),
            operation: cleanupOperations[index]?.name,
          },
        ]
      : [],
  );
  if (failures.length > 0) {
    // 异步清理失败或超时只能降级告警，不能覆盖原始 provider/retry 错误。
    options.logger?.warn("Model stream attempt cleanup failed", {
      attempt: options.attempt,
      event: "model.stream_attempt_cleanup.failed",
      failures,
      status: "failed",
    });
  }
}

export async function handleStreamChunk(input: {
  /** 本次尝试的准入：错误块的退避 sleep 之前先归还。 */
  admission: AttemptAdmission;
  attempt: number;
  chunk: TextStreamPart<ToolSet>;
  diagnostics: ReturnType<typeof createStreamDiagnostics>;
  emittedRetryBoundaryEvent: boolean;
  input: {
    logger?: Logger;
    request: AiSdkModelTextRequest;
    resolved: ResolvedAiSdkModel;
    retry: ResolvedAiSdkModelRetryOptions;
    statusSink?: ModelStatusSink;
  };
  pendingRetrySafeEvents: ModelStreamEvent[];
  repairThinkingSignatureRejection: (error: unknown) => boolean;
  canRecoverProjectToken: (error: unknown) => boolean;
  retryBudgetAttempt: number;
  requestHeaderCount: number;
  requestHeaders: Record<string, string>;
  startedAt: number;
  statusContext: ReturnType<typeof createStatusContext>;
  toolCallAssembler: StreamingToolCallAssembler;
}): Promise<{
  emittedError: boolean;
  emittedEvent: boolean;
  emittedRetryBoundaryEvent: boolean;
  retryScheduled: boolean;
  /** off-peak 排队重试：外层 for 冻结 attempt 预算。 */
  offPeakQueueHold: boolean;
  terminalError?: TerminalStreamChunkError;
  visibleEvents: ModelStreamEvent[];
}> {
  recordStreamChunkDiagnostic(input.diagnostics, input.chunk);
  const providerEventObserved =
    input.input.request.preserveProviderStreamBoundaries === true &&
    isRawProviderRetryBoundaryEvent(input.chunk);
  const providerBoundaryEvent = input.input.request.preserveProviderStreamBoundaries
    ? toProviderStreamBoundaryEvent(input.chunk)
    : undefined;
  const emittedRetryBoundaryEvent = input.emittedRetryBoundaryEvent || providerEventObserved;
  const providerBusinessFinishError = detectProviderBusinessFinishError({
    providerId: String(input.statusContext.providerId),
    providerKind: input.statusContext.providerKind,
    source: input.chunk,
  });
  if (providerBusinessFinishError) {
    return handleStreamErrorEvent(
      { ...input, emittedRetryBoundaryEvent },
      providerBusinessFinishError,
    );
  }
  const event = toModelStreamEvent(input.chunk);
  if (event?.type === "error") {
    return handleStreamErrorEvent({ ...input, emittedRetryBoundaryEvent }, event.error);
  }
  if (!event) {
    if (providerEventObserved) {
      // raw provider event 只用于结束 compact SSE retry；它本身不属于
      // 可见正文；只投影 response/block/stop 的语义边界，并立即刷出已暂存的 synthetic start。
      return applyStreamEventsToRetryBoundary({
        emittedRetryBoundaryEvent: input.emittedRetryBoundaryEvent,
        events: providerBoundaryEvent ? [providerBoundaryEvent] : [],
        pendingRetrySafeEvents: input.pendingRetrySafeEvents,
        providerEventObserved: true,
        preserveProviderStreamBoundaries: true,
      });
    }
    logIgnoredStreamChunk({
      attempt: input.attempt,
      chunk: input.chunk,
      logger: input.input.logger,
      statusContext: input.statusContext,
    });
    return streamChunkResult();
  }

  return applyStreamEventsToRetryBoundary({
    emittedRetryBoundaryEvent: input.emittedRetryBoundaryEvent,
    events: input.toolCallAssembler.handle(event),
    pendingRetrySafeEvents: input.pendingRetrySafeEvents,
    providerEventObserved,
    preserveProviderStreamBoundaries: input.input.request.preserveProviderStreamBoundaries,
  });
}

export function applyStreamEventsToRetryBoundary(input: {
  emittedRetryBoundaryEvent: boolean;
  events: ModelStreamEvent[];
  pendingRetrySafeEvents: ModelStreamEvent[];
  providerEventObserved?: boolean;
  preserveProviderStreamBoundaries?: boolean;
}): ReturnType<typeof streamChunkResult> {
  let emittedEvent = false;
  let emittedRetryBoundaryEvent = input.emittedRetryBoundaryEvent;
  const visibleEvents: ModelStreamEvent[] = [];

  if (input.providerEventObserved && !emittedRetryBoundaryEvent) {
    visibleEvents.push(...input.pendingRetrySafeEvents.splice(0));
    emittedRetryBoundaryEvent = true;
  }

  for (const event of input.events) {
    emittedEvent = true;
    // AI SDK 的 start 在读取 provider stream 前本地合成，不能冒充首个 provider event；
    // compact 一旦收到其余真实事件就停止 SSE retry，再由 Core 的 block commit 决定能否 HTTP fallback。
    const retrySafePrelude =
      isRetrySafePreludeStreamEvent(event) &&
      (!input.preserveProviderStreamBoundaries || event.type === "start");
    if (retrySafePrelude && !emittedRetryBoundaryEvent) {
      input.pendingRetrySafeEvents.push(event);
      continue;
    }

    if (!emittedRetryBoundaryEvent) {
      visibleEvents.push(...input.pendingRetrySafeEvents.splice(0));
    }
    visibleEvents.push(event);
    emittedRetryBoundaryEvent = true;
  }

  return streamChunkResult({
    emittedEvent,
    emittedRetryBoundaryEvent,
    visibleEvents,
  });
}

function isRawProviderRetryBoundaryEvent(chunk: TextStreamPart<ToolSet>): boolean {
  if (chunk.type !== "raw") {
    return false;
  }
  const rawValue = chunk.rawValue;
  return !(
    rawValue !== null &&
    typeof rawValue === "object" &&
    (rawValue as { type?: unknown }).type === "ping"
  );
}

function toProviderStreamBoundaryEvent(
  chunk: TextStreamPart<ToolSet>,
): ModelStreamEvent | undefined {
  if (chunk.type !== "raw" || chunk.rawValue === null || typeof chunk.rawValue !== "object") {
    return undefined;
  }
  const rawEvent = chunk.rawValue as {
    content_block?: { type?: unknown };
    delta?: { stop_reason?: unknown; type?: unknown };
    index?: unknown;
    type?: unknown;
  };
  if (rawEvent.type === "message_start") {
    return {
      boundary: "provider_response_start",
      type: "compact_stream_boundary",
    };
  }
  if (rawEvent.type === "content_block_start") {
    return {
      blockType:
        typeof rawEvent.content_block?.type === "string" ? rawEvent.content_block.type : null,
      boundary: "provider_content_block_start",
      index: typeof rawEvent.index === "number" ? rawEvent.index : null,
      type: "compact_stream_boundary",
    };
  }
  if (rawEvent.type === "content_block_delta") {
    return {
      boundary: "provider_content_block_delta",
      deltaType: typeof rawEvent.delta?.type === "string" ? rawEvent.delta.type : null,
      index: typeof rawEvent.index === "number" ? rawEvent.index : null,
      type: "compact_stream_boundary",
    };
  }
  if (rawEvent.type === "content_block_stop") {
    return {
      boundary: "provider_content_block_stop",
      index: typeof rawEvent.index === "number" ? rawEvent.index : null,
      type: "compact_stream_boundary",
    };
  }
  if (rawEvent.type === "message_delta") {
    const stopReason = rawEvent.delta?.stop_reason;
    return {
      boundary: "provider_stop_reason",
      present: Boolean(stopReason),
      type: "compact_stream_boundary",
    };
  }
  return undefined;
}

export function compactDirectToolCallCommitEvent(
  request: AiSdkModelTextRequest,
  chunk: TextStreamPart<ToolSet>,
): ModelStreamEvent | undefined {
  if (!request.preserveProviderStreamBoundaries || chunk.type !== "tool-call") {
    return undefined;
  }
  return {
    boundary: "inferred_content_block_stop",
    type: "compact_stream_boundary",
  };
}

async function handleStreamErrorEvent(
  input: Parameters<typeof handleStreamChunk>[0],
  error: unknown,
): Promise<Awaited<ReturnType<typeof handleStreamChunk>>> {
  if (isRequestVerificationRejection(error) || input.canRecoverProjectToken(error)) throw error;
  const retryWithRepairedHistory =
    !input.emittedRetryBoundaryEvent && input.repairThinkingSignatureRejection(error);
  const statusContext = retryWithRepairedHistory
    ? {
        ...input.statusContext,
        maxAttempts: retryBudgetMaxAttempts(
          input.input.request.modelRetryBudget,
          input.input.retry.maxAttempts + 1,
        ),
      }
    : input.statusContext;
  const classified = classifyModelFailure(error, input.input.request.abortSignal);
  // off-peak 特判：SSE 首块即错（尚无可见输出）时的排队 429 同样豁免预算重试。
  const offPeak = resolveOffPeakFailureDecision({
    offPeak: input.input.resolved.accountAccess?.mode === "off-peak",
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
  const responseHeaders = sanitizeModelNetworkHeaders(getResponseHeaders(unwrapRetryError(error)));
  const failureDecision = resolveStreamFailureDecision({
    attempt: input.retryBudgetAttempt,
    emittedRetryBoundaryEvent: input.emittedRetryBoundaryEvent,
    error,
    failure,
    maxAttempts: input.input.retry.maxAttempts,
    preserveProviderStreamBoundaries: input.input.request.preserveProviderStreamBoundaries,
    responseHeaders,
    retryBudget: input.input.request.modelRetryBudget,
    streamErrorChunkObserved: true,
  });
  // off-peak 排队 429 豁免预算：不消耗 maxAttempts，SSE 可见输出边界仍适用。
  if (offPeak?.kind === "queued" && !input.emittedRetryBoundaryEvent) {
    failureDecision.canRetry = true;
  }
  if (retryWithRepairedHistory) {
    failureDecision.canRetry = true;
  }
  await publishModelStatus(
    {
      ...statusContext,
      attempt: input.attempt,
      durationMs: Date.now() - input.startedAt,
      message: failure.message,
      reason: failure.reason,
      requestHeaderCount: input.requestHeaderCount,
      requestHeaders: input.requestHeaders,
      responseHeaderCount: Object.keys(responseHeaders).length,
      responseHeaders,
      retryable: failureDecision.canRetry,
      statusCode: failure.statusCode,
      streamOutputCommitted: input.emittedRetryBoundaryEvent,
      ...modelFailureStatusFields(error, failure, "stream"),
      timestamp: new Date().toISOString(),
      type: "model_request_failed",
    },
    {
      ...statusPublishOptions(input.input, input.admission),
      failureError: unwrapRetryError(error),
    },
  );

  if (retryWithRepairedHistory) {
    await publishRetryScheduledStatus(
      input.input,
      statusContext,
      input.attempt,
      0,
      {
        ...failure,
        retryReason: ModelRetryReason.ReasoningSignatureRepair,
      },
      input.requestHeaders,
      responseHeaders,
      input.admission,
    );
    return streamChunkResult({
      emittedError: true,
      retryScheduled: true,
    });
  }

  if (!failureDecision.canRetry) {
    logRetryDelayDecision({
      attempt: input.attempt,
      canRetry: failureDecision.canRetry,
      failure,
      logger: input.input.logger,
      responseHeaders,
      statusContext,
    });
    return streamChunkResult({
      emittedError: true,
      terminalError: new TerminalStreamChunkError(
        toAdapterError(error, failure, statusContext, input.attempt, {
          ...failureDecision.context,
          errorPhase: "stream",
        }),
      ),
    });
  }

  const delayMs =
    offPeak?.kind === "queued"
      ? offPeak.delayMs
      : calculateRetryDelay(input.input.retry, input.retryBudgetAttempt, failure.retryAfterMs);
  logRetryDelayDecision({
    attempt: input.attempt,
    canRetry: failureDecision.canRetry,
    delayMs,
    failure,
    logger: input.input.logger,
    responseHeaders,
    statusContext,
  });

  await publishRetryScheduledStatus(
    input.input,
    statusContext,
    input.attempt,
    delayMs,
    failure,
    input.requestHeaders,
    responseHeaders,
    input.admission,
  );
  // 退避期间不持票：这次尝试到此结束，槽位让给别人。
  input.admission.release();
  // Note: AI SDK can surface pre-output APICallError as an error chunk;
  // retry it here so protocol clients still receive the normal apiRetry status updates.
  try {
    await sleep(delayMs, input.input.request.abortSignal);
  } catch (sleepError) {
    const sleepFailure = classifyModelFailure(sleepError, input.input.request.abortSignal);
    // SSE error chunk 在 helper 内等待 retry；取消发生时 iterator 仍存在，
    // 外层仅按 iterator 判断会误记为 stream。先在真实等待边界写入 connect 事实。
    throw toAdapterError(sleepError, sleepFailure, statusContext, input.attempt, {
      errorPhase: "connect",
    });
  }
  return streamChunkResult({
    emittedError: true,
    retryScheduled: true,
    offPeakQueueHold: offPeak?.kind === "queued",
  });
}

function classifyStreamFailurePhase(input: {
  emittedRetryBoundaryEvent: boolean;
  httpResponseStatus?: number;
  responseHeaders: Record<string, string>;
  streamErrorChunkObserved?: boolean;
  streamIteratorCreated?: boolean;
}): StreamFailurePhase | undefined {
  if (input.streamIteratorCreated === false) {
    return "request_setup";
  }
  if (input.emittedRetryBoundaryEvent) {
    return "response_body";
  }

  const responseStatus = input.httpResponseStatus;
  if (responseStatus !== undefined) {
    if (responseStatus >= 200 && responseStatus < 300) {
      return "response_body";
    }
    if (responseStatus >= 300 && responseStatus < 600) {
      return "request_setup";
    }
  }

  if (input.streamErrorChunkObserved) {
    // error chunk 本身证明 stream body 已开始；其中的 ProviderBusinessError.statusCode
    // 可能只是业务分类，不能反推成 HTTP request setup。明确 transport status 仍由上面的分支优先。
    return "response_body";
  }

  const contentType = readHeader(input.responseHeaders, "content-type")?.toLowerCase();
  if (contentType?.includes("text/event-stream")) {
    return "response_body";
  }
  return undefined;
}

export function compactStreamFailureContext(
  preserveProviderStreamBoundaries: boolean | undefined,
  streamFailurePhase: StreamFailurePhase | undefined,
  httpResponseStatus?: number,
): Record<string, unknown> | undefined {
  if (preserveProviderStreamBoundaries !== true || !streamFailurePhase) {
    return undefined;
  }
  return {
    ...(httpResponseStatus !== undefined ? { httpResponseStatus } : {}),
    streamFailurePhase,
  };
}

export function resolveStreamFailureDecision(input: {
  attempt: number;
  emittedRetryBoundaryEvent: boolean;
  error: unknown;
  failure: ClassifiedModelFailure;
  maxAttempts: number;
  preserveProviderStreamBoundaries?: boolean;
  responseHeaders: Record<string, string>;
  retryBudget?: ModelRetryBudget;
  streamErrorChunkObserved?: boolean;
  streamIteratorCreated?: boolean;
}): { canRetry: boolean; context?: Record<string, unknown> } {
  const httpResponseStatus = input.preserveProviderStreamBoundaries
    ? resolveCompactHttpResponseStatus(input.error)
    : undefined;
  const streamFailurePhase = input.preserveProviderStreamBoundaries
    ? classifyStreamFailurePhase({
        emittedRetryBoundaryEvent: input.emittedRetryBoundaryEvent,
        httpResponseStatus,
        responseHeaders: input.responseHeaders,
        streamErrorChunkObserved: input.streamErrorChunkObserved,
        streamIteratorCreated: input.streamIteratorCreated,
      })
    : undefined;

  return {
    canRetry: canRetryStreamFailure({
      attempt: input.attempt,
      emittedRetryBoundaryEvent: input.emittedRetryBoundaryEvent,
      error: input.error,
      failure: input.failure,
      httpResponseStatus,
      maxAttempts: input.maxAttempts,
      preserveProviderStreamBoundaries: input.preserveProviderStreamBoundaries,
      retryBudget: input.retryBudget,
      streamFailurePhase,
    }),
    context: compactStreamFailureContext(
      input.preserveProviderStreamBoundaries,
      streamFailurePhase,
      httpResponseStatus,
    ),
  };
}

function canRetryStreamFailure(input: {
  attempt: number;
  emittedRetryBoundaryEvent: boolean;
  error: unknown;
  failure: ClassifiedModelFailure;
  httpResponseStatus?: number;
  maxAttempts: number;
  preserveProviderStreamBoundaries?: boolean;
  retryBudget?: ModelRetryBudget;
  streamFailurePhase?: StreamFailurePhase;
}): boolean {
  // workflow 流量（无上限预算）不读分类器的 retryable，读策略表：只有确定性的模型侧错误
  // 才不重试；3008/3009/3010 这类并发上限在这里是 retry。
  const providerCode = inspectProviderFailure(input.error).providerErrorCode;
  // 可见输出已发出后绝不重放（交给 core 的 stream recovery）；预算门在 unbounded 下恒开。
  if (
    input.emittedRetryBoundaryEvent ||
    !retryBudgetAllows(input.retryBudget, input.attempt, input.maxAttempts)
  ) {
    return false;
  }

  if (input.failure.reason === ModelFailureReasonValue.Cancelled) {
    return false;
  }

  // provider 要求的 Retry-After 超过本地可兑现窗口：本地短退避重试只会空转。
  // 分类器已把 429 标成配额/限流耗尽；这里兜住其它 state（如 5xx 带超长 Retry-After），
  // 统一在重试闸门终止，让上层看到 retryable=false 与 providerQuotaExhausted 上下文。
  if (isRetryAfterBeyondHonoredWait(input.failure.retryAfterMs)) {
    return false;
  }

  if (
    input.preserveProviderStreamBoundaries === true &&
    isCompactStaleStreamFailure(input.error, input.httpResponseStatus)
  ) {
    // compact 请求允许重试 EPIPE/ConnectionClosed；它们不在通用
    // model failure retryable 集合中，必须先于通用 gate 判定。
    return true;
  }

  if (!retryAllowedByFailurePolicy(input.failure, input.retryBudget, providerCode)) {
    return false;
  }

  // setup failure 保留既有 adapter/API retry；compact 的 SSE protocol/business body error
  // 不再重放，耗尽后的 non-stream fallback 由 Core 按 commit boundary 处理。
  return (
    input.preserveProviderStreamBoundaries !== true || input.streamFailurePhase !== "response_body"
  );
}

function resolveCompactHttpResponseStatus(error: unknown): number | undefined {
  const unwrapped = unwrapRetryError(error);
  // ProviderBusinessError.responseStatus 是 fetch 层保留的 transport status；外层
  // APICallError/statusCode 可能已被业务码覆盖，因此必须优先使用这一硬证据。
  return findProviderBusinessError(unwrapped)?.responseStatus ?? getHttpResponseStatus(unwrapped);
}

function isCompactStaleStreamFailure(
  error: unknown,
  httpResponseStatus: number | undefined,
): boolean {
  const unwrapped = unwrapRetryError(error);
  if (isModelStreamIdleTimeoutError(unwrapped)) {
    return true;
  }

  if (isCompactStaleCode(getErrorCode(unwrapped))) {
    return true;
  }
  if (httpResponseStatus !== undefined) {
    return false;
  }

  const providerCode = findProviderBusinessError(unwrapped)?.providerCode;
  return isCompactStaleCode(typeof providerCode === "number" ? String(providerCode) : providerCode);
}

function isCompactStaleCode(value: string | undefined): boolean {
  const normalized = value?.trim().toUpperCase();
  return normalized === "ECONNRESET" || normalized === "EPIPE" || normalized === "CONNECTIONCLOSED";
}

function readHeader(headers: Record<string, string>, name: string): string | undefined {
  const normalizedName = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === normalizedName)?.[1];
}

function streamChunkResult(
  overrides: Partial<{
    emittedError: boolean;
    emittedEvent: boolean;
    emittedRetryBoundaryEvent: boolean;
    retryScheduled: boolean;
    /** off-peak 排队重试：外层 for 冻结 attempt 预算。 */
    offPeakQueueHold: boolean;
    terminalError?: TerminalStreamChunkError;
    visibleEvents: ModelStreamEvent[];
  }> = {},
) {
  return {
    emittedError: false,
    emittedEvent: false,
    emittedRetryBoundaryEvent: false,
    retryScheduled: false,
    offPeakQueueHold: false,
    visibleEvents: [],
    ...overrides,
  };
}

export function statusPublishOptions(
  input: {
    logger?: Logger;
    request: AiSdkModelTextRequest;
    resolved?: Pick<ResolvedAiSdkModel, "requestObservations">;
    statusSink?: ModelStatusSink;
  },
  admission?: AttemptAdmission,
) {
  return {
    requestObservations: input.resolved?.requestObservations,
    logger: input.logger,
    requestStatusSink: input.request.statusSink,
    statusSink: input.statusSink,
    // 本次尝试的准入票据也是它的状态事件汇。
    ...(admission?.ticket === undefined ? {} : { admissionTicket: admission.ticket }),
  };
}

export async function publishRetryScheduledStatus(
  input: {
    logger?: Logger;
    request: AiSdkModelTextRequest;
    retry: ResolvedAiSdkModelRetryOptions;
    statusSink?: ModelStatusSink;
  },
  statusContext: ReturnType<typeof createStatusContext>,
  attempt: number,
  delayMs: number,
  failure: ReturnType<typeof classifyModelFailure>,
  requestHeaders: Record<string, string>,
  responseHeaders: Record<string, string>,
  admission?: AttemptAdmission,
): Promise<void> {
  await publishModelStatus(
    {
      ...statusContext,
      attempt,
      delayMs,
      message: failure.message,
      nextAttempt: attempt + 1,
      reason: failure.retryReason,
      requestHeaderCount: Object.keys(requestHeaders).length,
      requestHeaders,
      responseHeaderCount: Object.keys(responseHeaders).length,
      responseHeaders,
      statusCode: failure.statusCode,
      errorCode: failure.code,
      retryAfterMs: failure.retryAfterMs,
      timestamp: new Date().toISOString(),
      type: "model_retry_scheduled",
    },
    statusPublishOptions(input, admission),
  );
}

export function observeVisibleStreamEvent(
  event: ModelStreamEvent,
  elapsed: number,
): { contentMs?: number; textMs?: number; outputCommitted: boolean } {
  switch (event.type) {
    case "text_delta":
      return {
        contentMs: elapsed,
        textMs: event.text ? elapsed : undefined,
        outputCommitted: true,
      };
    case "reasoning_delta":
    case "tool_input_delta":
    case "tool_call":
      return { contentMs: elapsed, outputCommitted: true };
    case "text_start":
    case "reasoning_start":
    case "tool_input_start":
      return { contentMs: elapsed, outputCommitted: false };
    case "compact_stream_boundary":
      return {
        contentMs: event.boundary === "provider_content_block_start" ? elapsed : undefined,
        outputCommitted:
          event.boundary === "provider_content_block_stop" ||
          event.boundary === "inferred_content_block_stop",
      };
    default:
      return { outputCommitted: false };
  }
}

export async function resolveStreamResponseHeaders(
  result: AiSdkStreamTextResult,
): Promise<Record<string, string>> {
  try {
    const response = await (result as unknown as { response?: Promise<unknown> }).response;
    return sanitizeModelNetworkHeaders((response as { headers?: unknown } | undefined)?.headers);
  } catch {
    return {};
  }
}
