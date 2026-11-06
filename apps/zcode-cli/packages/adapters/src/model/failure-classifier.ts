import {
  ModelErrorCode,
  ModelFailureReason as ModelFailureReasonValue,
  ModelRetryReason as ModelRetryReasonValue,
  type ModelErrorCode as ModelErrorCodeType,
  type ModelFailureReason,
  type ModelRetryReason,
} from "@zcode/contracts";
import {
  getApiCallResponseBody,
  getErrorCode,
  getResponseHeaders,
  getStatusCode,
  isAbortFailure,
  isContextExceededFailure,
  isNetworkFailure,
  isProviderMarkedRetryable,
  isTransportFetchFailure,
  isProxyFailure,
  isTimeoutFailure,
  parseRetryAfterMs,
  isOpenCodeFreeLimitError,
  isOpenCodeFreeUsageLimitMessage,
  isGenericUsageLimitMessage,
  readOpenCodeRequestDiagnostic,
  readOpenCodeSessionDiagnostic,
  readProviderRetryAfterMs,
  unwrapRetryError,
} from "./failure-inspection.js";
import { readMappedAiSdkProviderBusinessError } from "./failure-ai-sdk-provider-error.js";
import { isTlsFailure } from "./failure-tls.js";
import {
  isProviderBusinessError,
  readProviderBusinessFailureFromBody,
  ProviderBusinessError,
} from "./model-execution.js";
import {
  getProviderBusinessCodeMapping,
  isProviderQuotaBusinessCode,
  isRetryableProviderBusinessNetworkFailure,
  isRetryableProviderBusinessTimeoutFailure,
} from "./failure-provider-business-codes.js";
import { isModelFirstTokenTimeoutError } from "./first-token-watchdog.js";
import { isModelStreamIdleTimeoutError } from "./stream-idle-timeout.js";
import { isRetryAfterBeyondHonoredWait } from "./retry-policy.js";

const PROVIDER_BUSINESS_ERROR_WRAPPER_CODE = "PROVIDER_BUSINESS_ERROR";

// registry.ts 的 admission 拒绝与 turn.ts 的预算中止共用同一句文案，只有预算维度不同。
const RUN_BUDGET_EXHAUSTED_PATTERN = /root run (resource|token|time) budget (is )?exhausted/i;

function isLongRetryAfter(retryAfterMs: number | undefined): boolean {
  return isRetryAfterBeyondHonoredWait(retryAfterMs);
}

export interface ClassifiedModelFailure {
  code: ModelErrorCodeType;
  message: string;
  reason: ModelFailureReason;
  retryReason: ModelRetryReason;
  retryable: boolean;
  retryAfterMs?: number;
  /** 与 retryAfterMs 同源，便于日志/UI 直接展示等待秒数。 */
  retryAfterSeconds?: number;
  statusCode?: number;
  /** 配额耗尽（402、超长 Retry-After 的 429、FreeUsageLimitError）：不应重试，交给上层切换 Provider。 */
  providerQuotaExhausted?: boolean;
}

export interface ProviderFailureDetails {
  providerErrorCode?: string;
  providerErrorMessage?: string;
  providerRequestId?: string;
}

export function inspectProviderFailure(error: unknown): ProviderFailureDetails {
  const unwrapped = unwrapRetryError(error);
  const openCodeDiagnostic =
    readOpenCodeSessionDiagnostic(unwrapped) ?? readOpenCodeRequestDiagnostic(unwrapped);
  // 分类链路能读取 AI SDK parsed error，但观测链路只认识 ProviderBusinessError，
  // 导致同一次失败在 status event 与最终 error context 中丢失 provider 诊断字段。
  const businessError =
    findProviderBusinessError(unwrapped) ?? readMappedAiSdkProviderBusinessError(unwrapped);
  if (businessError) {
    return {
      providerErrorCode: resolveProviderBusinessCode(businessError),
      providerErrorMessage: providerBusinessMessage(businessError),
      providerRequestId: businessError.providerRequestId,
    };
  }
  const detected = readProviderBusinessFailureFromBody(getApiCallResponseBody(unwrapped));
  if (detected) {
    return {
      providerErrorCode:
        typeof detected.providerCode === "number"
          ? String(detected.providerCode)
          : detected.providerCode,
      providerErrorMessage: detected.providerMessage,
      providerRequestId: detected.providerRequestId,
    };
  }
  return openCodeDiagnostic
    ? {
        providerErrorCode: openCodeDiagnostic.code,
        providerErrorMessage: openCodeDiagnostic.message,
      }
    : {};
}

