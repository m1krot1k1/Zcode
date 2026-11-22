import type { AiSdkProviderKind, ProviderBusinessErrorOptions } from "./model-execution.js";
import { ProviderBusinessError } from "./model-execution.js";
import { getHttpResponseStatus, getResponseHeaders } from "./failure-inspection.js";
import { sanitizeModelNetworkHeaders } from "./runner-network-headers.js";
import { asRecord, stringProperty } from "./runner-record.js";

const BIGMODEL_BRACKETED_BUSINESS_CODE_PATTERN = /^\[(\d{4})\](?=\[)/;
const PROVIDER_BUSINESS_ERROR_WRAPPER_CODE = "PROVIDER_BUSINESS_ERROR";

/**
 * Diagnostic budget for one serialized error line. JSONL records and support bundles must stay
 * within 32 KiB; the summary produced here is the only unbounded provider payload that used to
 * reach that line (R06, docs/specs/2026-11-11-error-redaction.md). The summary takes 1/16 of the
 * line budget (2 KiB) so that a cause chain with several bounded frames still fits within 32 KiB.
 */
export const PROVIDER_ERROR_DIAGNOSTIC_MAX_BYTES = 32 * 1024;
export const PROVIDER_BUSINESS_SUMMARY_MAX_BYTES = PROVIDER_ERROR_DIAGNOSTIC_MAX_BYTES / 16;
/** Individual strings keep one diagnostic line's worth of text, never a whole message list. */
const SUMMARY_STRING_MAX_BYTES = 512;
const SUMMARY_KEY_MAX_CHARS = 64;
const SUMMARY_MAX_KEYS = 20;
const SUMMARY_TRUNCATION_MARKER_PREFIX = " [truncated: ";
/**
 * R06: providerCode/providerRequestId приходят от провайдера и попадают в контекст ошибки,
 * который adapters logging пишет без собственного лимита. Без границы одно поле само
 * выводит строку JSONL за 32 KiB, поэтому identity ограничивается у владельца ошибки.
 */
const PROVIDER_IDENTITY_MAX_BYTES = 128;
const SENSITIVE_SUMMARY_KEY_PATTERN =
  /(?:api[-_]?key|authorization|cookie|credential|password|secret|token)/i;

/** Top-level scalar fields worth keeping for diagnostics. Object values are never copied. */
const SUMMARY_SCALAR_KEYS = [
  "success",
  "code",
  "error_code",
  "providerCode",
  "providerId",
  "providerRequestId",
  "status",
  "statusCode",
  "responseStatus",
  "request_id",
  "requestId",
  "type",
  "msg",
  "message",
  "providerMessage",
] as const;

const ERROR_SUMMARY_SCALAR_KEYS = [
  "code",
  "error_code",
  "providerCode",
  "providerId",
  "providerRequestId",
  "type",
  "status",
  "statusCode",
  "responseStatus",
  "request_id",
  "requestId",
  "msg",
  "message",
  "providerMessage",
] as const;

interface DetectProviderBusinessFinishErrorOptions {
  providerId: string;
  providerKind?: AiSdkProviderKind | string;
  source: unknown;
}

export function detectProviderBusinessFinishError(
  options: DetectProviderBusinessFinishErrorOptions,
): ProviderBusinessError | undefined {
  const record = asRecord(options.source);
  if (!isFinishLikeRecord(record)) {
    return undefined;
  }

  const rawFinishReason = readRawFinishReason(record);
  const extracted = extractBusinessFailurePayload(record);
  const errorPayload = asRecord(record.error);
  const providerCode =
    extracted.providerCode ??
    normalizeStringish(record.providerCode) ??
    normalizeStringish(errorPayload?.code);

  // AI SDK 的 error chunk 常带普通 Error.message（如 rate limited），没有业务码；
  // 仅凭 providerMessage 命中会把可重试限流误判成 ProviderBusinessError。
  const hasBusinessSignal =
    providerCode !== undefined ||
    rawFinishReason === "provider_success_false" ||
    record.isProviderBusinessError === true ||
    record.name === "ProviderBusinessError";

  if (!hasBusinessSignal) {
    return undefined;
  }

  const providerMessage =
    extracted.providerMessage ??
    normalizeStringish(record.providerMessage) ??
    normalizeStringish(record.message) ??
    (rawFinishReason === "provider_success_false"
      ? "Provider returned a business error."
      : undefined);

  const errorOptions: ProviderBusinessErrorOptions = {
    providerId: options.providerId,
    providerKind: normalizeProviderKind(options.providerKind),
    providerCode: boundProviderIdentity(providerCode),
    // R06: providerMessage уходит дальше в failure.message → statusMessage JSONL.
    // Маскировка здесь, у владельца ошибки, чтобы секрет не зависел от формы лога.
    providerMessage:
      providerMessage === undefined ? undefined : redactSecretLikeValue(providerMessage),
    providerRequestId: boundProviderIdentity(extracted.providerRequestId),
    responseBodySummary: extracted.responseBodySummary,
    // AI SDK 的 error chunk 会把 fetch 层业务错误重新包一层；
    // 重建 ProviderBusinessError 时不带 responseHeaders，会让 retry-after 在重试计算前丢失。
    responseHeaders: extracted.responseHeaders,
    responseStatus: extracted.responseStatus,
    statusCode: extracted.statusCode,
  };

  return new ProviderBusinessError(errorOptions);
}

function normalizeProviderKind(value: AiSdkProviderKind | string | undefined): AiSdkProviderKind {
  return value === "openai" ||
    value === "anthropic" ||
    value === "openai-compatible" ||
    value === "opencode-sdk"
    ? value
    : "openai-compatible";
}

function isFinishLikeRecord(record: Record<string, unknown>): boolean {
  const chunkType = stringProperty(record, "type");
  if (chunkType === "finish" || chunkType === "error") {
    return true;
  }

  if (stringProperty(record, "finishReason") || readRawFinishReason(record)) {
    return true;
  }

  if (record.isProviderBusinessError === true || record.name === "ProviderBusinessError") {
    return true;
  }

  return false;
}

function readRawFinishReason(record: Record<string, unknown>): string | undefined {
  return (
    stringProperty(record, "rawFinishReason") ??
    stringProperty(asRecord(record.providerMetadata), "rawFinishReason")
  );
}

function extractBusinessFailurePayload(record: Record<string, unknown>) {
  const candidates = collectCandidateRecords(record);
  const providerCode = candidates.map(readProviderCode).find(Boolean);
  const providerMessage = candidates.map(readProviderMessage).find(Boolean);
  const providerRequestId = candidates.map(readProviderRequestId).find(Boolean);
  // R06: заголовки ответа тоже попадают в диагностический объект ошибки. Значения
  // authorization/api-key/cookie/token заменяются до того, как ошибка уйдёт из adapter;
  // retry-after/x-should-retry сохраняются, иначе ломается расчёт повторов.
  const rawResponseHeaders = candidates.map(getResponseHeaders).find(Boolean);
  const responseHeaders = rawResponseHeaders
    ? sanitizeModelNetworkHeaders(rawResponseHeaders)
    : undefined;
  // R06: раньше здесь лежал весь finish/error chunk, включая request body (input/messages/tools),
  // и он целиком уходил в JSONL и support bundle. Сигнал ошибки по-прежнему нужно найти,
  // но в ошибку попадает только безопасная сводка с байтовым бюджетом.
  const responseBodySignal = candidates.find(hasBusinessSignal);
  const responseBodySummary = responseBodySignal
    ? summarizeProviderBusinessSignal(responseBodySignal)
    : undefined;
  const responseStatus = candidates.map(getHttpResponseStatus).find((value) => value !== undefined);
  const statusCode = candidates.map(readStatusCode).find((value) => value !== undefined);

  return {
    providerCode,
    providerMessage,
    providerRequestId,
    responseHeaders,
    responseBodySummary,
    responseStatus,
    statusCode,
  };
}

function collectCandidateRecords(record: Record<string, unknown>): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  const seen = new WeakSet<object>();
  const queue: unknown[] = [record];

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
      for (const item of current) {
        queue.push(item);
      }
      continue;
    }

    const currentRecord = current as Record<string, unknown>;
    result.push(currentRecord);

    queue.push(
      currentRecord.providerMetadata,
      currentRecord.response,
      asRecord(currentRecord.response).body,
      currentRecord.body,
      currentRecord.error,
      currentRecord.data,
      currentRecord.choices,
    );

    // zcode-plan 等业务错误可能只出现在 AI SDK finish chunk 的深层 JSON（如 response.body），
    // 仅沿固定字段链扫描会漏掉 3007，最终让 core 误判为 suspicious empty。
    for (const nested of Object.values(currentRecord)) {
      if (nested && typeof nested === "object") {
        queue.push(nested);
      }
    }
  }

  return result;
}

