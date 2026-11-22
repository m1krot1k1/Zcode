import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import { classifyModelFailure, inspectProviderFailure } from "../src/model/failure-classifier.js";
import { detectProviderBusinessFinishError } from "../src/model/provider-finish-business-error.js";
import { ProviderBusinessError } from "../src/model/model-execution.js";

const MAXIMUM_CONTEXT_LENGTH_ERROR =
  "This model's maximum context length is 128000 tokens. However, you requested 64000 output tokens and your prompt contains at least 64001 input tokens, for a total of at least 128001 tokens. Please reduce the length of the input prompt or the number of requested output tokens.";
const AZURE_CONTEXT_LENGTH_ERROR =
  "This model's maximum context length is 300000 tokens. However, your messages resulted in 350564 tokens (100 in the messages, 350464 in the functions). Please reduce the length of the messages or functions.";
const GEMINI_CONTEXT_LENGTH_ERROR =
  "The input token count (131137) exceeds the maximum number of tokens allowed (131072).";

function openCodeEmptyResponseMessage(modelId: string, originalError?: string): string {
  const detail = originalError ? ` Original error: ${originalError}` : "";
  return (
    `OpenCode returned no response data for model "${modelId}".` +
    detail
  );
}

describe("classifyModelFailure context length errors", () => {
  it("maps the reported maximum context length message to context exceeded", () => {
    expect(classifyModelFailure(new Error(MAXIMUM_CONTEXT_LENGTH_ERROR))).toMatchObject({
      code: "model_context_exceeded",
      reason: "context_exceeded",
      retryable: false,
    });
  });

  it("maps Azure's official maximum context length message without relying on its code", () => {
    expect(classifyModelFailure(new Error(AZURE_CONTEXT_LENGTH_ERROR))).toMatchObject({
      code: "model_context_exceeded",
      reason: "context_exceeded",
      retryable: false,
    });
  });

  it("maps a standard 400 response body to context exceeded", () => {
    const error = new APICallError({
      message: "Bad Request",
      responseBody: JSON.stringify({
        error: {
          code: "invalid_request_error",
          message: MAXIMUM_CONTEXT_LENGTH_ERROR,
          type: "invalid_request_error",
        },
      }),
      statusCode: 400,
    });

    expect(classifyModelFailure(error)).toMatchObject({
      code: "model_context_exceeded",
      reason: "context_exceeded",
      retryable: false,
      statusCode: 400,
    });
  });

  it("reads a standard context length response body from an Error cause", () => {
    const error = new Error("Turn execution failed", {
      cause: new APICallError({
        message: "Bad Request",
        responseBody: JSON.stringify({
          error: {
            code: "invalid_request_error",
            message: MAXIMUM_CONTEXT_LENGTH_ERROR,
          },
        }),
        statusCode: 400,
      }),
    });

    expect(classifyModelFailure(error)).toMatchObject({
      code: "model_context_exceeded",
      reason: "context_exceeded",
      retryable: false,
      statusCode: 400,
    });
  });

  it.each([
    "context_length_exceeded",
    "context_window_exceeded",
    "model_context_exceeded",
    "model_context_window_exceeded",
  ])("reads the context code %s from a standard response body", (code) => {
    const error = new APICallError({
      message: "Bad Request",
      responseBody: JSON.stringify({
        error: {
          code,
          message: AZURE_CONTEXT_LENGTH_ERROR,
          type: "invalid_request_error",
        },
      }),
      statusCode: 400,
    });

    expect(classifyModelFailure(error)).toMatchObject({
      code: "model_context_exceeded",
      reason: "context_exceeded",
      retryable: false,
      statusCode: 400,
    });
  });

  it("recognizes Anthropic's official prompt-too-long response", () => {
    const error = new APICallError({
      message: "Bad Request",
      responseBody: JSON.stringify({
        error: {
          message: "prompt is too long",
          type: "invalid_request_error",
        },
        type: "error",
      }),
      statusCode: 400,
    });

    expect(classifyModelFailure(error)).toMatchObject({
      code: "model_context_exceeded",
      reason: "context_exceeded",
      retryable: false,
      statusCode: 400,
    });
  });

  it("recognizes the Gemini API error captured in Google's official CLI repository", () => {
    const error = new APICallError({
      message: "Bad Request",
      responseBody: JSON.stringify({
        error: {
          code: 400,
          message: JSON.stringify({
            error: {
              code: 400,
              message: GEMINI_CONTEXT_LENGTH_ERROR,
              status: "INVALID_ARGUMENT",
            },
          }),
          status: "Bad Request",
        },
      }),
      statusCode: 400,
    });

    expect(classifyModelFailure(error)).toMatchObject({
      code: "model_context_exceeded",
      reason: "context_exceeded",
      retryable: false,
      statusCode: 400,
    });
  });

  it.each([
    "Range of input length should be [1, 131072]",
    "Total message token length exceed model limit (10000000 tokens).",
  ])("recognizes Alibaba Cloud's official context error: %s", (message) => {
    const error = new APICallError({
      message: "Bad Request",
      responseBody: JSON.stringify({
        code: "InvalidParameter",
        message,
      }),
      statusCode: 400,
    });

    expect(classifyModelFailure(error)).toMatchObject({
      code: "model_context_exceeded",
      reason: "context_exceeded",
      retryable: false,
      statusCode: 400,
    });
  });

  it.each([
    {
      name: "Azure's string length validation",
      responseBody: {
        error: {
          code: "string_above_max_length",
          message:
            "Invalid 'tools[0].function.description': string too long. Expected a string with maximum length 1048576, but got a string with length 2778531 instead.",
          type: "invalid_request_error",
        },
      },
      statusCode: 400,
    },
    {
      name: "Alibaba Cloud's max_tokens range validation",
      responseBody: {
        code: "InvalidParameter",
        message: "Range of max_tokens should be [1, 32768]",
      },
      statusCode: 400,
    },
    {
      name: "Mistral's generic bad request",
      responseBody: {
        message: "Bad request",
        type: "invalid_request_error",
      },
      statusCode: 400,
    },
    {
      name: "DeepSeek's generic invalid parameters response",
      responseBody: {
        message: "Invalid parameters",
      },
      statusCode: 422,
    },
    {
      name: "MiniMax's ambiguous max_tokens limit",
      responseBody: {
        base_resp: {
          status_code: 1039,
          status_msg: "Token limit, please adjust max_tokens.",
        },
      },
      statusCode: 400,
    },
  ])("does not over-classify $name as context exceeded", ({ responseBody, statusCode }) => {
    const error = new APICallError({
      message: statusCode === 422 ? "Unprocessable Entity" : "Bad Request",
      responseBody: JSON.stringify(responseBody),
      statusCode,
    });

    expect(classifyModelFailure(error)).toMatchObject({
      code: "invalid_model_request",
      reason: "invalid_request",
      retryable: false,
      statusCode,
    });
  });
});