export function classifyModelFailure(
  error: unknown,
  abortSignal?: AbortSignal,
): ClassifiedModelFailure {
  const unwrapped = unwrapRetryError(error);
  const statusCode = getStatusCode(unwrapped);
  const code = getErrorCode(unwrapped);
  const headers = getResponseHeaders(unwrapped);
  const retryAfterMs = parseRetryAfterMs(headers) ?? readProviderRetryAfterMs(unwrapped);

  const openCodeDiagnostic =
    readOpenCodeSessionDiagnostic(unwrapped) ?? readOpenCodeRequestDiagnostic(unwrapped);
  const openCodeProviderFailure = findProviderBusinessError(unwrapped);
  const openCodeProviderMessage =
    openCodeDiagnostic?.message ??
    (openCodeProviderFailure?.providerId === "opencode"
      ? providerBusinessMessage(openCodeProviderFailure)
      : undefined);
  const rawMessage = unwrapped instanceof Error ? unwrapped.message : undefined;
  // session.error、SDK 空响应的 Original error 尾部、以及 1.19.x 的 session.status(retry)
  // 都带同一句免费额度文案；只在确认是 OpenCode 时把通用 “usage limit reached” 也算进来。
  const openCodeContext =
    openCodeDiagnostic !== undefined ||
    openCodeProviderFailure?.providerId === "opencode" ||
    isOpenCodeFreeLimitError(unwrapped);
  const openCodeFreeLimit =
    isOpenCodeFreeLimitError(unwrapped) ||
    isOpenCodeFreeUsageLimitMessage(openCodeProviderMessage) ||
    isOpenCodeFreeUsageLimitMessage(rawMessage) ||
    (openCodeContext && isGenericUsageLimitMessage(rawMessage));
  // 只认这句/这个 code，避免把通用 5xx 当成配额，也不把配额当成可重试的网络错误。
  if (openCodeFreeLimit) {
    return {
      code: ModelErrorCode.OpenCodeFreeLimitReached,
      message:
        "OpenCode free usage limit reached. Resets in about 4 hours, or switch to another model.",
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: false,
      providerQuotaExhausted: true,
      retryAfterMs,
      retryAfterSeconds: retryAfterMs === undefined ? undefined : Math.round(retryAfterMs / 1000),
      statusCode: statusCode ?? 429,
    };
  }

  if (code === "OPENCODE_WORKSPACE_UNAVAILABLE") {
    return {
      code: ModelErrorCode.ModelRequestFailed,
      message:
        "OpenCode needs an available workspace folder. Reopen or restore the workspace, then try again.",
      reason: ModelFailureReasonValue.Unknown,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
      statusCode,
    };
  }

  if (code === ModelErrorCode.InvalidModelResponse) {
    return {
      code: ModelErrorCode.InvalidModelResponse,
      message:
        unwrapped instanceof Error ? unwrapped.message : "Model returned an invalid response.",
      reason: ModelFailureReasonValue.InvalidRequest,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
      statusCode,
    };
  }

  if (code === ModelErrorCode.InvalidModelRequest) {
    return {
      code: ModelErrorCode.InvalidModelRequest,
      message:
        unwrapped instanceof Error ? unwrapped.message : "Model request configuration is invalid.",
      reason: ModelFailureReasonValue.InvalidRequest,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
      statusCode,
    };
  }

  // Bug 原因：root run 预算耗尽由 registry/turn 以普通 Error 抛出，既没有 error.code 也没有
  // HTTP 状态；预算中止会同时 abort 该 run，因此错误里带 AbortSignal 语义。
  // 若先走 isAbortFailure，这里只会得到 cancelled，掩盖真实的预算原因。
  // 因此预算判定必须放在 abort 检查之前。
  const runBudgetMessage = readRunBudgetExhaustedMessage(unwrapped, error);
  if (runBudgetMessage) {
    return {
      code: ModelErrorCode.ModelRequestFailed,
      message: runBudgetMessage,
      reason: ModelFailureReasonValue.RunBudgetExhausted,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
      statusCode,
    };
  }

  // 首 token 看门狗以 signal.reason 的形式抛出（DOM 规范：abort(reason) 后 throwIfAborted
  // 抛的就是 reason）。必须放在 isAbortFailure 之前：abort 语义会把这类失败降级成
  // cancelled，既隐藏了「provider 没回第一个 token」的真实原因，也会让自动重试失效。
  if (isModelFirstTokenTimeoutError(unwrapped)) {
    return {
      code: ModelErrorCode.FirstTokenTimeout,
      message: unwrapped.message,
      reason: ModelFailureReasonValue.Timeout,
      retryReason: ModelRetryReasonValue.Timeout,
      retryable: true,
      statusCode,
    };
  }

  if (isAbortFailure(unwrapped, abortSignal)) {
    return {
      code: ModelErrorCode.ModelRequestCancelled,
      message: "Model request was cancelled.",
      reason: ModelFailureReasonValue.Cancelled,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
      statusCode,
    };
  }

  if (isModelStreamIdleTimeoutError(unwrapped)) {
    return {
      code: ModelErrorCode.ModelRequestTimeout,
      message: unwrapped.message,
      reason: ModelFailureReasonValue.StreamIdleTimeout,
      retryReason: ModelRetryReasonValue.StreamIdleTimeout,
      retryable: true,
      retryAfterMs,
      statusCode,
    };
  }

  // fetch 层提前抛出的 ProviderBusinessError 不走 APICallError，
  // retry-after 必须在业务错误归一化时继续传下去。
  const providerBusinessFailure = classifyProviderBusinessFailure(
    findProviderBusinessError(unwrapped) ?? unwrapped,
    statusCode,
    retryAfterMs,
  );
  if (providerBusinessFailure) {
    return providerBusinessFailure;
  }

  // AI SDK 的请求错误保留在 APICallError.data.error，流式 SSE 错误则直接提供
  // 已解析的 error 对象；这里统一消费这两种 AI SDK 输出，不新增 provider 原始响应旁路。
  const aiSdkErrorFailure = classifyProviderBusinessFailure(
    readMappedAiSdkProviderBusinessError(unwrapped),
    statusCode,
    retryAfterMs,
  );
  if (aiSdkErrorFailure) {
    return aiSdkErrorFailure;
  }

  // AI SDK 有时把 403 JSON（如 3007）包成 APICallError，不走 ProviderBusinessError；
  // 若在通用 403 鉴权分支之前不解析 responseBody，会误显示 “Provider authentication failed.”。
  const apiCallBodyFailure = classifyProviderBusinessFailureFromApiCallBody(
    unwrapped,
    statusCode,
    retryAfterMs,
  );
  if (apiCallBodyFailure) {
    return apiCallBodyFailure;
  }

  if (isTimeoutFailure(unwrapped, code, statusCode)) {
    return {
      code: ModelErrorCode.ModelRequestTimeout,
      message: "Model request timed out.",
      reason: ModelFailureReasonValue.Timeout,
      retryReason: ModelRetryReasonValue.Timeout,
      retryable: true,
      retryAfterMs,
      statusCode,
    };
  }

  if (statusCode === 402) {
    return {
      code: ModelErrorCode.ModelRateLimited,
      message: "Provider quota is exhausted.",
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: false,
      providerQuotaExhausted: true,
      retryAfterMs,
      statusCode,
    };
  }

  if (statusCode === 429) {
    // Retry-After 超过 10 分钟说明不是短时限流；继续重试只会让用户空等，
    // 标记为配额耗尽后由上层立即切换 Provider。
    return {
      code: ModelErrorCode.ModelRateLimited,
      message: "Provider rate limited the model request.",
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: !isLongRetryAfter(retryAfterMs),
      ...(isLongRetryAfter(retryAfterMs) ? { providerQuotaExhausted: true } : {}),
      retryAfterMs,
      retryAfterSeconds: retryAfterMs === undefined ? undefined : Math.round(retryAfterMs / 1000),
      statusCode,
    };
  }

  if (statusCode === 529) {
    return {
      code: ModelErrorCode.ModelRequestFailed,
      message: "Provider is overloaded.",
      reason: ModelFailureReasonValue.ProviderOverloaded,
      retryReason: ModelRetryReasonValue.ProviderOverloaded,
      retryable: true,
      retryAfterMs,
      statusCode,
    };
  }

  if (statusCode === 401 || statusCode === 403) {
    // OpenCode 没有 ZCode API key：登录只发生在 CLI，这里只给出明确的 sign-in 错误。
    const openCodeSignIn =
      findProviderBusinessError(unwrapped)?.providerId === "opencode" ||
      readOpenCodeSessionDiagnostic(unwrapped) !== undefined ||
      readOpenCodeRequestDiagnostic(unwrapped) !== undefined;
    return {
      code: ModelErrorCode.ProviderNotConfigured,
      message: openCodeSignIn
        ? "OpenCode sign-in is required. Sign in with the OpenCode CLI; ZCode does not read or copy those credentials."
        : "Provider authentication failed.",
      reason: ModelFailureReasonValue.AuthFailed,
      retryReason: ModelRetryReasonValue.AuthRefresh,
      retryable: false,
      statusCode,
    };
  }

  if (statusCode === 400 || statusCode === 422) {
    const contextExceeded = isContextExceededFailure(unwrapped);
    return {
      code: contextExceeded
        ? ModelErrorCode.ModelContextExceeded
        : ModelErrorCode.InvalidModelRequest,
      message: contextExceeded
        ? "Model request exceeded the provider context window."
        : "Provider rejected the model request.",
      reason: contextExceeded
        ? ModelFailureReasonValue.ContextExceeded
        : ModelFailureReasonValue.InvalidRequest,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
      statusCode,
    };
  }

  if (isContextExceededFailure(unwrapped)) {
    return {
      code: ModelErrorCode.ModelContextExceeded,
      message: "Model request exceeded the provider context window.",
      reason: ModelFailureReasonValue.ContextExceeded,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
      statusCode,
    };
  }

  if (isTlsFailure(code)) {
    return {
      code: ModelErrorCode.ModelRequestFailed,
      message: "TLS validation failed for the provider request.",
      reason: ModelFailureReasonValue.TlsError,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
      statusCode,
    };
  }

  if (isProxyFailure(code)) {
    return {
      code: ModelErrorCode.ModelRequestFailed,
      message: "Proxy connection failed for the provider request.",
      reason: ModelFailureReasonValue.ProxyError,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: true,
      retryAfterMs,
      statusCode,
    };
  }

  if (isNetworkFailure(code)) {
    return {
      code: ModelErrorCode.ModelRequestFailed,
      message: "Network connection failed for the provider request.",
      reason: ModelFailureReasonValue.NetworkError,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: true,
      retryAfterMs,
      statusCode,
    };
  }

  // Bug 原因：OpenCode SDK 的 createEmptyResponseDataError 把 undici "fetch failed"
  // 只拼进 message，并写死 isRetryable:false，不保留 cause.code。分类器原先只看
  // error.code 和 isRetryable，于是网络断开和「模型 id 无效的空响应」都变成
  // reason=unknown、retryable=false。传输失败必须走既有 network_error 重试；
  // 没有 Original error: fetch failed 的空响应仍保持不可重试。
  if (isTransportFetchFailure(unwrapped)) {
    return {
      code: ModelErrorCode.ModelRequestFailed,
      message: "Network connection failed for the provider request.",
      reason: ModelFailureReasonValue.NetworkError,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: true,
      retryAfterMs,
      statusCode,
    };
  }

  // 根因：OpenCode SDK 把本地服务的异常响应包装成 “no response data”，旧文案却推断模型 ID 错误。
  // 修复依据：上游只返回通用 500 时无法判定模型原因；提示查看 OpenCode 日志，不诱导用户换模型。
  const emptyOpenCodeResponse =
    code === "OPENCODE_EMPTY_RESPONSE" ||
    (unwrapped instanceof Error &&
      unwrapped.message.includes("OpenCode returned no response data for model "));
  if (emptyOpenCodeResponse) {
    const localServerFailure =
      (unwrapped instanceof Error &&
        /Original error:\s*Unexpected server error\b/iu.test(unwrapped.message)) ||
      (statusCode !== undefined && statusCode >= 500);
    return {
      code: ModelErrorCode.ModelRequestFailed,
      message: localServerFailure
        ? "OpenCode's local server failed while processing the request. Check the OpenCode CLI logs; the model ID has not been identified as the cause."
        : "OpenCode returned no model response. Check the OpenCode CLI logs; the model ID has not been identified as the cause.",
      reason: ModelFailureReasonValue.Unknown,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
      retryAfterMs,
      statusCode,
    };
  }

  if (statusCode !== undefined && statusCode >= 500) {
    return {
      code: ModelErrorCode.ModelRequestFailed,
      message: "Provider returned a server error.",
      reason: ModelFailureReasonValue.ServerError,
      retryReason: ModelRetryReasonValue.ServerError,
      retryable: true,
      retryAfterMs,
      statusCode,
    };
  }

  const retryable = isProviderMarkedRetryable(unwrapped);
  return {
    code: ModelErrorCode.ModelRequestFailed,
    message: retryable
      ? "Provider marked the model request as retryable."
      : "Model request failed.",
    reason: retryable ? ModelFailureReasonValue.ServerError : ModelFailureReasonValue.Unknown,
    retryReason: retryable ? ModelRetryReasonValue.ServerError : ModelRetryReasonValue.NetworkError,
    retryable,
    retryAfterMs,
    statusCode,
  };
}