function readProviderCode(record: Record<string, unknown>): string | undefined {
  const errorRecord = asRecord(record.error);
  const contextRecord = asRecord(record.context);
  const value =
    normalizeProviderCode(record.providerCode) ??
    normalizeProviderCode(errorRecord?.providerCode) ??
    normalizeProviderCode(contextRecord?.providerCode) ??
    normalizeProviderCode(record.error_code) ??
    normalizeProviderCode(errorRecord?.error_code) ??
    // ProviderBusinessError 二次进入 AI SDK chunk 时，外层 code 是包装类型；
    // 真实上游码在 providerCode/嵌套 body 中，不能让包装码提前截断扫描。
    normalizeProviderCode(record.code) ??
    normalizeProviderCode(errorRecord?.code) ??
    normalizeProviderCode(contextRecord?.code) ??
    // BigModel/Z.AI 的 SSE error chunk 有时只有 `[1302][...][request_id]` message，
    // 没有结构化 code；只解析这个强格式前缀，避免把普通 rate limit 文案误判成业务码。
    readBigModelBracketedBusinessCode(record.message) ??
    readBigModelBracketedBusinessCode(record.providerMessage) ??
    readBigModelBracketedBusinessCode(errorRecord?.message) ??
    readBigModelBracketedBusinessCode(errorRecord?.providerMessage) ??
    readBigModelBracketedBusinessCode(contextRecord?.message) ??
    readBigModelBracketedBusinessCode(contextRecord?.providerMessage);
  return value;
}

