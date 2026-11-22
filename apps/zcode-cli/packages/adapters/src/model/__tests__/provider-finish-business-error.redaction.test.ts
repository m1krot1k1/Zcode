import { describe, expect, it } from "vitest";
import { LogLevel, type LogEntry } from "@zcode/contracts";
import {
  detectProviderBusinessFinishError,
  PROVIDER_BUSINESS_SUMMARY_MAX_BYTES,
  PROVIDER_ERROR_DIAGNOSTIC_MAX_BYTES,
} from "../provider-finish-business-error.js";
import { ProviderBusinessError } from "../model-execution.js";
import { DefaultLogRedactor, serializeLogError, toSerializableEntry } from "../../logging/serialize.js";

// R06: полный request body раньше попадал в responseBodySummary через
// candidates.find(hasBusinessSignal) и целиком уходил в JSONL/support bundle.
// Эти тесты фиксируют безопасную форму сводки и байтовый лимит строки.

const PROMPT_MARKER = "PROMPT_BODY_MUST_NOT_BE_LOGGED";
const TOOL_MARKER = "TOOL_SCHEMA_MUST_NOT_BE_LOGGED";
const SECRET_MARKER = "sk-live-secret-must-not-be-logged";

function finishChunk(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "finish",
    finishReason: "error",
    rawFinishReason: "provider_success_false",
    providerCode: "3007",
    providerMessage: "Security verification failed or the verify token was rejected.",
    request_id: "req-business-1",
    statusCode: 403,
    // Именно эти поля раздували строку до 1.46 MB в исследовании.
    input: { prompt: PROMPT_MARKER, messages: Array(670).fill(PROMPT_MARKER) },
    messages: [{ role: "user", content: PROMPT_MARKER }],
    tools: [{ name: TOOL_MARKER, parameters: { type: "object" } }],
    headers: { Authorization: `Bearer ${SECRET_MARKER}` },
    ...overrides,
  };
}

/**
 * Воспроизводит реальный путь утечки: `runner-retry.providerBusinessErrorContext`
 * копирует `responseBodySummary` в `AiSdkModelAdapterError.context`, а
 * `serializeLogError` пишет plain `context` без изменений в JSONL.
 */
function jsonlLine(error: unknown): string {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const providerSummary = record.responseBodySummary as Record<string, unknown> | undefined;
  const logError = Object.assign(new Error("Model request failed"), {
    cause: error,
    context: {
      ...(record.providerCode !== undefined ? { providerCode: record.providerCode } : {}),
      ...(providerSummary ? { responseBodySummary: providerSummary } : {}),
    },
    name: "AiSdkModelAdapterError",
  });
  const entry: LogEntry = {
    timestamp: new Date(0),
    level: LogLevel.Error,
    levelName: "ERROR",
    event: "turn.failed",
    module: "core.runtime",
    message: "Turn failed",
    context: { status: "failed" },
    error: serializeLogError(logError, false),
  };
  return JSON.stringify(toSerializableEntry(entry, new DefaultLogRedactor()));
}