export function isRetryableFailure(failure: ClassifiedModelFailure): boolean {
  return failure.retryable && failure.reason !== ModelFailureReasonValue.Cancelled;
}

// 预算错误可能是 Error、被包装的 Error，或（异常路径下）纯字符串，
// 这里逐一安全取值，避免对非 Error 值做 instanceof 之外的操作。
function readRunBudgetExhaustedMessage(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    for (const text of readFailureTexts(candidate)) {
      if (RUN_BUDGET_EXHAUSTED_PATTERN.test(text)) {
        return text;
      }
    }
  }
  return undefined;
}

function readFailureTexts(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (!(value instanceof Error)) {
    return [];
  }

  const texts = [value.message];
  const cause = (value as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    texts.push(cause.message);
  } else if (typeof cause === "string") {
    texts.push(cause);
  }
  return texts;
}

function classifyProviderBusinessFailureFromApiCallBody(
  error: unknown,
  statusCode?: number,
  retryAfterMs?: number,
): ClassifiedModelFailure | undefined {
  const body = getApiCallResponseBody(error);
  const detected = readProviderBusinessFailureFromBody(body);
  if (!detected) {
    return undefined;
  }

  return classifyProviderBusinessFailure(
    new ProviderBusinessError({
      providerCode: detected.providerCode,
      providerId: "unknown",
      providerKind: "openai-compatible",
      providerMessage: detected.providerMessage,
      providerRequestId: detected.providerRequestId,
      responseBodySummary: detected.responseBodySummary,
      responseStatus: statusCode ?? detected.statusCode,
      statusCode: statusCode ?? detected.statusCode,
    }),
    statusCode ?? detected.statusCode,
    retryAfterMs,
  );
}

