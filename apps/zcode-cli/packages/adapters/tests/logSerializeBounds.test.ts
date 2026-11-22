import { describe, expect, it } from "vitest";
import { LogLevel, type LogEntry } from "@zcode/contracts";
import {
  DefaultLogRedactor,
  LOG_ERROR_FRAME_MAX_BYTES,
  LOG_LINE_MAX_BYTES,
  serializeLogError,
  toSerializableEntry,
} from "../src/logging/serialize.js";

// R06: `serializeLogError` копировал `error.context` без байтового бюджета, поэтому
// один вложенный context или длинная cause-цепочка выводили строку JSONL за 32 KiB.
// Эти тесты фиксируют enforcement point: редакция значений, затем байтовый бюджет,
// затем усечение по итоговой JSON-сериализации.

const SECRET_MARKER = "sk-live-secret-must-not-be-logged";

function frameBytes(error: unknown): number {
  const serialized = JSON.stringify(error) as string;
  return Buffer.byteLength(serialized, "utf8");
}

function lineFor(error: unknown, context?: Record<string, unknown>): string {
  const entry: LogEntry = {
    timestamp: new Date(0),
    level: LogLevel.Error,
    levelName: "ERROR",
    event: "turn.failed",
    module: "adapters.logging",
    message: "Turn failed",
    context,
    error: serializeLogError(error, false),
  };
  return JSON.stringify(toSerializableEntry(entry, new DefaultLogRedactor()));
}

