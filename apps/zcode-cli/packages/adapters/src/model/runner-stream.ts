import type { TextStreamPart, ToolSet } from "ai";
import type { Logger, ModelStatusSink, ModelStreamEvent } from "@zcode/contracts";
import {
  DEFAULT_MODEL_FIRST_TOKEN_TIMEOUT_MS,
  ModelFailureReason as ModelFailureReasonValue,
  ModelTransportKind as ModelTransportKindValue,
} from "@zcode/contracts";
import { classifyModelFailure } from "./failure-classifier.js";
import { resolveAnthropicRequestMetadataUserId } from "./anthropic-request-metadata.js";
import { unwrapRetryError } from "./failure-inspection.js";
import {
  createFirstTokenWatchdog,
  isFirstTokenOutputPart,
  type FirstTokenWatchdog,
} from "./first-token-watchdog.js";
import {
  createLinkedAbortController,
  readNextWithStreamIdleTimeout,
  resolveModelStreamIdleTimeoutMs,
} from "./stream-idle-timeout.js";
import {
  createEmptyContextExceededError,
  createStreamDiagnostics,
  isSuspiciousStreamDiagnostics,
  isZeroOutputModelCompletion,
  logStreamDiagnostics,
} from "./runner-diagnostics.js";
import { canRetryEmptyCompletion, scheduleEmptyCompletionRetry } from "./empty-completion-retry.js";
import { createStreamTextOptions } from "./runner-options.js";
import {
  isDevelopmentModelIOEnv,
  recordStreamTextDebug,
  shouldRecordModelIO,
} from "./runner-debug.js";
import { sanitizeModelNetworkHeaders } from "./runner-network-headers.js";
import { admitAttempt, type AttemptAdmission } from "./request-admission.js";
import { retryAttemptLoopContinues, retryBudgetMaxAttempts } from "./retry-budget.js";
import type { EnvRecord } from "./model-execution.js";
import { detectProviderBusinessFinishError } from "./provider-finish-business-error.js";
import { createRequestVerificationEmptyStreamError } from "./request-security-edition/recovery.js";
import { TerminalStreamChunkError, toAdapterError } from "./runner-retry.js";
import {
  admissionWaitPublishers,
  createAttemptStatusContext,
  createStatusContext,
  publishModelStatus,
  publishModelTelemetryMilestone,
} from "./runner-status.js";
import { StreamingToolCallAssembler } from "./streaming-tool-call-assembler.js";
import type { ResolvedAiSdkModelRetryOptions } from "./retry-policy.js";
import type {
  AiSdkStreamTextResult,
  AiSdkModelRuntime,
  AiSdkModelTextRequest,
  ResolvedAiSdkModel,
} from "./runner-runtime.js";
import { isRequestVerificationRejection } from "./request-security-edition/recovery.js";
import { AccountRequestRetry } from "./account-request-retry.js";
import { resolveModelForAttempt } from "./runner-runtime-headers.js";
import { modelFailureStatusFields, providerRequestIdFromHeaders } from "./runner-telemetry.js";
import { repairReasoningHistoryAfterSignatureRejection } from "./reasoning-history-normalization.js";
import {
  applyStreamEventsToRetryBoundary,
  closeStreamIteratorBestEffort,
  compactDirectToolCallCommitEvent,
  compactStreamFailureContext,
  handleStreamChunk,
  observeVisibleStreamEvent,
  resolveStreamResponseHeaders,
  statusPublishOptions,
} from "./runner-stream-handlers.js";
import { handleStreamAttemptFailure } from "./runner-stream-failure.js";