function classifyProviderBusinessFailure(
  error: unknown,
  statusCode?: number,
  retryAfterMs?: number,
): ClassifiedModelFailure | undefined {
  if (!isProviderBusinessError(error)) {
    return undefined;
  }

  const message = providerBusinessMessage(error);
  const providerCode = resolveProviderBusinessCode(error);
  const effectiveStatusCode = resolveProviderBusinessStatusCode(error, statusCode);
  const mappedFailure = providerCode ? getProviderBusinessCodeMapping(providerCode) : undefined;
  if (mappedFailure) {
    return {
      code: mappedFailure.code,
      message: mappedFailure.message ?? message,
      reason: mappedFailure.reason,
      retryReason: mappedFailure.retryReason,
      retryable: mappedFailure.retryable,
      ...(isProviderQuotaBusinessCode(providerCode) ? { providerQuotaExhausted: true } : {}),
      retryAfterMs,
      statusCode: effectiveStatusCode,
    };
  }

  if (isContextExceededFailure(error)) {
    return {
      code: ModelErrorCode.ModelContextExceeded,
      message: "Model request exceeded the provider context window.",
      reason: ModelFailureReasonValue.ContextExceeded,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
      retryAfterMs,
      statusCode: effectiveStatusCode,
    };
  }
  if (isRetryableProviderBusinessTimeoutFailure(error, providerCode, effectiveStatusCode)) {
    return {
      code: ModelErrorCode.ModelRequestTimeout,
      message,
      reason: ModelFailureReasonValue.Timeout,
      retryReason: ModelRetryReasonValue.Timeout,
      retryable: true,
      retryAfterMs,
      statusCode: effectiveStatusCode,
    };
  }
  const retryReason =
    effectiveStatusCode !== undefined && effectiveStatusCode >= 500
      ? ModelRetryReasonValue.ServerError
      : ModelRetryReasonValue.NetworkError;

  if (effectiveStatusCode === 401 || effectiveStatusCode === 403) {
    return {
      code: ModelErrorCode.ProviderNotConfigured,
      message:
        error.providerId === "opencode"
          ? "OpenCode sign-in is required. Sign in with the OpenCode CLI; ZCode does not read or copy those credentials."
          : message,
      reason: ModelFailureReasonValue.AuthFailed,
      retryReason: ModelRetryReasonValue.AuthRefresh,
      retryable: false,
      retryAfterMs,
      statusCode: effectiveStatusCode,
    };
  }

  if (effectiveStatusCode === 404) {
    return {
      code: ModelErrorCode.ModelNotFound,
      message,
      reason: ModelFailureReasonValue.InvalidRequest,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
      retryAfterMs,
      statusCode: effectiveStatusCode,
    };
  }

  if (effectiveStatusCode === 400 || effectiveStatusCode === 422) {
    return {
      code: ModelErrorCode.InvalidModelRequest,
      message,
      reason: ModelFailureReasonValue.InvalidRequest,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: false,
      retryAfterMs,
      statusCode: effectiveStatusCode,
    };
  }

  if (effectiveStatusCode === 402) {
    return {
      code: ModelErrorCode.ModelRateLimited,
      message,
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: false,
      providerQuotaExhausted: true,
      retryAfterMs,
      statusCode: effectiveStatusCode,
    };
  }

  if (effectiveStatusCode === 429) {
    // 与通用 429 分支一致：Retry-After 超过 10 分钟视为配额耗尽，交给上层切换 Provider。
    return {
      code: ModelErrorCode.ModelRateLimited,
      message,
      reason: ModelFailureReasonValue.RateLimited,
      retryReason: ModelRetryReasonValue.RateLimited,
      retryable: !isLongRetryAfter(retryAfterMs),
      ...(isLongRetryAfter(retryAfterMs) ? { providerQuotaExhausted: true } : {}),
      retryAfterMs,
      retryAfterSeconds: retryAfterMs === undefined ? undefined : Math.round(retryAfterMs / 1000),
      statusCode: effectiveStatusCode,
    };
  }

  if (isRetryableProviderBusinessNetworkFailure(error, providerCode)) {
    return {
      code: ModelErrorCode.ModelRequestFailed,
      message,
      reason: ModelFailureReasonValue.NetworkError,
      retryReason: ModelRetryReasonValue.NetworkError,
      retryable: true,
      retryAfterMs,
      statusCode: effectiveStatusCode,
    };
  }

  if (effectiveStatusCode !== undefined && effectiveStatusCode >= 500) {
    return {
      code: ModelErrorCode.ModelRequestFailed,
      message,
      reason: ModelFailureReasonValue.ServerError,
      retryReason,
      retryable: true,
      retryAfterMs,
      statusCode: effectiveStatusCode,
    };
  }

  return {
    code: ModelErrorCode.ModelRequestFailed,
    message,
    reason: ModelFailureReasonValue.Unknown,
    retryReason,
    retryable: false,
    retryAfterMs,
    statusCode: effectiveStatusCode,
  };
}