describe("provider finish business error diagnostics (R06)", () => {
  it("keeps only safe metadata and never copies the request body", () => {
    const error = detectProviderBusinessFinishError({
      providerId: "account:zai-individual-coding-plan",
      providerKind: "openai-compatible",
      source: finishChunk(),
    });

    expect(error).toBeInstanceOf(ProviderBusinessError);
    const summary = error?.responseBodySummary;
    expect(summary).toBeDefined();

    const serializedSummary = JSON.stringify(summary);
    expect(serializedSummary).not.toContain(PROMPT_MARKER);
    expect(serializedSummary).not.toContain(TOOL_MARKER);
    expect(serializedSummary).not.toContain(SECRET_MARKER);
    expect(serializedSummary).not.toContain('"input"');
    expect(serializedSummary).not.toContain('"tools"');

    // Диагностически значимые поля сохранены.
    expect(summary).toMatchObject({
      providerCode: "3007",
      request_id: "req-business-1",
      statusCode: 403,
    });
    expect(summary?.keys).toEqual(expect.arrayContaining(["providerCode", "request_id"]));
    expect(summary?.keys).not.toEqual(expect.arrayContaining(["input", "messages", "tools"]));
    // Исходный размер тела доступен как метаданные, но само тело не пишется.
    expect(summary?.sourceBytes).toBe(Buffer.byteLength(JSON.stringify(finishChunk()), "utf8"));

    // Строка JSONL, которую пишет adapters logging, остаётся в бюджете.
    const line = jsonlLine(error);
    expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(
      PROVIDER_ERROR_DIAGNOSTIC_MAX_BYTES,
    );
    expect(line).not.toContain(PROMPT_MARKER);
  });

  it("truncates an oversized multibyte message deterministically with the original byte size", () => {
    const original = "😀".repeat(20_000);
    const originalBytes = Buffer.byteLength(original, "utf8");
    const source = {
      type: "finish",
      rawFinishReason: "provider_success_false",
      providerCode: "1302",
      providerMessage: original,
    };

    const error = detectProviderBusinessFinishError({
      providerId: "account:zai-individual-coding-plan",
      providerKind: "openai-compatible",
      source,
    });

    const summary = error?.responseBodySummary;
    const serializedSummary = JSON.stringify(summary);
    expect(Buffer.byteLength(serializedSummary, "utf8")).toBeLessThanOrEqual(
      PROVIDER_BUSINESS_SUMMARY_MAX_BYTES,
    );
    expect(summary?.providerMessage).toContain(`[truncated: ${originalBytes} bytes]`);
    // Многобайтный символ не разрезан: replacement-символа нет.
    expect(serializedSummary).not.toContain("\uFFFD");
    // sourceBytes показывает исходный размер всего тела.
    expect(summary?.sourceBytes).toBeGreaterThan(originalBytes);

    const line = jsonlLine(error);
    expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(
      PROVIDER_ERROR_DIAGNOSTIC_MAX_BYTES,
    );

    // Детерминированность: тот же вход даёт тот же результат.
    const repeated = detectProviderBusinessFinishError({
      providerId: "account:zai-individual-coding-plan",
      providerKind: "openai-compatible",
      source,
    });
    expect(JSON.stringify(repeated?.responseBodySummary)).toBe(serializedSummary);
  });

  it("leaves an ordinary business error unchanged", () => {
    const error = detectProviderBusinessFinishError({
      providerId: "zai",
      providerKind: "openai-compatible",
      source: {
        type: "finish",
        providerCode: 500,
        providerMessage: "操作失败",
        success: false,
        code: 500,
        msg: "操作失败",
      },
    });

    expect(error).toMatchObject({
      providerCode: "500",
      providerMessage: "操作失败",
    });
    expect(error?.responseBodySummary).toMatchObject({
      code: 500,
      msg: "操作失败",
      success: false,
    });
    expect(error?.responseBodySummary).not.toHaveProperty("summaryTruncated");
    expect(JSON.stringify(error?.responseBodySummary)).not.toContain("[truncated");
  });

  it("redacts authorization values but preserves retry headers", () => {
    const wrapped = detectProviderBusinessFinishError({
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
            authorization: `Bearer ${SECRET_MARKER}`,
            "retry-after": "37",
            "x-should-retry": "true",
          },
          responseStatus: 529,
          statusCode: 529,
        }),
      },
    });

    expect(wrapped?.responseHeaders).toMatchObject({
      authorization: "[redacted]",
      "retry-after": "37",
      "x-should-retry": "true",
    });
    expect(JSON.stringify(wrapped)).not.toContain(SECRET_MARKER);
    expect(jsonlLine(wrapped)).not.toContain(SECRET_MARKER);
  });

  it("does not copy nested error payloads or header objects into the summary", () => {
    const error = detectProviderBusinessFinishError({
      providerId: "zai",
      providerKind: "openai-compatible",
      source: {
        type: "error",
        providerCode: "1006",
        error: {
          code: "1006",
          message: "token expired",
          headers: { authorization: `Bearer ${SECRET_MARKER}` },
          data: { input: PROMPT_MARKER },
        },
      },
    });

    const serializedSummary = JSON.stringify(error?.responseBodySummary);
    expect(serializedSummary).not.toContain(SECRET_MARKER);
    expect(serializedSummary).not.toContain(PROMPT_MARKER);
    expect(error?.responseBodySummary).toMatchObject({
      error: { code: "1006", message: "token expired" },
    });
  });

  it("keeps the classifier inputs (nested code/message/type/cause code) intact", () => {
    const error = detectProviderBusinessFinishError({
      providerId: "zai",
      providerKind: "openai-compatible",
      source: {
        type: "error",
        providerCode: "ECONNRESET",
        error: {
          cause: { code: "ECONNRESET" },
          message: "Cannot connect to API: socket hang up",
          name: "AI_APICallError",
        },
      },
    });

    expect(error?.responseBodySummary).toMatchObject({
      providerCode: "ECONNRESET",
      error: {
        cause: { code: "ECONNRESET" },
        message: "Cannot connect to API: socket hang up",
      },
    });
  });

  it("redacts a secret that straddles the truncation boundary", () => {
    // R06: порядок redact → truncate. SUMMARY_STRING_MAX_BYTES = 512 B; маркер усечения
    // занимает ~23 B, значит контент режется около 489 B. Токен начинается на 468 B,
    // поэтому truncate-first оставил бы в значении ~21 байт секрета ("Qz7Xk2Mp9Rt4Vw8Yb3Nc6"),
    // а redact-first заменяет весь `Bearer <token>` на `Bearer [redacted]`.
    const token = "Qz7Xk2Mp9Rt4Vw8Yb3Nc6Df1Gh5";
    const error = detectProviderBusinessFinishError({
      providerId: "account:zai-individual-coding-plan",
      providerKind: "openai-compatible",
      source: {
        type: "finish",
        rawFinishReason: "provider_success_false",
        providerCode: "3007",
        providerMessage: `${"a".repeat(460)} Bearer ${token} | ${"b".repeat(100)}`,
      },
    });

    const summary = error?.responseBodySummary;
    const message = summary?.providerMessage;
    expect(typeof message).toBe("string");
    // Токен полностью замаскирован и попал в удержанный префикс.
    expect(message).toContain("Bearer [redacted]");
    // Усечение случилось и маркер сохранён.
    expect(message).toContain("[truncated: ");
    // Ни полного секрета, ни его префикса от разрезанного токена.
    expect(message).not.toContain(token);
    expect(message).not.toContain("Qz7X");

    const line = jsonlLine(error);
    expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(
      PROVIDER_ERROR_DIAGNOSTIC_MAX_BYTES,
    );
    expect(line).not.toContain(token);
    expect(line).not.toContain("Qz7X");
  });

  it("bounds provider identity fields so a hostile code cannot inflate the log line", () => {
    // R06: providerCode/providerRequestId уходят в AiSdkModelAdapterError.context,
    // который adapters logging пишет без собственного лимита.
    const hugeCode = `9${"1".repeat(10_000)}`;
    const hugeRequestId = "r".repeat(10_000);
    const error = detectProviderBusinessFinishError({
      providerId: "zai",
      providerKind: "openai-compatible",
      source: {
        type: "finish",
        rawFinishReason: "provider_success_false",
        providerCode: hugeCode,
        request_id: hugeRequestId,
      },
    });

    // providerCode 的契约类型是 string | number；这里只校验字符串化长度上限。
    expect(Buffer.byteLength(String(error?.providerCode ?? ""), "utf8")).toBeLessThanOrEqual(128);
    expect(Buffer.byteLength(error?.providerRequestId ?? "", "utf8")).toBeLessThanOrEqual(128);

    const line = jsonlLine(error);
    expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(
      PROVIDER_ERROR_DIAGNOSTIC_MAX_BYTES,
    );
  });

  it("redacts common credential formats inside provider text", () => {
    // 令牌样本在运行时拼装，避免测试文件自身成为可扫描的真实密钥字面量，
    // 同时仍覆盖 GitHub 与 AWS 两种公开前缀的识别。
    const githubToken = ["ghp", "_", "a".repeat(36)].join("");
    const awsKey = ["AKIA", "A".repeat(16)].join("");
    const error = detectProviderBusinessFinishError({
      providerId: "zai",
      providerKind: "openai-compatible",
      source: {
        type: "finish",
        rawFinishReason: "provider_success_false",
        providerCode: "3007",
        providerMessage: [
          `api_key=${SECRET_MARKER}`,
          "password: hunter2-should-not-appear",
          githubToken,
          awsKey,
        ].join(" | "),
      },
    });

    const serializedSummary = JSON.stringify(error?.responseBodySummary);
    expect(serializedSummary).not.toContain(SECRET_MARKER);
    expect(serializedSummary).not.toContain("hunter2-should-not-appear");
    expect(serializedSummary).not.toContain(githubToken);
    expect(serializedSummary).not.toContain(awsKey);
    expect(serializedSummary).toContain("[redacted]");
  });
});
