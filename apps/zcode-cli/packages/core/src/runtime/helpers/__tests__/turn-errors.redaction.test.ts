import { describe, expect, it, vi } from "vitest";
import { CoreErrorType } from "@zcode/contracts";
import {
  appendTurnOutcomeEvent,
  createTurnErrorLogView,
  createTurnFailureError,
  projectExecutionErrorPayload,
  TURN_ERROR_LOG_MAX_BYTES,
} from "../turn-errors.js";

// R06: до исправления `turn.failed` писал в JSONL сам coreError, и его cause-цепочка
// содержала provider responseBodySummary с полным request body (prompt/messages/tools).
// Тест фиксирует ограниченную проекцию: cause-кадры остаются, payload — нет.

const PROMPT_MARKER = "PROMPT_BODY_MUST_NOT_BE_LOGGED";
const SECRET_MARKER = "sk-live-secret-must-not-be-logged";

function hugeProviderBody(): Record<string, unknown> {
  return {
    input: { prompt: PROMPT_MARKER },
    messages: Array.from({ length: 670 }, () => ({ role: "user", content: PROMPT_MARKER })),
    tools: Array.from({ length: 18 }, (_, index) => ({
      name: `tool-${index}`,
      schema: PROMPT_MARKER,
    })),
    headers: { authorization: `Bearer ${SECRET_MARKER}` },
  };
}

function providerCausedModelError(): Error {
  const body = hugeProviderBody();
  const inner = Object.assign(new Error("Provider business failure"), {
    isProviderBusinessError: true,
    name: "ProviderBusinessError",
    providerCode: "3007",
    responseBodySummary: body,
    responseHeaders: { authorization: `Bearer ${SECRET_MARKER}` },
    statusCode: 403,
  });
  return Object.assign(new Error("Model request failed"), {
    cause: inner,
    code: "MODEL_REQUEST_FAILED",
    context: {
      providerCode: "3007",
      providerId: "account:zai-individual-coding-plan",
      reason: "provider_business",
      responseBodySummary: body,
      responseHeaders: { authorization: `Bearer ${SECRET_MARKER}` },
      source: "provider",
      statusCode: 403,
    },
    name: "AiSdkModelAdapterError",
  });
}

interface CapturedLog {
  message: string;
  error?: Error;
  context?: Record<string, unknown>;
}

function capturingRuntime(captured: CapturedLog[]): unknown {
  return {
    createEvent: (type: string, payload: unknown) => ({ type, payload }),
    appendEvent: async () => undefined,
    logger: {
      debug: vi.fn(),
      error: vi.fn((message: string, error?: Error, context?: Record<string, unknown>) => {
        captured.push({ message, error, context });
      }),
      info: vi.fn(),
      warn: vi.fn(),
    },
  };
}

/** Повторяет форму записи adapters logging (`serializeLogError`) достаточно близко для лимита. */
function serializeLogLine(log: CapturedLog): string {
  type View = Error & {
    cause?: unknown;
    code?: string;
    context?: Record<string, unknown>;
    type?: string;
  };
  const describe = (error: View): Record<string, unknown> => ({
    name: error.name,
    message: error.message,
    ...(error.code ? { code: error.code } : {}),
    ...(error.type ? { type: error.type } : {}),
    ...(error.stack ? { stack: error.stack } : {}),
    ...(error.context ? { context: error.context } : {}),
    ...(error.cause ? { cause: describe(error.cause as View) } : {}),
  });
  return JSON.stringify({
    level: "error",
    message: log.message,
    context: log.context,
    error: log.error ? describe(log.error as View) : undefined,
  });
}