export function findProviderBusinessError(
  error: unknown,
  seen = new WeakSet<object>(),
): ProviderBusinessError | undefined {
  if (isProviderBusinessError(error)) {
    return error;
  }
  if (error === null || typeof error !== "object" || seen.has(error)) {
    return undefined;
  }
  seen.add(error);

  // AI SDK 可能把 fetch 层抛出的 ProviderBusinessError 包在 cause 里；
  // 若只看外层 APICallError，会丢掉 providerCode/message/responseHeaders。
  const cause = (error as { cause?: unknown }).cause;
  return cause && cause !== error ? findProviderBusinessError(cause, seen) : undefined;
}

function normalizeProviderCode(value: ProviderBusinessError["providerCode"]): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  if (normalized.length === 0) return undefined;
  return normalized.toUpperCase() === PROVIDER_BUSINESS_ERROR_WRAPPER_CODE ? undefined : normalized;
}

function providerBusinessMessage(error: ProviderBusinessError): string {
  return error.providerMessage ?? error.message ?? "Provider returned a business error.";
}

function resolveProviderBusinessCode(error: ProviderBusinessError): string | undefined {
  const direct = normalizeProviderCode(error.providerCode);
  if (direct) {
    return direct;
  }

  // ProviderBusinessError 可能被 AI SDK/adapter 二次包装，外层 code 是包装类型，
  // 真实 BigModel 码（如 1234/1261）只保留在 responseBodySummary 的深层结构里。
  return readNestedProviderCode(error.responseBodySummary);
}