function readProviderMessage(record: Record<string, unknown>): string | undefined {
  const errorRecord = asRecord(record.error);
  const contextRecord = asRecord(record.context);
  return (
    normalizeStringish(record.msg) ??
    normalizeStringish(record.providerMessage) ??
    normalizeStringish(record.message) ??
    normalizeStringish(errorRecord?.msg) ??
    normalizeStringish(errorRecord?.providerMessage) ??
    normalizeStringish(errorRecord?.message) ??
    normalizeStringish(contextRecord?.providerMessage) ??
    normalizeStringish(contextRecord?.msg) ??
    normalizeStringish(contextRecord?.message)
  );
}

function readProviderRequestId(record: Record<string, unknown>): string | undefined {
  const errorRecord = asRecord(record.error);
  return (
    normalizeStringish(record.request_id) ??
    normalizeStringish(record.requestId) ??
    normalizeStringish(record.id) ??
    normalizeStringish(errorRecord.request_id) ??
    normalizeStringish(errorRecord.requestId) ??
    normalizeStringish(errorRecord.id)
  );
}

function readStatusCode(record: Record<string, unknown>): number | undefined {
  return toFiniteNumber(record.statusCode) ?? toFiniteNumber(record.status);
}

function hasBusinessSignal(record: Record<string, unknown>): boolean {
  return Boolean(
    readProviderCode(record) ||
    readProviderMessage(record) ||
    (Array.isArray(record.allowed_models) && record.allowed_models.length > 0),
  );
}