describe("OpenCode session.create diagnostics", () => {
  it("retains the sanitized upstream status, code, and message through the SDK error wrapper", () => {
    const error = new APICallError({
      message:
        'Failed to create session: {"statusCode":429,"code":"RATE_LIMITED","message":"OpenCode usage limit reached."}',
      url: "opencode://session",
      requestBodyValues: {},
      isRetryable: false,
      data: { errorType: "OpenCodeRequestError", modelId: "opencode/deepseek-v4.1-flash-free" },
    });

    expect(inspectProviderFailure(error)).toEqual({
      providerErrorCode: "RATE_LIMITED",
      providerErrorMessage: "OpenCode usage limit reached.",
    });
    expect(classifyModelFailure(error)).toMatchObject({
      code: "OPENCODE_FREE_LIMIT_REACHED",
      reason: "rate_limited",
      retryable: false,
      statusCode: 429,
    });
  });

  it("identifies an OpenCode authentication failure without exposing the upstream body", () => {
    const error = new APICallError({
      message:
        'Failed to create session: {"statusCode":401,"code":"AUTH_REQUIRED","message":"Sign in required."}',
      url: "opencode://session",
      requestBodyValues: {},
      isRetryable: false,
      data: { errorType: "OpenCodeRequestError" },
    });

    expect(classifyModelFailure(error)).toMatchObject({
      code: "provider_not_configured",
      reason: "auth_failed",
      retryable: false,
      statusCode: 401,
      message:
        "OpenCode sign-in is required. Sign in with the OpenCode CLI; ZCode does not read or copy those credentials.",
    });
  });

  it("surfaces the OpenCode workspace preflight error instead of a generic model failure", () => {
    const error = Object.assign(new Error("private workspace detail"), {
      code: "OPENCODE_WORKSPACE_UNAVAILABLE",
    });

    expect(classifyModelFailure(error)).toMatchObject({
      code: "model_request_failed",
      message:
        "OpenCode needs an available workspace folder. Reopen or restore the workspace, then try again.",
      reason: "unknown",
      retryable: false,
    });
  });
});