function resolveProviderBusinessStatusCode(
  error: ProviderBusinessError,
  statusCode: number | undefined,
): number | undefined {
  return (
    normalizeHttpFailureStatus(statusCode) ??
    normalizeHttpFailureStatus(error.statusCode) ??
    normalizeHttpFailureStatus(error.responseStatus) ??
    readNestedStatusCode(error.responseBodySummary)
  );
}

function readNestedProviderCode(value: unknown): string | undefined {
  const records = collectNestedRecords(value);
  const providerCode = firstNormalizedRecordValue(records, "providerCode");
  if (providerCode) return providerCode;

  const errorCode = firstNormalizedRecordValue(records, "error_code");
  if (errorCode) return errorCode;

  const code = firstNormalizedRecordValue(records, "code");
  if (code) return code;

  return firstBracketedProviderCode(records);
}

function readNestedStatusCode(value: unknown): number | undefined {
  const records = collectNestedRecords(value);
  for (const key of ["statusCode", "status", "responseStatus"] as const) {
    for (const record of records) {
      const statusCode = numberProperty(record, key);
      if (normalizeHttpFailureStatus(statusCode) !== undefined) {
        return statusCode;
      }
    }
  }
  return undefined;
}

function firstNormalizedRecordValue(
  records: readonly Record<string, unknown>[],
  key: string,
): string | undefined {
  for (const record of records) {
    const code = normalizeProviderCode(record[key] as ProviderBusinessError["providerCode"]);
    if (code) {
      return code;
    }
  }
  return undefined;
}

function firstBracketedProviderCode(
  records: readonly Record<string, unknown>[],
): string | undefined {
  for (const record of records) {
    const code =
      readBigModelBracketedProviderCode(record.message) ??
      readBigModelBracketedProviderCode(record.providerMessage);
    if (code) {
      return code;
    }
  }
  return undefined;
}

function collectNestedRecords(value: unknown): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  const seen = new WeakSet<object>();
  const queue: unknown[] = [value];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== "object") {
      continue;
    }
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);

    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }

    const record = current as Record<string, unknown>;
    result.push(record);
    for (const nested of Object.values(record)) {
      if (nested && typeof nested === "object") {
        queue.push(nested);
      }
    }
  }

  return result;
}

function numberProperty(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeHttpFailureStatus(value: number | undefined): number | undefined {
  return value !== undefined && value >= 400 && value <= 599 ? value : undefined;
}

function readBigModelBracketedProviderCode(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const match = value.trim().match(/^\[(\d{4})\](?=\[)/);
  return match?.[1];
}