describe("serializeLogError byte budget (R06)", () => {
  it("declares the 32 KiB line contract and its error-frame reserve", () => {
    expect(LOG_LINE_MAX_BYTES).toBe(32_768);
    expect(LOG_ERROR_FRAME_MAX_BYTES).toBe(28_672);
  });

  it("leaves an ordinary error unchanged", () => {
    const error = Object.assign(new Error("Provider configuration is missing"), {
      code: "provider_not_configured",
      context: {
        envKey: "ZCODE_API_KEY",
        providerId: "openai",
      },
      name: "AiSdkModelAdapterError",
      type: "configuration",
    });

    const serialized = serializeLogError(error, false);

    expect(serialized).toEqual({
      name: "AiSdkModelAdapterError",
      message: "Provider configuration is missing",
      code: "provider_not_configured",
      type: "configuration",
      context: { envKey: "ZCODE_API_KEY", providerId: "openai" },
    });
    expect(serialized.context).not.toHaveProperty("contextTruncated");
    expect(frameBytes(serialized)).toBeLessThanOrEqual(LOG_ERROR_FRAME_MAX_BYTES);
  });

  it("bounds a 1 MB context and marks the truncation", () => {
    const error = Object.assign(new Error("Model request failed"), {
      context: {
        providerCode: "3007",
        reason: "x".repeat(1_000_000),
        statusCode: 403,
      },
      name: "AiSdkModelAdapterError",
    });

    const serialized = serializeLogError(error, false);

    expect(frameBytes(serialized)).toBeLessThanOrEqual(LOG_ERROR_FRAME_MAX_BYTES);
    expect(serialized.context?.contextTruncated).toBe(true);
    // Структурно значимые поля сохраняются.
    expect(serialized.context).toMatchObject({ providerCode: "3007", statusCode: 403 });
    const reason = serialized.context?.reason;
    expect(typeof reason).toBe("string");
    expect(reason as string).toContain("[truncated: 1000000 bytes]");

    const line = lineFor(error);
    expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(LOG_LINE_MAX_BYTES);
  });

  it("keeps the full line within 32 KiB for nested arrays and objects", () => {
    // Каждый уровень сам по себе «маленький», но суммарно 1 MB; бюджет обязан
    // считаться по итоговой JSON-сериализации, а не по отдельным значениям.
    const bulky = Array.from({ length: 2_000 }, (_, index) => ({
      index,
      payload: { nested: { text: "y".repeat(512) } },
    }));
    const error = Object.assign(new Error("Model request failed"), {
      context: { bulky, providerId: "zai" },
      name: "AiSdkModelAdapterError",
    });

    const serialized = serializeLogError(error, false);
    const line = lineFor(error);

    expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(LOG_LINE_MAX_BYTES);
    expect(frameBytes(serialized)).toBeLessThanOrEqual(LOG_ERROR_FRAME_MAX_BYTES);
    expect(serialized.context?.contextTruncated).toBe(true);
    expect(serialized.context).toMatchObject({ providerId: "zai" });
  });

  it("bounds a deep cause chain", () => {
    // Кадры упираются в собственные caps (message 2 KiB, context 8 KiB), поэтому
    // 8 cause-кадров с двумя длинными строками в context суммарно превышают 28 KiB
    // и обязаны детерминированно вытесняться, а не проходить целиком.
    let cause: Error | undefined;
    for (let index = 0; index < 24; index += 1) {
      cause = Object.assign(new Error(`frame ${index} ${"z".repeat(20_000)}`), {
        cause,
        code: `CODE_${index}`,
        context: {
          depth: index,
          payload: "w".repeat(20_000),
          transcript: "t".repeat(20_000),
        },
        name: `Layer${index}Error`,
      });
    }
    const error = Object.assign(new Error("Turn failed"), {
      cause,
      name: "AiSdkModelAdapterError",
    });

    const serialized = serializeLogError(error, false);
    const line = lineFor(error);

    expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(LOG_LINE_MAX_BYTES);
    expect(frameBytes(serialized)).toBeLessThanOrEqual(LOG_ERROR_FRAME_MAX_BYTES);

    // Цепочка детерминированно обрезается с явным маркером.
    const flattened = JSON.stringify(serialized);
    expect(
      flattened.includes("causeTruncated") ||
        flattened.includes("ErrorCauseDepthLimit") ||
        flattened.includes("ErrorLogTruncated"),
    ).toBe(true);
    // Корневая identity сохраняется.
    expect(serialized.name).toBe("AiSdkModelAdapterError");
    expect(serialized.message).toBe("Turn failed");
  });

  it("redacts a sensitive value before bounding it", () => {
    const error = Object.assign(new Error("Provider rejected the request"), {
      context: {
        apiKey: `Bearer ${SECRET_MARKER}`,
        headers: { authorization: `Bearer ${SECRET_MARKER}` },
        providerCode: "3007",
        // Секрет под чувствительным ключом: его маскирует key-based редактор,
        // и только затем применяется байтовый бюджет.
        token: `${SECRET_MARKER}${"q".repeat(500_000)}`,
      },
      name: "ProviderBusinessError",
    });

    const serialized = serializeLogError(error, false);
    const line = lineFor(error);

    expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(LOG_LINE_MAX_BYTES);
    expect(line).not.toContain(SECRET_MARKER);
    expect(serialized.context?.apiKey).toBe("[Redacted]");
    expect(serialized.context?.headers).toEqual({ authorization: "[Redacted]" });
    expect(serialized.context?.token).toBe("[Redacted]");
    expect(serialized.context?.providerCode).toBe("3007");
  });

  it("stays safe for circular context and circular cause", () => {
    const circularContext: Record<string, unknown> = { providerId: "zai" };
    circularContext.self = circularContext;

    const error = Object.assign(new Error("Circular failure"), {
      context: circularContext,
      name: "AiSdkModelAdapterError",
    }) as Error & { cause?: unknown; context?: Record<string, unknown> };
    error.cause = error;

    expect(() => JSON.stringify(serializeLogError(error, false))).not.toThrow();

    const serialized = serializeLogError(error, false);
    expect(Buffer.byteLength(JSON.stringify(serialized), "utf8")).toBeLessThanOrEqual(
      LOG_ERROR_FRAME_MAX_BYTES,
    );
    expect(serialized.context).toMatchObject({ providerId: "zai" });
    // Сначала редакция (key-based), затем бюджет: цикл уже помечен редактором.
    expect(JSON.stringify(serialized)).toContain("[Redacted:Circular]");
    expect(serialized.cause?.name).toBe("ErrorCauseCircularReference");
  });

  it("never splits multibyte UTF-8 when truncating", () => {
    const error = Object.assign(new Error("Model request failed"), {
      context: { providerMessage: "😀".repeat(200_000) },
      name: "AiSdkModelAdapterError",
    });

    const serialized = serializeLogError(error, false);
    const serializedJson = JSON.stringify(serialized);

    expect(Buffer.byteLength(serializedJson, "utf8")).toBeLessThanOrEqual(
      LOG_ERROR_FRAME_MAX_BYTES,
    );
    expect(serializedJson).not.toContain("\uFFFD");
  });

  it("bounds an oversized entry context that is not an error frame", () => {
    const line = lineFor(new Error("plain"), {
      event: "turn.failed",
      providerResponse: { body: "b".repeat(1_000_000) },
      status: "failed",
    });

    expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(LOG_LINE_MAX_BYTES);
  });

  it("keeps the identity of a huge error frame inside an oversized entry", () => {
    const error = Object.assign(new Error("Model request failed"), {
      context: { reason: "r".repeat(2_000_000) },
      name: "AiSdkModelAdapterError",
    });
    const line = lineFor(error, {
      event: "turn.failed",
      providerResponse: { body: "b".repeat(2_000_000) },
      status: "failed",
    });

    expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(LOG_LINE_MAX_BYTES);
    const parsed = JSON.parse(line) as {
      error?: { name?: string };
      logLineTruncated?: boolean;
    };
    expect(parsed.error?.name).toBe("AiSdkModelAdapterError");
    expect(parsed.logLineTruncated).toBeUndefined();
  });
});