describe("classifyModelFailure TLS errors", () => {
  it.each([
    Object.assign(new Error("request failed"), { code: "MODEL_TLS_VALIDATION_FAILED" }),
    Object.assign(new Error("request failed"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" }),
    Object.assign(new Error("request failed"), { code: "SELF_SIGNED_CERT_IN_CHAIN" }),
    Object.assign(new Error("request failed"), { code: "CERT_HAS_EXPIRED" }),
  ])("maps a known TLS failure to tls_error", (error) => {
    expect(classifyModelFailure(error)).toMatchObject({
      code: "model_request_failed",
      reason: "tls_error",
      retryable: false,
    });
  });

  it("does not classify generic certificate prose as a TLS failure", () => {
    expect(classifyModelFailure(new Error("certificate setup is incomplete"))).toMatchObject({
      reason: "unknown",
    });
  });

  it("does not infer TLS failure state from self-signed certificate prose", () => {
    expect(
      classifyModelFailure(new Error("self-signed certificate in certificate chain")),
    ).toMatchObject({
      reason: "unknown",
    });
  });
});

describe("classifyModelFailure provider business codes", () => {
  it("maps Start Plan concurrency failures to non-retryable rate limits", () => {
    for (const code of ["3008", "3009", "3010"]) {
      const failure = classifyModelFailure(
        new ProviderBusinessError({
          providerCode: code,
          providerId: "account:zai-start-plan",
          providerKind: "openai-compatible",
          providerMessage: "当前系统繁忙，请稍后再试或升级账户。",
          responseBodySummary: {
            code: Number(code),
            msg: "当前系统繁忙，请稍后再试或升级账户。",
          },
          responseStatus: 429,
          statusCode: 429,
        }),
      );

      expect(failure).toMatchObject({
        code: "model_rate_limited",
        message: "当前系统繁忙，请稍后再试或升级账户。",
        reason: "rate_limited",
        retryReason: "rate_limited",
        retryable: false,
        statusCode: 429,
      });
    }
  });

  it("maps upstream 2007 failures to retryable server errors", () => {
    const failure = classifyModelFailure(
      new ProviderBusinessError({
        providerCode: "2007",
        providerId: "account:zai-individual-coding-plan",
        providerKind: "openai-compatible",
        providerMessage: "upstream temporarily unavailable",
        responseBodySummary: {
          code: 2007,
          msg: "upstream temporarily unavailable",
        },
        responseStatus: 500,
        statusCode: 500,
      }),
    );

    expect(failure).toMatchObject({
      code: "model_request_failed",
      message: "upstream temporarily unavailable",
      reason: "server_error",
      retryReason: "server_error",
      retryable: true,
      statusCode: 500,
    });
  });

  it("maps HTTP 200 provider 1302 business rate limits to retryable rate limits", () => {
    const failure = classifyModelFailure(
      new ProviderBusinessError({
        providerCode: "1302",
        providerId: "account:bigmodel-individual-coding-plan",
        providerKind: "anthropic",
        providerMessage:
          "[1302][您的账户已达到速率限制，请您控制请求频率][20260605191846d4c0880887ed4c8d]",
        providerRequestId: "20260605191846d4c0880887ed4c8d",
        responseBodySummary: {
          error: {
            code: "1302",
            message:
              "[1302][您的账户已达到速率限制，请您控制请求频率][20260605191846d4c0880887ed4c8d]",
            type: "rate_limit_error",
          },
          request_id: "20260605191846d4c0880887ed4c8d",
          type: "error",
        },
        responseStatus: 200,
      }),
    );

    expect(failure).toMatchObject({
      code: "model_rate_limited",
      message: "[1302][您的账户已达到速率限制，请您控制请求频率][20260605191846d4c0880887ed4c8d]",
      reason: "rate_limited",
      retryReason: "rate_limited",
      retryable: true,
      statusCode: undefined,
    });
  });

  it("uses retry-after headers from provider business errors", () => {
    const failure = classifyModelFailure(
      new ProviderBusinessError({
        providerCode: "1305",
        providerId: "account:bigmodel-individual-coding-plan",
        providerKind: "anthropic",
        providerMessage: "平台流量限制，请稍后重试",
        responseHeaders: {
          "retry-after": "41",
        },
        responseStatus: 529,
        statusCode: 529,
      }),
    );

    expect(failure).toMatchObject({
      code: "model_rate_limited",
      reason: "rate_limited",
      retryAfterMs: 41_000,
      retryReason: "rate_limited",
      retryable: true,
      statusCode: 529,
    });
  });

  it("preserves retry-after headers from provider business error chunks", () => {
    const error = detectProviderBusinessFinishError({
      providerId: "account:bigmodel-individual-coding-plan",
      providerKind: "anthropic",
      source: {
        type: "error",
        error: new ProviderBusinessError({
          providerCode: "1305",
          providerId: "account:bigmodel-individual-coding-plan",
          providerKind: "anthropic",
          providerMessage: "平台流量限制，请稍后重试",
          responseHeaders: {
            "retry-after": "37",
            "x-should-retry": "true",
          },
          responseStatus: 529,
          statusCode: 529,
        }),
      },
    });

    expect(error).toMatchObject({
      providerCode: "1305",
      responseHeaders: {
        "retry-after": "37",
        "x-should-retry": "true",
      },
    });
    expect(classifyModelFailure(error)).toMatchObject({
      code: "model_rate_limited",
      reason: "rate_limited",
      retryAfterMs: 37_000,
      retryable: true,
      statusCode: 529,
    });
  });

  it("shows an OpenCode sign-in error without treating authentication as a provider switch", () => {
    const failure = classifyModelFailure(
      new ProviderBusinessError({
        providerCode: "AUTH_REQUIRED",
        providerId: "opencode",
        providerKind: "opencode-sdk",
        providerMessage: "OpenCode authentication is required",
        statusCode: 401,
      }),
    );

    expect(failure).toMatchObject({
      code: "provider_not_configured",
      message:
        "OpenCode sign-in is required. Sign in with the OpenCode CLI; ZCode does not read or copy those credentials.",
      reason: "auth_failed",
      retryable: false,
      statusCode: 401,
    });
  });

  it("classifies an OpenCode free-usage sentence inside the empty-response wrapper as terminal", () => {
    const failure = classifyModelFailure(
      new APICallError({
        message: openCodeEmptyResponseMessage(
          "opencode/deepseek-v4.1-flash-free",
          "Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go",
        ),
        url: "opencode://session",
        requestBodyValues: {},
        isRetryable: false,
        data: {
          errorType: "EmptyResponseData",
          modelId: "opencode/deepseek-v4.1-flash-free",
        },
      }),
    );

    expect(failure).toMatchObject({
      code: "OPENCODE_FREE_LIMIT_REACHED",
      message:
        "OpenCode free usage limit reached. Resets in about 4 hours, or switch to another model.",
      reason: "rate_limited",
      retryable: false,
    });
  });

  it("classifies an OpenCode empty response caused by fetch failed as a retryable network error", () => {
    const failure = classifyModelFailure(
      new APICallError({
        message: openCodeEmptyResponseMessage("opencode/deepseek-v4.1-flash-free", "fetch failed"),
        url: "opencode://session",
        requestBodyValues: {},
        isRetryable: false,
        data: {
          errorType: "EmptyResponseData",
          modelId: "opencode/deepseek-v4.1-flash-free",
        },
      }),
    );

    expect(failure).toMatchObject({
      code: "model_request_failed",
      reason: "network_error",
      retryReason: "network_error",
      retryable: true,
    });
  });

  it("keeps an OpenCode empty response without a fetch failure non-retryable", () => {
    const error = new APICallError({
      message: openCodeEmptyResponseMessage(
        "opencode/deepseek-v4.1-flash-free",
        "Unexpected server error. Check server logs for details.",
      ),
      url: "opencode://session",
      requestBodyValues: {},
      isRetryable: false,
      data: {
        errorType: "EmptyResponseData",
        modelId: "opencode/deepseek-v4.1-flash-free",
      },
    });
    const failure = classifyModelFailure(error);

    expect(failure).toMatchObject({
      reason: "unknown",
      retryable: false,
      message:
        "OpenCode's local server failed while processing the request. Check the OpenCode CLI logs; the model ID has not been identified as the cause.",
    });
    expect(failure.reason).not.toBe("network_error");
  });

  it("keeps the local OpenCode HTTP status while treating a 500 as an upstream server failure", () => {
    const failure = classifyModelFailure(
      new APICallError({
        message: openCodeEmptyResponseMessage(
          "opencode/deepseek-v4.1-flash-free",
          "Unexpected server error. Check server logs for details.",
        ),
        url: "opencode://session",
        requestBodyValues: {},
        statusCode: 500,
        isRetryable: false,
        data: {
          errorType: "EmptyResponseData",
          modelId: "opencode/deepseek-v4.1-flash-free",
        },
      }),
    );

    expect(failure).toMatchObject({
      statusCode: 500,
      reason: "unknown",
      retryable: false,
      message:
        "OpenCode's local server failed while processing the request. Check the OpenCode CLI logs; the model ID has not been identified as the cause.",
    });
  });

  it("classifies a bare undici TypeError fetch failed as a retryable network error", () => {
    expect(classifyModelFailure(new TypeError("fetch failed"))).toMatchObject({
      code: "model_request_failed",
      reason: "network_error",
      retryReason: "network_error",
      retryable: true,
    });
  });

  it("does not treat an HTTP 429 as a fetch failure when the message mentions fetch failed", () => {
    const failure = classifyModelFailure(
      new APICallError({
        message: "Provider rate limited the model request. Original error: fetch failed",
        url: "opencode://session",
        requestBodyValues: {},
        isRetryable: false,
        statusCode: 429,
      }),
    );

    expect(failure).toMatchObject({
      code: "model_rate_limited",
      reason: "rate_limited",
      retryable: true,
      statusCode: 429,
    });
  });

  it("preserves OpenCode provider attribution when rebuilding a business finish error", () => {
    const error = detectProviderBusinessFinishError({
      providerId: "opencode",
      providerKind: "opencode-sdk",
      source: {
        type: "finish",
        rawFinishReason: "provider_success_false",
        providerCode: "AUTH_REQUIRED",
        message: "OpenCode authentication is required",
      },
    });

    expect(error).toBeInstanceOf(ProviderBusinessError);
    expect(error).toMatchObject({
      providerId: "opencode",
      providerKind: "opencode-sdk",
      providerCode: "AUTH_REQUIRED",
    });
  });

  it("uses retry-after headers from ProviderBusinessError wrapped in APICallError cause", () => {
    const failure = classifyModelFailure(
      new APICallError({
        message: "Cannot connect to API: 平台流量限制，请稍后重试",
        cause: new ProviderBusinessError({
          providerCode: "1305",
          providerId: "account:bigmodel-individual-coding-plan",
          providerKind: "anthropic",
          providerMessage: "平台流量限制，请稍后重试",
          responseHeaders: {
            "retry-after": "37",
          },
          responseStatus: 529,
          statusCode: 529,
        }),
        isRetryable: true,
      }),
    );

    expect(failure).toMatchObject({
      code: "model_rate_limited",
      message: "平台流量限制，请稍后重试",
      reason: "rate_limited",
      retryAfterMs: 37_000,
      retryable: true,
      statusCode: 529,
    });
  });

  it("ignores retry-after when provider marks x-should-retry false", () => {
    const failure = classifyModelFailure(
      new ProviderBusinessError({
        providerCode: "1305",
        providerId: "account:bigmodel-individual-coding-plan",
        providerKind: "anthropic",
        providerMessage: "平台流量限制，请稍后重试",
        responseHeaders: {
          "retry-after": "41",
          "retry-after-ms": "41000",
          "x-should-retry": "false",
        },
        responseStatus: 529,
        statusCode: 529,
      }),
    );

    expect(failure).toMatchObject({
      code: "model_rate_limited",
      reason: "rate_limited",
      retryAfterMs: undefined,
      retryable: true,
      statusCode: 529,
    });
  });

  it("detects BigModel bracketed business codes from message-only SSE errors", () => {
    const error = detectProviderBusinessFinishError({
      providerId: "account:zai-individual-coding-plan",
      providerKind: "anthropic",
      source: {
        type: "error",
        error: new Error("[1302][Rate limit reached for requests][20260608211523b786be6a48924736]"),
      },
    });

    expect(error).toMatchObject({
      providerCode: "1302",
      providerMessage: "[1302][Rate limit reached for requests][20260608211523b786be6a48924736]",
    });
    expect(classifyModelFailure(error)).toMatchObject({
      code: "model_rate_limited",
      message: "[1302][Rate limit reached for requests][20260608211523b786be6a48924736]",
      reason: "rate_limited",
      retryReason: "rate_limited",
      retryable: true,
    });
  });

  it("maps BigModel transient business codes to retryable failures", () => {
    const cases = [
      {
        code: "500",
        expectedCode: "model_request_failed",
        message: "内部错误，请稍后重试",
        reason: "server_error",
        retryReason: "server_error",
      },
      {
        code: "1120",
        expectedCode: "model_request_failed",
        message: "当前账号暂时无法访问，请稍后重试",
        reason: "server_error",
        retryReason: "server_error",
      },
      {
        code: "1230",
        expectedCode: "model_request_failed",
        message: "API 调用流程异常，请稍后重试",
        reason: "server_error",
        retryReason: "server_error",
      },
      {
        code: "1234",
        expectedCode: "model_request_failed",
        message: "网络错误，请稍后重试",
        reason: "network_error",
        retryReason: "network_error",
      },
      {
        code: "1303",
        expectedCode: "model_rate_limited",
        message: "当前调用频率过高，请稍后重试",
        reason: "rate_limited",
        retryReason: "rate_limited",
      },
      {
        code: "1305",
        expectedCode: "model_rate_limited",
        message: "平台流量限制，请稍后重试",
        reason: "rate_limited",
        retryReason: "rate_limited",
      },
      {
        code: "1312",
        expectedCode: "model_request_failed",
        message: "模型访问负载过高，请稍后重试",
        reason: "provider_overloaded",
        retryReason: "provider_overloaded",
      },
    ];

    for (const item of cases) {
      const failure = classifyModelFailure(
        providerBusinessError({
          providerCode: item.code,
          providerMessage: `[${item.code}]${item.message}`,
        }),
      );

      expect(failure).toMatchObject({
        code: item.expectedCode,
        message: `[${item.code}]${item.message}`,
        reason: item.reason,
        retryReason: item.retryReason,
        retryable: true,
        statusCode: undefined,
      });
    }
  });

  it("maps BigModel 1261 prompt-too-long business code to context exceeded", () => {
    const failure = classifyModelFailure(
      providerBusinessError({
        providerCode: "1261",
        providerMessage: "Prompt 超长",
        responseStatus: 400,
        statusCode: 400,
      }),
    );

    expect(failure).toMatchObject({
      code: "model_context_exceeded",
      message: "Prompt 超长",
      reason: "context_exceeded",
      retryReason: "network_error",
      retryable: false,
      statusCode: 400,
    });
  });

  it("keeps BigModel quota, entitlement, and terminal business codes non-retryable", () => {
    const terminalCodes = ["1113", "1304", "1308", "1309", "1310", "1311", "1313"];

    for (const code of terminalCodes) {
      const failure = classifyModelFailure(
        providerBusinessError({
          providerCode: code,
          providerMessage: `[${code}] quota or entitlement terminal error`,
        }),
      );

      expect(failure).toMatchObject({
        retryable: false,
        statusCode: undefined,
      });
    }
  });

  it("does not retry HTTP 429 BigModel 1113 business code", () => {
    const failure = classifyModelFailure(
      new ProviderBusinessError({
        providerCode: "1113",
        providerId: "account:bigmodel-individual-coding-plan",
        providerKind: "anthropic",
        providerMessage: "[1113] provider terminal business error",
        responseHeaders: {
          "retry-after": "37",
          "x-should-retry": "true",
        },
        responseStatus: 429,
        statusCode: 429,
      }),
    );

    expect(failure).toMatchObject({
      code: "model_request_failed",
      reason: "unknown",
      retryable: false,
      statusCode: 429,
    });
  });

  it("does not retry HTTP 429 BigModel quota reset business codes", () => {
    const failure = classifyModelFailure(
      providerBusinessError({
        providerCode: "1308",
        providerMessage: "[1308] 已达使用上限，请等待重置时间后再试",
        responseStatus: 429,
        statusCode: 429,
      }),
    );

    expect(failure).toMatchObject({
      code: "model_rate_limited",
      reason: "rate_limited",
      retryReason: "rate_limited",
      retryable: false,
      statusCode: 429,
    });
  });

  it.each([
    { expectedRetryAfterMs: undefined, name: "missing", responseHeaders: undefined },
    {
      expectedRetryAfterMs: 30_000,
      name: "short",
      responseHeaders: { "retry-after": "30" },
    },
    {
      expectedRetryAfterMs: 16_097_000,
      name: "long",
      responseHeaders: { "retry-after": "16097" },
    },
    {
      expectedRetryAfterMs: undefined,
      name: "blocked by x-should-retry",
      responseHeaders: { "retry-after": "16097", "x-should-retry": "false" },
    },
  ])(
    "does not retry insufficient quota when retry-after is $name",
    ({ expectedRetryAfterMs, responseHeaders }) => {
      const message =
        "Your token-plan 5-hour quota has been exhausted. The quota will reset later.";
      const failure = classifyModelFailure(
        new ProviderBusinessError({
          providerCode: "insufficient_quota",
          providerId: "custom:token-plan",
          providerKind: "openai-compatible",
          providerMessage: message,
          responseHeaders,
          responseStatus: 429,
          statusCode: 429,
        }),
      );

      expect(failure).toMatchObject({
        code: "model_rate_limited",
        message,
        reason: "rate_limited",
        retryAfterMs: expectedRetryAfterMs,
        retryReason: "rate_limited",
        retryable: false,
        statusCode: 429,
      });
    },
  );

  it.each([
    "credit_balance_exhausted",
    "organization_spend_limit_exceeded",
    "project_spend_limit_exceeded",
    "organization_usage_limit_exceeded",
    "exceeded_current_quota_error",
    "1008",
    "2056",
    "20097",
    "1314",
    "1315",
    "1316",
    "1317",
    "1318",
    "1319",
    "1320",
    "1321",
  ])("does not retry official terminal quota or billing code %s", (providerCode) => {
    const failure = classifyModelFailure(
      new ProviderBusinessError({
        providerCode,
        providerId: "custom:provider",
        providerKind: "openai-compatible",
        providerMessage: `Provider returned terminal code ${providerCode}.`,
        responseStatus: 429,
        statusCode: 429,
      }),
    );

    expect(failure).toMatchObject({
      retryable: false,
      statusCode: 429,
    });
  });

  it.each([
    ["rate_limit_reached_error", "rate_limited"],
    ["rate_limit_error", "rate_limited"],
  ])("retries official transient provider code %s", (providerCode, reason) => {
    const failure = classifyModelFailure(
      new ProviderBusinessError({
        providerCode,
        providerId: "custom:provider",
        providerKind: "openai-compatible",
        providerMessage: `Provider returned transient code ${providerCode}.`,
        responseStatus: 200,
      }),
    );

    expect(failure).toMatchObject({
      reason,
      retryable: true,
    });
  });

  it.each(["engine_overloaded_error", "overloaded_error"])(
    "maps overload code %s to a retryable request failure",
    (providerCode) => {
      const failure = classifyModelFailure(
        new ProviderBusinessError({
          providerCode,
          providerId: "custom:provider",
          providerKind: "openai-compatible",
          providerMessage: `Provider returned overload code ${providerCode}.`,
          responseStatus: 200,
        }),
      );

      expect(failure).toMatchObject({
        code: "model_request_failed",
        reason: "provider_overloaded",
        retryable: true,
      });
    },
  );

  it("classifies Kimi error.type from AI SDK parsed error data", () => {
    const message = "Your account balance is insufficient.";
    const failure = classifyModelFailure(
      new APICallError({
        data: {
          error: {
            message,
            type: "exceeded_current_quota_error",
          },
        },
        message,
        requestBodyValues: {},
        statusCode: 429,
        url: "https://api.moonshot.cn/v1/chat/completions",
      }),
    );

    expect(failure).toMatchObject({
      code: "model_rate_limited",
      message,
      reason: "rate_limited",
      retryable: false,
      statusCode: 429,
    });
  });

  it("prefers AI SDK parsed error.code over the broader OpenAI error.type", () => {
    const message = "Your organization has no prepaid credits remaining.";
    const error = new APICallError({
      data: {
        error: {
          code: "credit_balance_exhausted",
          message,
          type: "insufficient_quota",
        },
        request_id: "req_credit_exhausted",
      },
      message,
      requestBodyValues: {},
      statusCode: 429,
      url: "https://api.openai.com/v1/responses",
    });
    const failure = classifyModelFailure(error);

    expect(failure).toMatchObject({
      code: "model_rate_limited",
      message,
      reason: "rate_limited",
      retryable: false,
      statusCode: 429,
    });
    expect(inspectProviderFailure(error)).toEqual({
      providerErrorCode: "credit_balance_exhausted",
      providerErrorMessage: message,
      providerRequestId: "req_credit_exhausted",
    });
  });

  it("leaves unmapped AI SDK error data to the existing generic retry classifier", () => {
    const message = "Provider reported a custom transient failure.";
    const failure = classifyModelFailure(
      new APICallError({
        data: {
          error: {
            message,
            type: "custom_transient_error",
          },
        },
        isRetryable: true,
        message,
      }),
    );

    expect(failure).toMatchObject({
      code: "model_request_failed",
      reason: "server_error",
      retryable: true,
      statusCode: undefined,
    });
  });

  it("retries provider business HTTP 429 when no terminal business code is present", () => {
    const failure = classifyModelFailure(
      new ProviderBusinessError({
        providerId: "account:bigmodel-individual-coding-plan",
        providerKind: "openai-compatible",
        providerMessage: "Provider throttled the request.",
        responseStatus: 429,
        statusCode: 429,
      }),
    );

    expect(failure).toMatchObject({
      code: "model_rate_limited",
      message: "Provider throttled the request.",
      reason: "rate_limited",
      retryReason: "rate_limited",
      retryable: true,
      statusCode: 429,
    });
  });

  it("retries nested BigModel 1234 errors hidden behind ProviderBusinessError wrapper code", () => {
    const failure = classifyModelFailure(
      new ProviderBusinessError({
        providerCode: "PROVIDER_BUSINESS_ERROR",
        providerId: "account:bigmodel-individual-coding-plan",
        providerKind: "openai-compatible",
        providerMessage: "网络错误，错误id：202606101326108f72c6d20f7b40d9，请稍后重试",
        responseBodySummary: {
          error: {
            code: "PROVIDER_BUSINESS_ERROR",
            isProviderBusinessError: true,
            name: "ProviderBusinessError",
            providerCode: "1234",
            providerMessage: "网络错误，错误id：202606101326108f72c6d20f7b40d9，请稍后重试",
            responseBodySummary: {
              error: {
                code: "1234",
                message: "网络错误，错误id：202606101326108f72c6d20f7b40d9，请稍后重试",
              },
            },
            responseStatus: 500,
          },
          type: "error",
        },
        responseStatus: 500,
      }),
    );

    expect(failure).toMatchObject({
      code: "model_request_failed",
      message: "网络错误，错误id：202606101326108f72c6d20f7b40d9，请稍后重试",
      reason: "network_error",
      retryReason: "network_error",
      retryable: true,
      statusCode: 500,
    });
  });

  it("retries provider business HTTP 5xx even without a provider business code", () => {
    const failure = classifyModelFailure(
      new ProviderBusinessError({
        providerId: "account:bigmodel-individual-coding-plan",
        providerKind: "openai-compatible",
        providerMessage: "Provider returned an internal error.",
        responseStatus: 500,
      }),
    );

    expect(failure).toMatchObject({
      code: "model_request_failed",
      message: "Provider returned an internal error.",
      reason: "server_error",
      retryReason: "server_error",
      retryable: true,
      statusCode: 500,
    });
  });

  it("maps HTTP 200 provider api_error internal network failures to retryable network errors", () => {
    const failure = classifyModelFailure(
      new ProviderBusinessError({
        providerId: "account:bigmodel-individual-coding-plan",
        providerKind: "anthropic",
        providerMessage: "Internal Network Failure",
        providerRequestId: "20260605180401a5d2482ebda148a5",
        responseBodySummary: {
          error: {
            message: "Internal Network Failure",
            type: "api_error",
          },
          request_id: "20260605180401a5d2482ebda148a5",
          type: "error",
        },
        responseStatus: 200,
      }),
    );

    expect(failure).toMatchObject({
      code: "model_request_failed",
      message: "Internal Network Failure",
      reason: "network_error",
      retryReason: "network_error",
      retryable: true,
      statusCode: undefined,
    });
  });

  it("maps provider business transport codes to retryable network errors", () => {
    const failure = classifyModelFailure(
      new ProviderBusinessError({
        providerCode: "ECONNRESET",
        providerId: "account:zai-individual-coding-plan",
        providerKind: "openai-compatible",
        providerMessage: "Cannot connect to API: socket hang up",
        responseBodySummary: {
          error: {
            cause: { code: "ECONNRESET" },
            message: "Cannot connect to API: socket hang up",
            name: "AI_APICallError",
          },
          type: "error",
        },
      }),
    );

    expect(failure).toMatchObject({
      code: "model_request_failed",
      message: "Cannot connect to API: socket hang up",
      reason: "network_error",
      retryReason: "network_error",
      retryable: true,
    });
  });

  it("maps provider business transport timeouts to retryable timeout failures", () => {
    const cases = [
      {
        providerCode: "UND_ERR_HEADERS_TIMEOUT",
        providerMessage: "Cannot connect to API: Headers Timeout Error",
      },
      {
        providerCode: "UND_ERR_BODY_TIMEOUT",
        providerMessage: "Cannot connect to API: Body Timeout Error",
      },
      {
        providerCode: "ETIMEDOUT",
        providerMessage: "Cannot connect to API: request timed out",
      },
    ];

    for (const item of cases) {
      const failure = classifyModelFailure(
        new ProviderBusinessError({
          providerCode: item.providerCode,
          providerId: "account:zai-individual-coding-plan",
          providerKind: "openai-compatible",
          providerMessage: item.providerMessage,
          responseBodySummary: {
            error: {
              cause: { code: item.providerCode },
              message: item.providerMessage,
              name: "AI_APICallError",
            },
            type: "error",
          },
        }),
      );

      expect(failure).toMatchObject({
        code: "model_request_timeout",
        message: item.providerMessage,
        reason: "timeout",
        retryReason: "timeout",
        retryable: true,
      });
    }
  });

  it("maps provider business HTTP 408 failures to retryable timeout failures", () => {
    const failure = classifyModelFailure(
      new ProviderBusinessError({
        providerId: "account:zai-individual-coding-plan",
        providerKind: "openai-compatible",
        providerMessage: "Provider gateway timed out before response headers.",
        responseStatus: 408,
        statusCode: 408,
      }),
    );

    expect(failure).toMatchObject({
      code: "model_request_timeout",
      message: "Provider gateway timed out before response headers.",
      reason: "timeout",
      retryReason: "timeout",
      retryable: true,
      statusCode: 408,
    });
  });
});

describe("classifyModelFailure root run budget exhaustion", () => {
  it.each([
    ["resource", "Root run resource budget is exhausted: session_1:turn_1"],
    ["token", "Root run token budget exhausted"],
    ["time", "Root run time budget exhausted"],
  ])("maps the %s budget message to run_budget_exhausted", (_dimension, message) => {
    expect(classifyModelFailure(new Error(message))).toMatchObject({
      code: "model_request_failed",
      message,
      reason: "run_budget_exhausted",
      retryable: false,
    });
  });

  it("keeps the budget reason instead of cancelled when the run is already aborted", () => {
    const controller = new AbortController();
    controller.abort();

    expect(
      classifyModelFailure(new Error("Root run time budget exhausted"), controller.signal),
    ).toMatchObject({
      reason: "run_budget_exhausted",
      retryable: false,
    });
  });

  it("reads the budget message from the error cause", () => {
    const error = new Error("Turn execution failed", {
      cause: new Error("Root run token budget exhausted"),
    });

    expect(classifyModelFailure(error)).toMatchObject({
      reason: "run_budget_exhausted",
      retryable: false,
    });
  });

  it("does not classify ordinary text or non-Error values as budget exhaustion", () => {
    expect(classifyModelFailure(new Error("Model request failed.")).reason).toBe("unknown");
    expect(classifyModelFailure(undefined).reason).toBe("unknown");
    expect(classifyModelFailure(null).reason).toBe("unknown");
  });
});

function providerBusinessError(input: {
  providerCode: string;
  providerMessage: string;
  responseStatus?: number;
  statusCode?: number;
}): ProviderBusinessError {
  return new ProviderBusinessError({
    providerCode: input.providerCode,
    providerId: "account:bigmodel-individual-coding-plan",
    providerKind: "anthropic",
    providerMessage: input.providerMessage,
    responseBodySummary: {
      error: {
        code: input.providerCode,
        message: input.providerMessage,
      },
      type: "error",
    },
    responseStatus: input.responseStatus ?? 200,
    statusCode: input.statusCode,
  });
}