function normalizeStringish(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeProviderCode(value: unknown): string | undefined {
  const normalized = normalizeStringish(value);
  return normalized?.toUpperCase() === PROVIDER_BUSINESS_ERROR_WRAPPER_CODE
    ? undefined
    : normalized;
}

function readBigModelBracketedBusinessCode(value: unknown): string | undefined {
  const message = normalizeStringish(value);
  const match = message?.match(BIGMODEL_BRACKETED_BUSINESS_CODE_PATTERN);
  return match?.[1];
}

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// ---------------------------------------------------------------------------
// R06: безопасная сводка provider body
// ---------------------------------------------------------------------------
// Раньше сюда попадал весь найденный record. Это мог быть finish/error chunk,
// содержащий исходный request body целиком (prompt, messages, tool schemas),
// поэтому одна строка JSONL/support bundle доходила до 1.46 MB. Ниже — явный
// allowlist скалярных полей и байтовый бюджет: тело запроса не копируется никогда.

/** Имена ключей, которые сами указывают на payload; их не сохраняем даже как имена. */
const PAYLOAD_KEY_NAMES = new Set([
  "body",
  "data",
  "headers",
  "input",
  "messages",
  "providerOptions",
  "request",
  "response",
  "responseBodySummary",
  "responseHeaders",
  "sdkMessages",
  "tools",
]);

function summarizeProviderBusinessSignal(
  record: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const fields = new Map<string, unknown>();
  const sourceBytes = serializeByteLength(record);
  if (sourceBytes !== undefined) {
    // sourceBytes идёт первым и никогда не вытесняется: он нужен, чтобы понять,
    // насколько тело было больше безопасной сводки.
    fields.set("sourceBytes", sourceBytes);
  }

  const keys = safeRecordKeyNames(record);
  if (keys.length > 0) {
    fields.set("keys", keys);
  }
  copySummaryScalars(record, SUMMARY_SCALAR_KEYS, fields);
  // Список допустимых моделей — не payload, а безопасная подсказка для 3006-ошибок.
  const allowedModels = boundedStringList(record.allowed_models);
  if (allowedModels.length > 0) {
    fields.set("allowed_models", allowedModels);
  }

  const errorRecord = asRecord(record.error);
  if (errorRecord !== undefined) {
    const errorSummary = summarizeNestedBusinessError(errorRecord);
    if (Object.keys(errorSummary).length > 0) {
      fields.set("error", errorSummary);
    }
  }

  // Обёрнутый ProviderBusinessError несёт реальный код/сообщение во вложенной
  // responseBodySummary. Сохраняем только её безопасные скаляры (один уровень),
  // чтобы классификация и диагностика не зависели от целого payload.
  const nestedSummary = asRecord(record.responseBodySummary);
  if (nestedSummary !== undefined) {
    const nested = summarizeNestedBusinessError(nestedSummary);
    if (Object.keys(nested).length > 0) {
      fields.set("responseBodySummaryDetail", nested);
    }
  }

  return fitSummaryBudget(fields);
}

function summarizeNestedBusinessError(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const fields = new Map<string, unknown>();
  const safeKeys = safeRecordKeyNames(record);
  if (safeKeys.length > 0) {
    fields.set("keys", safeKeys);
  }
  // Error-инстансы держат message/name/code не в `Object.keys`, поэтому скаляры
  // читаются напрямую, а `keys` — только как дополнительная метаинформация.
  copySummaryScalars(record, ERROR_SUMMARY_SCALAR_KEYS, fields);

  // Классификатор читает транспортный код из error.cause.code (ECONNRESET и т.п.).
  // Сохраняем только этот скаляр, а не весь вложенный объект.
  const causeRecord = asRecord(record.cause);
  const causeCode = asRecordScalar(causeRecord, "code");
  if (causeCode !== undefined) {
    fields.set("cause", { code: causeCode });
  }

  return Object.fromEntries(fields);
}

function asRecordScalar(
  record: Record<string, unknown> | undefined,
  key: string,
): string | number | boolean | undefined {
  const value = scalarSummaryValue(record?.[key]);
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : undefined;
}

function copySummaryScalars(
  source: Record<string, unknown>,
  keys: readonly string[],
  target: Map<string, unknown>,
): void {
  for (const key of keys) {
    const value = scalarSummaryValue(source[key]);
    if (value !== undefined) {
      target.set(key, value);
    }
  }
}

function scalarSummaryValue(value: unknown): unknown {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  // R06: маскировка значений идёт до усечения. Иначе провайдерский текст вида
  // "Authorization: Bearer sk-..." сохранил бы первые байты секрета в обрезанном префиксе;
  // редактор логгера видит только имена полей и такую строку не поймает.
  return truncateUtf8(redactSecretLikeValue(value), SUMMARY_STRING_MAX_BYTES).text;
}

/**
 * Маскирует секреты внутри свободного текста provider-сообщения.
 *
 * Список шаблонов намеренно узкий и детерминированный: echo заголовка Authorization,
 * bare Bearer/Basic, распространённые форматы ключей и `key=value`/`key: "value"`.
 * Это не бизнес-редактор пользовательских данных; результат всегда проходит байтовый
 * бюджет строки после маскировки (docs/specs/2026-11-11-error-redaction.md, правило 5).
 */
function redactSecretLikeValue(value: string): string {
  return value
    .replace(
      /(\bauthorization\b["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:(?:bearer|basic)\s+)?[^\s,;"']+)/giu,
      "$1[redacted]",
    )
    // Токен требует хотя бы одного не-буквенного символа: иначе «basic authentication»
    // в обычном тексте ошибки маскировалось бы как секрет.
    .replace(
      /\b(bearer|basic)\s+(?=[A-Za-z0-9._~+/=-]*[0-9._~+/=-])[A-Za-z0-9._~+/=-]{8,}/giu,
      "$1 [redacted]",
    )
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/giu, "[redacted]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu, "[redacted]")
    .replace(/\bAKIA[A-Z0-9]{16}\b/gu, "[redacted]")
    .replace(/\bAIza[0-9A-Za-z_-]{30,}/gu, "[redacted]")
    .replace(
      /(\b(?:api[-_\s]?key|access[-_\s]?token|token|password|passwd|secret|credential)\b["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;"']+)/giu,
      "$1[redacted]",
    );
}

/**
 * R06: identity провайдера (code/request id) — не свободный текст, но и не доверенное
 * значение. Ограничиваем байтами и не добавляем маркер: маркер в code сломал бы
 * сопоставление бизнес-кодов, а сам факт усечения виден по длине в диагностике.
 */
function boundProviderIdentity(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= PROVIDER_IDENTITY_MAX_BYTES) {
    return value;
  }
  let end = PROVIDER_IDENTITY_MAX_BYTES;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }
  return bytes.subarray(0, end).toString("utf8");
}

function safeRecordKeyNames(record: Record<string, unknown>): string[] {
  return Object.keys(record)
    .filter(
      (key) =>
        key.length > 0 &&
        !PAYLOAD_KEY_NAMES.has(key) &&
        !SENSITIVE_SUMMARY_KEY_PATTERN.test(key),
    )
    .slice(0, SUMMARY_MAX_KEYS)
    .map((key) => key.slice(0, SUMMARY_KEY_MAX_CHARS));
}

/** Строковые списки (`allowed_models`) сохраняются как метаданные, но с теми же границами. */
function boundedStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .flatMap((item) => {
      const text = scalarSummaryValue(item);
      return typeof text === "string" && text.length > 0 ? [text] : [];
    })
    .slice(0, SUMMARY_MAX_KEYS);
}

function serializeByteLength(value: unknown): number | undefined {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : Buffer.byteLength(serialized, "utf8");
  } catch {
    // Циклическое или несериализуемое тело: размер недоступен, но сводка всё ещё полезна.
    return undefined;
  }
}

/**
 * Детерминированно укладывает сводку в {@link PROVIDER_BUSINESS_SUMMARY_MAX_BYTES}.
 * Вытесняется самое «дорогое» поле (кроме sourceBytes), пока бюджет не соблюдён;
 * факт вытеснения фиксируется `summaryTruncated`. Порядок и выбор полей не зависят
 * от времени/окружения, поэтому результат воспроизводим.
 */
function fitSummaryBudget(fields: Map<string, unknown>): Record<string, unknown> {
  const entries = [...fields.entries()].filter(([, value]) => value !== undefined);
  // Резервируем место под маркер до вытеснения полей, иначе итоговая сводка
  // с `summaryTruncated` могла бы выйти за бюджет и потерять сам факт усечения.
  const markerOverhead = Buffer.byteLength(',"summaryTruncated":true', "utf8");
  const contentBudget = PROVIDER_BUSINESS_SUMMARY_MAX_BYTES - markerOverhead;
  let truncated = false;

  while (summaryByteLength(entries) > contentBudget) {
    const dropIndex = largestDroppableEntryIndex(entries);
    if (dropIndex < 0) break;
    entries.splice(dropIndex, 1);
    truncated = true;
  }

  const summary = Object.fromEntries(entries);
  return truncated ? { ...summary, summaryTruncated: true } : summary;
}

function largestDroppableEntryIndex(entries: Array<[string, unknown]>): number {
  let index = -1;
  let largest = -1;
  for (let position = 0; position < entries.length; position += 1) {
    const [key, value] = entries[position]!;
    if (key === "sourceBytes") continue;
    const bytes = summaryByteLength([[key, value]]);
    if (bytes > largest) {
      largest = bytes;
      index = position;
    }
  }
  return index;
}

function summaryByteLength(entries: Array<[string, unknown]>): number {
  return Buffer.byteLength(JSON.stringify(Object.fromEntries(entries)), "utf8");
}

interface Utf8Truncation {
  text: string;
  truncated: boolean;
  originalBytes: number;
}

/**
 * Режет строку по UTF-8 байтам, а не по UTF-16 code units. Откат делается по
 * continuation-byte (0b10xxxxxx), поэтому многобайтный символ не разрезается
 * посередине и в результате не появляется U+FFFD. Маркер содержит исходный
 * размер, чтобы усечение было видно и измеримо.
 */
function truncateUtf8(value: string, maxBytes: number): Utf8Truncation {
  const originalBytes = Buffer.byteLength(value, "utf8");
  if (originalBytes <= maxBytes) {
    return { text: value, truncated: false, originalBytes };
  }

  const marker = `${SUMMARY_TRUNCATION_MARKER_PREFIX}${originalBytes} bytes]`;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (markerBytes >= maxBytes) {
    return { text: "", truncated: true, originalBytes };
  }

  const bytes = Buffer.from(value, "utf8");
  let end = Math.min(bytes.length, maxBytes - markerBytes);
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }

  return {
    text: `${bytes.subarray(0, end).toString("utf8")}${marker}`,
    truncated: true,
    originalBytes,
  };
}