describe("turn error diagnostics redaction (R06)", () => {
  it("logs bounded frames instead of the provider request body", async () => {
    const captured: CapturedLog[] = [];
    const coreError = createTurnFailureError(
      providerCausedModelError(),
      undefined,
      "Turn execution failed",
    );

    await appendTurnOutcomeEvent(capturingRuntime(captured) as never, {
      coreError,
      events: [],
      durationMs: 1,
      turnPhase: "model",
      traceContext: { traceId: "trace-r06" } as never,
      fallbackMessage: "Turn execution failed",
      logEvent: "turn.failed",
      logLabel: "Turn",
    });

    expect(captured).toHaveLength(1);
    const log = captured[0]!;
    expect(log.message).toBe("Turn failed");
    expect(log.error).toBeDefined();
    expect(log.error).not.toBe(coreError);

    // Cause сохраняется для диагностики (docs/design/v2/logging.md), но только
    // как безопасный кадр из allowlist скаляров.
    const cause = (log.error as { cause?: { name: string; cause?: unknown } }).cause;
    expect(cause?.name).toBe("AiSdkModelAdapterError");
    const providerFrame = (
      cause as { cause?: { name: string; context?: Record<string, unknown> } }
    ).cause;
    expect(providerFrame?.name).toBe("ProviderBusinessError");
    expect(providerFrame?.context).toMatchObject({ providerCode: "3007", statusCode: 403 });
    expect(providerFrame?.context).not.toHaveProperty("responseBodySummary");
    expect(providerFrame?.context).not.toHaveProperty("responseHeaders");

    const line = serializeLogLine(log);
    expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(TURN_ERROR_LOG_MAX_BYTES);
    expect(line).not.toContain(PROMPT_MARKER);
    expect(line).not.toContain(SECRET_MARKER);
    expect(line).not.toContain("responseBodySummary");
  });

  it("keeps the original error identity and attribution for an ordinary failure", () => {
    const modelError = Object.assign(new Error("Network connection failed"), {
      code: "MODEL_REQUEST_FAILED",
      context: {
        modelId: "deepseek-v4-flash",
        providerId: "default-deepseek",
        reason: "network_error",
        source: "network",
        statusCode: 503,
      },
      name: "AiSdkModelAdapterError",
    });
    const coreError = createTurnFailureError(modelError, undefined, "Turn execution failed");

    const projection = projectExecutionErrorPayload(coreError);
    const logView = createTurnErrorLogView(coreError, projection);

    expect(logView.name).toBe(coreError.name);
    expect(logView.message).toBe(coreError.message);
    expect(logView.code).toBe(coreError.code);
    expect(logView.type).toBe(CoreErrorType.UnknownError);
    expect(logView.context).toMatchObject({
      message: projection.message,
      modelId: "deepseek-v4-flash",
      providerId: "default-deepseek",
      reason: "network_error",
      source: "network",
      statusCode: 503,
    });
    expect(logView.context).not.toHaveProperty("headers");
    expect(logView.context).not.toHaveProperty("responseBody");
    expect(JSON.stringify(logView)).not.toContain(SECRET_MARKER);
  });

  it("bounds a long multibyte cause chain without replacement characters", () => {
    const longValue = "😀".repeat(20_000);
    let cause: Error | undefined;
    for (let index = 0; index < 10; index += 1) {
      cause = Object.assign(new Error(longValue), {
        cause,
        code: `CODE_${index}`,
        context: { reason: longValue, providerId: longValue },
      });
    }
    const coreError = createTurnFailureError(cause, undefined, "Turn execution failed");

    const logView = createTurnErrorLogView(coreError, projectExecutionErrorPayload(coreError));
    const serialized = JSON.stringify(logView);

    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(TURN_ERROR_LOG_MAX_BYTES);
    expect(serialized).not.toContain("\uFFFD");
    // Хвост цепочки отброшен с явным маркером; бюджет строки соблюдён.
    expect(serialized).toContain("causeTruncated");
  });

  it("redacts a secret that straddles the truncation boundary", () => {
    // R06: порядок redact → truncate. TURN_ERROR_LOG_MESSAGE_MAX_BYTES = 1024 B, маркер
    // усечения занимает ~24 B, значит контент режется около 1000 B. Токен начинается на
    // 908 B, поэтому truncate-first оставил бы ~92 байта секрета ("Qz7Xk2Mp9Rt4Vw8Yb3Nc6…").
    // При redact-first весь `Bearer <token>` заменяется на `Bearer [redacted]` и помещается.
    const token = "Qz7Xk2Mp9Rt4Vw8Yb3Nc6Df1Gh5";
    const modelError = Object.assign(
      new Error(`${"a".repeat(900)} Bearer ${token} | ${"b".repeat(500)}`),
      {
        code: "MODEL_REQUEST_FAILED",
        context: { reason: "provider_business", source: "provider" },
        name: "AiSdkModelAdapterError",
      },
    );
    const coreError = createTurnFailureError(modelError, undefined, "Turn execution failed");

    const logView = createTurnErrorLogView(coreError, projectExecutionErrorPayload(coreError));
    const serialized = JSON.stringify(logView);
    const cause = logView.cause as { message?: string } | undefined;

    expect(cause?.message).toContain("Bearer [redacted]");
    expect(cause?.message).toContain("[truncated: ");
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("Qz7X");
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(TURN_ERROR_LOG_MAX_BYTES);
  });

  it("bounds identity fields so a pathological code/type cannot defeat the line budget", () => {
    // R06: name/code/type раньше копировались без границы и переживали hard fallback,
    // поэтому провайдерский `code` в килобайты сам выводил строку за 32 KiB.
    const huge = "k".repeat(10_000);
    const modelError = Object.assign(new Error("Model request failed"), {
      code: huge,
      context: { reason: "unknown", source: "provider" },
      name: huge,
      type: huge,
    });
    const coreError = createTurnFailureError(modelError, undefined, "Turn execution failed");

    const logView = createTurnErrorLogView(coreError, projectExecutionErrorPayload(coreError));
    const serialized = JSON.stringify(logView);
    const cause = logView.cause as
      | { code?: string; name?: string; type?: string }
      | undefined;

    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(TURN_ERROR_LOG_MAX_BYTES);
    expect(Buffer.byteLength(cause?.name ?? "", "utf8")).toBeLessThanOrEqual(128);
    expect(Buffer.byteLength(cause?.code ?? "", "utf8")).toBeLessThanOrEqual(128);
    expect(Buffer.byteLength(cause?.type ?? "", "utf8")).toBeLessThanOrEqual(128);
    expect(cause?.name).toContain("[truncated: ");
  });
});