export async function* runStreamText(input: {
  debugDir?: string;
  env: EnvRecord;
  logger?: Logger;
  request: AiSdkModelTextRequest;
  resolveModel: () => ResolvedAiSdkModel;
  resolved: ResolvedAiSdkModel;
  retry: ResolvedAiSdkModelRetryOptions;
  runtime: AiSdkModelRuntime;
  statusSink?: ModelStatusSink;
  streamIdleTimeoutMs: number;
  /** 首 token 看门狗窗口（ms）；<=0 关闭。与 idle 超时互不影响。 */
  firstTokenTimeoutMs?: number;
  modelIoFullRetentionEnabled: boolean;
}): AsyncGenerator<ModelStreamEvent> {
  // 重试预算档位：只放宽瞬态失败的放弃条件；
  // `emittedRetryBoundaryEvent` 之后不重试的规则不变。状态事件 maxAttempts 以 0 表示无上限。
  const retryBudget = input.request.modelRetryBudget;
  const statusMaxAttempts = (extraAttempts: number): number =>
    retryBudgetMaxAttempts(retryBudget, input.retry.maxAttempts + extraAttempts);
  const baseStatusContext = createStatusContext({
    maxAttempts: statusMaxAttempts(0),
    request: input.request,
    resolved: input.resolved,
    transport: ModelTransportKindValue.Sse,
  });
  const recordModelIO = shouldRecordModelIO(input.env);
  const isDev = isDevelopmentModelIOEnv(input.env);
  let requestMessages = input.request.messages;
  let signatureRepairAttempted = false;
  const authRetry = new AccountRequestRetry(input.request, input.resolved, input.logger);
  let emptyCompletionRetryCount = 0;

  for (
    let attempt = 1;
    retryAttemptLoopContinues(
      retryBudget,
      attempt,
      input.retry.maxAttempts + Number(signatureRepairAttempted) + authRetry.extraAttempts,
    );
    attempt += 1
  ) {
    const retryBudgetAttempt = attempt - Number(signatureRepairAttempted) - authRetry.extraAttempts;
    const startedAt = Date.now();
    // SSE idle timeout 后的重试如果仍固定首请求窗口，容易被同一段 provider 静默窗口反复打断；
    // core recovery 和 adapter 内部 retry 都统一按重试次数每次增加 30s。
    const streamIdleTimeoutMs = resolveModelStreamIdleTimeoutMs({
      baseTimeoutMs: input.streamIdleTimeoutMs,
      retryNumber: (input.request.streamIdleTimeoutRetryNumber ?? 0) + retryBudgetAttempt - 1,
    });
    let emittedEvent = false;
    let emittedRetryBoundaryEvent = false;
    let emittedError = false;
    let retryScheduledFromStreamChunk = false;
    let offPeakQueueHoldFromStreamChunk = false;
    const pendingRetrySafeEvents: ModelStreamEvent[] = [];
    const diagnostics = createStreamDiagnostics();
    const attemptAbortController = createLinkedAbortController(input.request.abortSignal);
    const attemptRequest = {
      ...input.request,
      abortSignal: attemptAbortController.signal,
      messages: requestMessages,
    };
    let statusContext = createAttemptStatusContext(
      {
        ...baseStatusContext,
        maxAttempts: statusMaxAttempts(Number(signatureRepairAttempted) + authRetry.extraAttempts),
      },
      attempt,
    );
    const toolCallAssembler = new StreamingToolCallAssembler({ logger: input.logger });
    let streamIterator: AsyncIterator<TextStreamPart<ToolSet>> | undefined;
    let streamReachedNaturalEnd = false;
    let attemptFailed = false;
    let awaitIteratorClose = false;
    let terminalStatusPublished = false;
    // 提升到 try 外,使 catch 分支也能拿到 options/result 记录失败 model-io。
    let options: ReturnType<typeof createStreamTextOptions> | undefined;
    let result: AiSdkStreamTextResult | undefined;
    let requestHeaders: Record<string, string> = {};
    let requestHeaderCount = 0;
    let resolved = input.resolved;
    let timeToFirstProviderEventMs: number | undefined;
    let timeToFirstContentMs: number | undefined;
    let timeToFirstTextMs: number | undefined;
    let streamMaxIdleMs = 0;
    let streamStallCount = 0;
    let streamOutputCommitted = false;
    let firstTokenWatchdog: FirstTokenWatchdog | undefined;
    const repairThinkingSignatureRejection = (error: unknown): boolean => {
      if (signatureRepairAttempted || resolved.providerKind !== "anthropic") {
        return false;
      }
      const repairedMessages = repairReasoningHistoryAfterSignatureRejection(
        requestMessages,
        error,
      );
      if (!repairedMessages) return false;

      // 签名只对生成它的 thinking block 有效。流尚未提交输出时，只替换
      // 本次请求副本，并给一次不占普通 retry 预算且拥有新 requestId 的物理请求机会；
      // 不能把清理结果写回 canonical history。
      signatureRepairAttempted = true;
      requestMessages = repairedMessages;
      input.logger?.warn("Retrying model stream after thinking signature rejection", {
        attempt,
        event: "model.reasoning_signature_repair.retry",
        maxAttempts: input.retry.maxAttempts + 1 + authRetry.extraAttempts,
        nextAttempt: attempt + 1,
        requestId: statusContext.requestId,
        status: "waiting",
      });
      return true;
    };
    const publishVisibleMilestones = async (observation: {
      contentMs?: number;
      textMs?: number;
    }): Promise<void> => {
      if (timeToFirstContentMs === undefined && observation.contentMs !== undefined) {
        timeToFirstContentMs = observation.contentMs;
        await publishModelTelemetryMilestone(
          {
            ...statusContext,
            attempt,
            elapsedMs: observation.contentMs,
            timestamp: new Date(startedAt + observation.contentMs).toISOString(),
            type: "model_first_content",
          },
          { logger: input.logger, statusSink: input.statusSink },
        );
      }
      if (timeToFirstTextMs === undefined && observation.textMs !== undefined) {
        timeToFirstTextMs = observation.textMs;
        await publishModelTelemetryMilestone(
          {
            ...statusContext,
            attempt,
            elapsedMs: observation.textMs,
            timestamp: new Date(startedAt + observation.textMs).toISOString(),
            type: "model_first_text",
          },
          { logger: input.logger, statusSink: input.statusSink },
        );
      }
    };

    // 进程级准入：每次尝试发出前等槽位，
    // 票据在本次尝试结束时归还（成功 / 失败 / 抛出 / 消费者放弃流都经 finally；退避 sleep 之前先归还）。
    // 等待中被取消 → 与 sleep 被取消同一条路：记 connect 阶段的 cancelled 失败，抛出。
    let admission: AttemptAdmission;
    try {
      admission = await admitAttempt({
        admission: input.request.modelRequestAdmission,
        model: { providerId: String(resolved.providerId), modelId: String(resolved.modelId) },
        signal: input.request.abortSignal,
        ...admissionWaitPublishers(statusContext, attempt, statusPublishOptions(input)),
      });
    } catch (admitError) {
      attemptAbortController.cleanup();
      const admitFailure = classifyModelFailure(admitError, input.request.abortSignal);
      await publishModelStatus(
        {
          ...statusContext,
          attempt,
          durationMs: Date.now() - startedAt,
          message: admitFailure.message,
          reason: admitFailure.reason,
          requestHeaderCount,
          requestHeaders,
          retryable: false,
          statusCode: admitFailure.statusCode,
          streamOutputCommitted,
          ...modelFailureStatusFields(admitError, admitFailure, "connect"),
          timestamp: new Date().toISOString(),
          type: "model_request_failed",
        },
        {
          ...statusPublishOptions(input),
          failureError: unwrapRetryError(admitError),
        },
      );
      throw toAdapterError(admitError, admitFailure, statusContext, attempt, {
        errorPhase: "connect",
      });
    }

    try {
      resolved = await resolveModelForAttempt({
        attempt,
        reason: authRetry.takeReason(),
        request: authRetry.prepareRequest(attemptRequest),
        resolveModel: input.resolveModel,
      });
      const anthropicMetadataUserId = await resolveAnthropicRequestMetadataUserId({
        env: input.env,
        providerKind: resolved.providerKind,
        sessionId: statusContext.sessionId,
      });
      options = createStreamTextOptions({
        anthropicMetadataUserId,
        env: input.env,
        includeModelIO: recordModelIO,
        request: attemptRequest,
        resolved,
        statusContext,
      });
      requestHeaders = sanitizeModelNetworkHeaders(options.headers);
      requestHeaderCount = Object.keys(requestHeaders).length;
      await publishModelStatus(
        {
          ...statusContext,
          attempt,
          requestHeaderCount,
          requestHeaders,
          timestamp: new Date(startedAt).toISOString(),
          type: "model_request_started",
        },
        statusPublishOptions(input, admission),
      );
      // 首 token 看门狗：窗口从 model_request_started 起算，而不是从 streamText() 调用起算，
      // 否则 provider 建连耗时会被重复计入。触发时只 abort 本次 attempt 的 controller，
      // 重试次数与最终错误码仍由既有 retry 逻辑和 failure classifier 决定。
      firstTokenWatchdog = createFirstTokenWatchdog({
        controller: attemptAbortController.controller,
        timeoutMs: input.firstTokenTimeoutMs ?? DEFAULT_MODEL_FIRST_TOKEN_TIMEOUT_MS,
      });
      const streamResult = input.runtime.streamText(options);
      result = streamResult;
      streamIterator = streamResult.fullStream[Symbol.asyncIterator]();

      while (true) {
        const next = await readNextWithStreamIdleTimeout(streamIterator, {
          abortController: attemptAbortController.controller,
          onTimeout: async (error) => {
            streamStallCount += 1;
            streamMaxIdleMs = Math.max(streamMaxIdleMs, error.idleMs);
            await publishModelStatus(
              {
                ...statusContext,
                attempt,
                idleMs: error.idleMs,
                message: error.message,
                requestHeaderCount,
                requestHeaders,
                timeoutMs: error.timeoutMs,
                timestamp: new Date().toISOString(),
                type: "model_stream_stalled",
              },
              statusPublishOptions(input, admission),
            );
          },
          timeoutMs: streamIdleTimeoutMs,
        });
        // 任何 provider 输出（首个增量、工具调用或终止块）都证明连接是活的：
        // 立即停表，避免 90s 计时器在后续重试/清理阶段误中止本 attempt。
        if (next.done || isFirstTokenOutputPart(next.value)) {
          firstTokenWatchdog?.cancel();
        }
        if (next.done) {
          streamReachedNaturalEnd = true;
          break;
        }
        if (timeToFirstProviderEventMs === undefined) {
          timeToFirstProviderEventMs = Date.now() - startedAt;
          await publishModelTelemetryMilestone(
            {
              ...statusContext,
              attempt,
              elapsedMs: timeToFirstProviderEventMs,
              timestamp: new Date(startedAt + timeToFirstProviderEventMs).toISOString(),
              type: "model_first_provider_event",
            },
            { logger: input.logger, statusSink: input.statusSink },
          );
        }

        let event: Awaited<ReturnType<typeof handleStreamChunk>>;
        try {
          event = await handleStreamChunk({
            admission,
            attempt,
            chunk: next.value,
            diagnostics,
            emittedRetryBoundaryEvent,
            input,
            pendingRetrySafeEvents,
            requestHeaderCount,
            requestHeaders,
            repairThinkingSignatureRejection,
            canRecoverProjectToken: (error) => authRetry.canRecoverProjectToken(error),
            retryBudgetAttempt,
            startedAt,
            statusContext,
            toolCallAssembler,
          });
        } catch (error) {
          const directToolCommit = compactDirectToolCallCommitEvent(input.request, next.value);
          if (directToolCommit) {
            // 完整 direct tool-call 已是 provider 事件；name/input 校验即使抛错，
            // 也不能让 adapter 当作首事件前失败再次 SSE 重放。
            emittedRetryBoundaryEvent = true;
            for (const pendingEvent of pendingRetrySafeEvents.splice(0)) {
              emittedEvent = true;
              yield pendingEvent;
            }
            // 无 raw message-block provenance 的 provider 可能直接给完整 tool-call。
            // 先把 inferred block stop 交给隐藏 collector，再传播校验错误，避免 HTTP 重放。
            emittedEvent = true;
            yield directToolCommit;
          }
          throw error;
        }
        if (event.visibleEvents.some((visibleEvent) => visibleEvent.type === "finish")) {
          const contextError = createEmptyContextExceededError({
            finishReason: diagnostics.finishReason,
            rawFinishReason: diagnostics.rawFinishReason,
            hasAssistantContent: diagnostics.textDeltaChars > 0 || diagnostics.hasReasoningContent,
            toolCallCount: toolCallAssembler.snapshotNormalizedToolCalls().length,
            usage: diagnostics.usage,
          });
          // 先于 yield finish 进入既有 catch，每个请求只发布一个失败终态。
          if (contextError) throw contextError;
        }
        const shouldHoldEmptyCompletionEvents =
          !event.emittedError &&
          event.visibleEvents.some((visibleEvent) => visibleEvent.type === "finish") &&
          input.request.preserveProviderStreamBoundaries !== true &&
          isZeroOutputModelCompletion({
            finishReason: diagnostics.finishReason,
            rawFinishReason: diagnostics.rawFinishReason,
            reasoningLength: diagnostics.reasoningDeltaChars,
            textLength: diagnostics.textDeltaChars,
            toolCallCount: diagnostics.toolCallCount,
            usage: diagnostics.usage,
          }) &&
          canRetryEmptyCompletion({
            abortSignal: input.request.abortSignal,
            attempt,
            maxAttempts: input.retry.maxAttempts,
            retryCount: emptyCompletionRetryCount,
          });
        if (shouldHoldEmptyCompletionEvents) {
          // finish 会把已缓存的 start 一并刷给 core；先暂存到自然 EOF，确认这是
          // generic empty 后再重试，避免第一次 attempt 的 finish/start 泄漏到 UI。
          event.visibleEvents.length = 0;
        }
        emittedError = emittedError || event.emittedError;
        emittedEvent = emittedEvent || event.emittedEvent;
        emittedRetryBoundaryEvent = emittedRetryBoundaryEvent || event.emittedRetryBoundaryEvent;

        if (event.retryScheduled) {
          // SSE error chunk 的 retry 是正常控制流，不会进入 catch；
          // 若不显式标记失败，finally 会跳过旧 attempt 的 iterator/tee 清理。
          // 下一次物理请求必须等待本轮 abort 与有界清理后才能启动。
          attemptFailed = true;
          awaitIteratorClose = true;
          retryScheduledFromStreamChunk = true;
          offPeakQueueHoldFromStreamChunk = event.offPeakQueueHold;
          break;
        }
        if (event.terminalError) {
          throw event.terminalError;
        }
        if (event.visibleEvents.length > 0) {
          for (const visibleEvent of event.visibleEvents) {
            const observation = observeVisibleStreamEvent(visibleEvent, Date.now() - startedAt);
            await publishVisibleMilestones(observation);
            streamOutputCommitted = streamOutputCommitted || observation.outputCommitted;
            yield visibleEvent;
          }
        }
      }

      if (retryScheduledFromStreamChunk) {
        if (offPeakQueueHoldFromStreamChunk) {
          // 排队等待不消耗重试预算：回退计数让 for 自增后原地重试。
          attempt -= 1;
        }
        continue;
      }

      const flushedEvents = applyStreamEventsToRetryBoundary({
        emittedRetryBoundaryEvent,
        events: toolCallAssembler.flush(),
        pendingRetrySafeEvents,
        preserveProviderStreamBoundaries: input.request.preserveProviderStreamBoundaries,
      });
      emittedEvent = emittedEvent || flushedEvents.emittedEvent;
      emittedRetryBoundaryEvent =
        emittedRetryBoundaryEvent || flushedEvents.emittedRetryBoundaryEvent;
      if (flushedEvents.visibleEvents.length > 0) {
        for (const visibleEvent of flushedEvents.visibleEvents) {
          const observation = observeVisibleStreamEvent(visibleEvent, Date.now() - startedAt);
          await publishVisibleMilestones(observation);
          streamOutputCommitted = streamOutputCommitted || observation.outputCommitted;
          yield visibleEvent;
        }
      }

      for (const pendingEvent of pendingRetrySafeEvents.splice(0)) {
        emittedEvent = true;
        const observation = observeVisibleStreamEvent(pendingEvent, Date.now() - startedAt);
        await publishVisibleMilestones(observation);
        streamOutputCommitted = streamOutputCommitted || observation.outputCommitted;
        yield pendingEvent;
      }

      if (!emittedError) {
        // 自然 EOF 后合成的业务错误会通过 TerminalStreamChunkError 直接离开外层 catch；
        // compact 上下文在普通主链路为空，因此必须在合成现场显式保留 stream 阶段。
        // 先识别 provider business error，再考虑 generic empty；否则额度等
        // HTTP 200 空流会被误判成可重试的暂时性空响应。
        const hiddenProviderBusinessError = detectProviderBusinessFinishError({
          providerId: String(statusContext.providerId),
          providerKind: statusContext.providerKind,
          source:
            diagnostics.lastFinishChunk ??
            ({
              type: "finish",
              finishReason: diagnostics.finishReason,
              rawFinishReason: diagnostics.rawFinishReason,
            } satisfies Record<string, unknown>),
        });
        if (hiddenProviderBusinessError) {
          if (isRequestVerificationRejection(hiddenProviderBusinessError))
            throw hiddenProviderBusinessError;
          const failure = classifyModelFailure(
            hiddenProviderBusinessError,
            input.request.abortSignal,
          );
          throw new TerminalStreamChunkError(
            toAdapterError(hiddenProviderBusinessError, failure, statusContext, attempt, {
              ...compactStreamFailureContext(
                input.request.preserveProviderStreamBoundaries,
                "response_body",
              ),
              errorPhase: "stream",
            }),
          );
        }

        if (isSuspiciousStreamDiagnostics(diagnostics)) {
          // 403 JSON 等业务错误有时不会让 AI SDK 抛出 error chunk，流会以空 completion 结束；
          // 若不在 adapter 层终止，core 会误报 “Model returned no text...”。
          const streamEndedWithoutOutputError =
            detectProviderBusinessFinishError({
              providerId: String(statusContext.providerId),
              providerKind: statusContext.providerKind,
              source: diagnostics.lastErrorChunk ?? diagnostics.lastFinishChunk,
            }) ??
            createRequestVerificationEmptyStreamError({
              accountMode: resolved.accountAccess?.mode,
              headers: resolved.headers,
              providerId: String(statusContext.providerId),
              providerKind: resolved.providerKind,
            });
          if (streamEndedWithoutOutputError) {
            if (isRequestVerificationRejection(streamEndedWithoutOutputError))
              throw streamEndedWithoutOutputError;
            const failure = classifyModelFailure(
              streamEndedWithoutOutputError,
              input.request.abortSignal,
            );
            throw new TerminalStreamChunkError(
              toAdapterError(streamEndedWithoutOutputError, failure, statusContext, attempt, {
                ...compactStreamFailureContext(
                  input.request.preserveProviderStreamBoundaries,
                  "response_body",
                ),
                errorPhase: "stream",
              }),
            );
          }

          if (
            input.request.preserveProviderStreamBoundaries !== true &&
            isZeroOutputModelCompletion({
              finishReason: diagnostics.finishReason,
              rawFinishReason: diagnostics.rawFinishReason,
              reasoningLength: diagnostics.reasoningDeltaChars,
              textLength: diagnostics.textDeltaChars,
              toolCallCount: diagnostics.toolCallCount,
              usage: diagnostics.usage,
            }) &&
            canRetryEmptyCompletion({
              abortSignal: input.request.abortSignal,
              attempt,
              maxAttempts: input.retry.maxAttempts,
              retryCount: emptyCompletionRetryCount,
            })
          ) {
            const responseHeaders = await resolveStreamResponseHeaders(streamResult);
            const completedAt = Date.now();
            // finish 会把 retry-safe 前奏刷成可见事件；空 completion 需在
            // flush 前进入一次 adapter retry，避免 core 把第一次 attempt 当成已完成。
            logStreamDiagnostics({
              attempt,
              diagnostics,
              durationMs: completedAt - startedAt,
              emittedError,
              emittedEvent,
              logger: input.logger,
              outboundHeaders: resolved.headers,
              statusContext,
            });
            emptyCompletionRetryCount += 1;
            await scheduleEmptyCompletionRetry({
              abortSignal: input.request.abortSignal,
              attempt,
              completedAt,
              errorPhase: "stream",
              logger: input.logger,
              requestHeaders,
              requestStatusSink: input.request.statusSink,
              responseHeaders,
              retry: input.retry,
              retryBudgetAttempt,
              startedAt,
              statusContext,
              statusSink: input.statusSink,
              streamOutputCommitted: false,
            });
            continue;
          }
        }
      }

      logStreamDiagnostics({
        attempt,
        diagnostics,
        durationMs: Date.now() - startedAt,
        emittedError,
        emittedEvent,
        logger: input.logger,
        outboundHeaders: resolved.headers,
        statusContext,
      });
      if (!emittedError) {
        const completedAt = Date.now();
        const responseHeaders = await resolveStreamResponseHeaders(streamResult);
        await publishModelStatus(
          {
            ...statusContext,
            attempt,
            durationMs: completedAt - startedAt,
            requestHeaderCount,
            requestHeaders,
            responseHeaderCount: Object.keys(responseHeaders).length,
            responseHeaders,
            providerRequestId: providerRequestIdFromHeaders(responseHeaders),
            finishReason: diagnostics.finishReason,
            usage: diagnostics.usage,
            timeToFirstProviderEventMs,
            timeToFirstContentMs,
            timeToFirstTextMs,
            streamMaxIdleMs: streamMaxIdleMs || undefined,
            streamStallCount,
            streamOutputCommitted,
            timestamp: new Date(completedAt).toISOString(),
            type: "model_request_completed",
          },
          statusPublishOptions(input, admission),
        );
        terminalStatusPublished = true;
      }
      if (recordModelIO && options) {
        await recordStreamTextDebug({
          modelIoFullRetentionEnabled: input.modelIoFullRetentionEnabled,
          attempt,
          debugDir: input.debugDir,
          isDev,
          normalizedToolCalls: toolCallAssembler.snapshotNormalizedToolCalls(),
          options,
          recordModelIO,
          request: attemptRequest,
          requestId: statusContext.requestId,
          resolved,
          result: streamResult,
          startedAt,
        });
      }
      return;
    } catch (error) {
      attemptFailed = true;
      const failureOutcome = await handleStreamAttemptFailure({
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
        modelInput: input,
        options,
        readSignatureRepairAttempted: () => signatureRepairAttempted,
        recordModelIO,
        repairThinkingSignatureRejection,
        requestHeaderCount,
        requestHeaders,
        resolved,
        result,
        retryBudget,
        retryBudgetAttempt,
        startedAt,
        statusContext,
        statusMaxAttempts,
        streamIterator,
        streamOutputCommitted,
        toolCallAssembler,
      });
      awaitIteratorClose = failureOutcome.awaitIteratorClose;
      terminalStatusPublished = failureOutcome.terminalStatusPublished;
      if (!failureOutcome.retry) throw failureOutcome.error;
      if (failureOutcome.attemptRewind) attempt -= 1;
    } finally {
      // 无论 attempt 以何种方式结束（成功、失败、消费者提前关闭）都必须停表；
      // cancel 幂等，首 token 已到时是无操作。
      firstTokenWatchdog?.cancel();
      if (
        !streamReachedNaturalEnd &&
        (attemptFailed || input.request.preserveProviderStreamBoundaries === true)
      ) {
        // 普通 stream 的 429 retry 失败若不进入本清理分支，
        // AI SDK fullStream tee 会持有旧 provider 请求，连续重试会让后续物理请求卡在发送前。
        // 失败 attempt 必须无条件中止并释放；普通 consumer 主动提前结束仍保持原语义。
        if (!attemptAbortController.signal.aborted) {
          attemptAbortController.controller.abort(
            new Error("Model stream attempt ended before natural EOF."),
          );
        }
        if (!attemptFailed && !terminalStatusPublished && !emittedError) {
          // consumer 侧的校验异常只会触发 AsyncIteratorClose，不会回到上面的 catch；
          // 将已启动的物理请求收口为 cancelled，避免 fallback 前遗留悬空 started 状态。
          const completedAt = Date.now();
          await publishModelStatus(
            {
              ...statusContext,
              attempt,
              durationMs: completedAt - startedAt,
              message: "Model stream consumer closed before natural EOF.",
              reason: ModelFailureReasonValue.Cancelled,
              requestHeaderCount,
              requestHeaders,
              retryable: false,
              errorCode: "model_request_cancelled",
              errorPhase: "stream",
              exceptionType: "AbortError",
              streamOutputCommitted,
              timestamp: new Date(completedAt).toISOString(),
              type: "model_request_failed",
            },
            statusPublishOptions(input, admission),
          );
        }
        if (attemptFailed && awaitIteratorClose) {
          await closeStreamIteratorBestEffort(streamIterator, {
            attempt,
            logger: input.logger,
            result,
          });
        } else {
          void closeStreamIteratorBestEffort(streamIterator, {
            attempt,
            logger: input.logger,
          });
        }
      } else if (attemptAbortController.signal.aborted) {
        // 普通 main 保留既有生命周期：只有 caller/idle 已经 abort 时才 best-effort 关闭 iterator。
        void closeStreamIteratorBestEffort(streamIterator, {
          attempt,
          logger: input.logger,
        });
      }
      attemptAbortController.cleanup();
      // 兜底归还（成功 / 抛出 / 消费者提前 return 都到这里）；正常失败路径已在 sleep 前归还，幂等。
      admission.release();
    }
  }
}
