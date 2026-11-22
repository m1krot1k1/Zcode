import type { LogContext, LogEntry, LogRedactor } from "@zcode/contracts";

export interface SerializedLogError {
  name: string;
  message: string;
  code?: string;
  type?: string;
  stack?: string;
  context?: Record<string, unknown>;
  cause?: SerializedLogError;
}

export type SerializableLogEntry = Record<string, unknown>;

/**
 * R06: контракт одной строки JSONL. Число объявлено здесь, потому что adapters
 * logging — единственный writer файла; core-проекция использует тот же лимит.
 */
export const LOG_LINE_MAX_BYTES = 32 * 1024;

/** Запас строки под timestamp/level/message/context вне error-кадра. */
const LOG_LINE_RESERVE_BYTES = 4 * 1024;

/** Бюджет сериализованного error-кадра, гарантирующий место остальным полям. */
export const LOG_ERROR_FRAME_MAX_BYTES = LOG_LINE_MAX_BYTES - LOG_LINE_RESERVE_BYTES;

const ERROR_MAX_CAUSE_DEPTH = 8;
const ERROR_NAME_MAX_BYTES = 256;
const ERROR_IDENTITY_MAX_BYTES = 256;
const ERROR_MESSAGE_MAX_BYTES = 2 * 1024;
const ERROR_MESSAGE_MIN_BYTES = 128;
const ERROR_STACK_MAX_BYTES = 4 * 1024;
const ERROR_CONTEXT_MAX_BYTES = 8 * 1024;
const ERROR_CONTEXT_MIN_BYTES = 512;
const CONTEXT_STRING_MAX_BYTES = 1 * 1024;
const CONTEXT_MAX_DEPTH = 8;
const CONTEXT_MAX_ENTRIES = 64;
const CONTEXT_MAX_ARRAY_ITEMS = 32;
const CONTEXT_MAX_NODES = 512;
const LINE_CONTEXT_MAX_BYTES = 4 * 1024;
const LINE_MESSAGE_MAX_BYTES = 2 * 1024;
const LINE_MESSAGE_MIN_BYTES = 256;
const TRUNCATED_VALUE = "[truncated]";
const CONTEXT_TRUNCATED_KEY = "contextTruncated";
const LOG_FRAME_TRUNCATED_KEY = "logFrameTruncated";
const LOG_LINE_TRUNCATED_KEY = "logLineTruncated";

export class DefaultLogRedactor implements LogRedactor {
  private readonly sensitiveKeyPattern =
    /(?:api[-_]?key|authorization|cookie|credential|password|secret|token)/i;

  redact(value: unknown): unknown {
    return this.redactValue(value, new WeakSet(), 0);
  }

  private redactValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
    if (depth > 8) {
      return "[Redacted:DepthLimit]";
    }
    if (value === null || typeof value !== "object") {
      return value;
    }
    if (seen.has(value)) {
      return "[Redacted:Circular]";
    }
    seen.add(value);

    if (Array.isArray(value)) {
      return value.map((item) => this.redactValue(item, seen, depth + 1));
    }

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entryValue]) => [
        key,
        this.sensitiveKeyPattern.test(key)
          ? "[Redacted]"
          : this.redactValue(entryValue, seen, depth + 1),
      ]),
    );
  }
}

const defaultLogRedactor = new DefaultLogRedactor();

export function stripReservedContext(context: LogContext): Record<string, unknown> | undefined {
  const {
    durationMs: _durationMs,
    event: _event,
    module: _module,
    parentSpanId: _parentSpanId,
    sessionId: _sessionId,
    spanId: _spanId,
    status: _status,
    toolCallId: _toolCallId,
    traceId: _traceId,
    turnId: _turnId,
    ...rest
  } = context;

  return Object.keys(rest).length === 0 ? undefined : rest;
}

export function toSerializableEntry(
  entry: LogEntry,
  redactor: LogRedactor,
): SerializableLogEntry {
  try {
    const value = {
      timestamp: entry.timestamp.toISOString(),
      level: entry.levelName.toLowerCase(),
      event: entry.event,
      module: entry.module,
      message: entry.message,
      traceId: entry.traceId,
      spanId: entry.spanId,
      parentSpanId: entry.parentSpanId,
      sessionId: entry.sessionId,
      turnId: entry.turnId,
      toolCallId: entry.toolCallId,
      durationMs: entry.durationMs,
      status: entry.status,
      context: safeRedact(redactor, entry.context),
      error: safeRedact(redactor, entry.error),
    };

    const filtered = Object.fromEntries(
      Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
    );

    // R06: редакция выполнена выше; байтовый бюджет строки применяется только после неё.
    return boundSerializedEntryLine(filtered);
  } catch {
    // Логирование не должно ломать исполнение агента.
    return {
      level: "error",
      message: "Log entry could not be serialized within the byte budget.",
      [LOG_LINE_TRUNCATED_KEY]: true,
    };
  }
}

function safeRedact(redactor: LogRedactor, value: unknown): unknown {
  try {
    return redactor.redact(value);
  } catch {
    return "[Unserializable]";
  }
}

export function formatConsoleLine(entry: LogEntry): string {
  const trace = entry.traceId ? ` trace=${entry.traceId.slice(0, 8)}` : "";
  const event = entry.event ? ` event=${entry.event}` : "";
  return `${entry.levelName.toLowerCase()} [${entry.module ?? "log"}]${trace}${event} ${entry.message}`;
}

export function isLogStatus(value: unknown): value is LogEntry["status"] {
  return (
    value === "started" ||
    value === "waiting" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  );
}

export function serializeLogError(
  error: unknown,
  includeStack: boolean,
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
): SerializedLogError {
  try {
    const frame = buildSerializedLogError(error, includeStack, seen, depth);
    return fitErrorFrameToBudget(frame);
  } catch {
    // Логирование не должно ломать исполнение агента: сбой доступа к свойствам
    // (бросающий getter/Proxy) даёт минимальный ограниченный кадр вместо исключения.
    return {
      name: "ErrorLogUnserializable",
      message: "Error could not be serialized for logging.",
    };
  }
}

function buildSerializedLogError(
  error: unknown,
  includeStack: boolean,
  seen: WeakSet<object>,
  depth: number,
): SerializedLogError {
  if (depth > ERROR_MAX_CAUSE_DEPTH) {
    return {
      name: "ErrorCauseDepthLimit",
      message: "Error cause chain exceeded the serialization depth limit.",
    };
  }

  if (error === null || typeof error !== "object") {
    return {
      name: "UnknownError",
      message: truncateUtf8Text(String(error), ERROR_MESSAGE_MAX_BYTES),
    };
  }

  if (seen.has(error)) {
    return {
      name: "ErrorCauseCircularReference",
      message: "Error cause chain contained a circular reference.",
    };
  }
  seen.add(error);

  const record = error as Record<string, unknown>;
  const cause = record.cause;
  const value: SerializedLogError = {
    name: truncateUtf8Text(
      typeof record.name === "string" ? record.name : "Error",
      ERROR_NAME_MAX_BYTES,
    ),
    message: truncateUtf8Text(
      typeof record.message === "string" ? record.message : String(error),
      ERROR_MESSAGE_MAX_BYTES,
    ),
  };
  const code = stringProperty(record, "code");
  const type = stringProperty(record, "type");
  const context = record.context;

  if (code) value.code = boundIdentityText(code, ERROR_IDENTITY_MAX_BYTES);
  if (type) value.type = boundIdentityText(type, ERROR_IDENTITY_MAX_BYTES);
  if (includeStack && typeof record.stack === "string") {
    value.stack = truncateUtf8Text(record.stack, ERROR_STACK_MAX_BYTES);
  }
  if (isPlainObject(context)) {
    // R06: порядок redact → bound → truncate. DefaultLogRedactor маскирует по именам
    // ключей; маскировка обязана произойти до байтового усечения, иначе бюджет мог бы
    // оставить в строке префикс значения, которое редактор ещё не заменил.
    value.context = boundRedactedContext(context);
  }
  if (cause !== undefined) {
    value.cause = buildSerializedLogError(cause, includeStack, seen, depth + 1);
  }

  return value;
}

interface ContextCloneState {
  remainingBytes: number;
  remainingNodes: number;
  seen: WeakSet<object>;
  truncated: boolean;
}

function boundRedactedContext(context: Record<string, unknown>): Record<string, unknown> {
  // Логирование не должно ломать исполнение агента: геттер/Proxy, бросающий при
  // перечислении ключей, превращается в явный маркер вместо исключения.
  try {
    return boundErrorContext(defaultLogRedactor.redact(context));
  } catch {
    return { contextUnserializable: true };
  }
}

/**
 * Копирует context в JSON-безопасную форму с байтовым бюджетом. Ограничения
 * (глубина, количество узлов, строки, массивы) не дают вложенным структурам обойти
 * лимит; итоговый размер всё равно перепроверяется по `JSON.stringify`.
 */
function boundErrorContext(redacted: unknown): Record<string, unknown> {
  const state: ContextCloneState = {
    remainingBytes: ERROR_CONTEXT_MAX_BYTES,
    remainingNodes: CONTEXT_MAX_NODES,
    seen: new WeakSet(),
    truncated: false,
  };
  const cloned = cloneContextValue(redacted, state, 0);
  const record: Record<string, unknown> = isPlainObject(cloned) ? cloned : {};
  if (state.truncated) {
    record[CONTEXT_TRUNCATED_KEY] = true;
  }
  if (utf8JsonBytes(record) > ERROR_CONTEXT_MAX_BYTES) {
    return compactContext(record, ERROR_CONTEXT_MAX_BYTES);
  }
  return record;
}

function cloneContextValue(value: unknown, state: ContextCloneState, depth: number): unknown {
  if (depth > CONTEXT_MAX_DEPTH || state.remainingNodes <= 0 || state.remainingBytes <= 16) {
    state.truncated = true;
    return TRUNCATED_VALUE;
  }

  if (value === null) {
    state.remainingBytes -= 4;
    return null;
  }

  switch (typeof value) {
    case "string":
      return cloneBoundedString(value, state, CONTEXT_STRING_MAX_BYTES);
    case "number":
      state.remainingBytes -= 8;
      return Number.isFinite(value) ? value : null;
    case "boolean":
      state.remainingBytes -= 5;
      return value;
    case "bigint":
      // Конвертация в строку не теряет данные: JSON.stringify иначе бросил бы TypeError.
      return cloneBoundedString(value.toString(), state, CONTEXT_STRING_MAX_BYTES);
    case "undefined":
      return undefined;
    case "function":
    case "symbol":
      state.truncated = true;
      return TRUNCATED_VALUE;
    default:
      // Все не-object typeof-ветки обработаны выше; `default` — это "object".
      break;
  }

  if (!isObjectLike(value)) {
    // Недостижимо: null и все примитивные typeof обработаны выше.
    state.truncated = true;
    return TRUNCATED_VALUE;
  }

  if (state.seen.has(value)) {
    state.truncated = true;
    return "[circular]";
  }
  if (value instanceof Date) {
    return cloneBoundedString(value.toISOString(), state, CONTEXT_STRING_MAX_BYTES);
  }

  state.seen.add(value);
  state.remainingNodes -= 1;

  if (Array.isArray(value)) {
    const items: unknown[] = [];
    const limit = Math.min(value.length, CONTEXT_MAX_ARRAY_ITEMS);
    for (let index = 0; index < limit; index += 1) {
      if (state.remainingBytes <= 16) {
        state.truncated = true;
        break;
      }
      const item = cloneContextValue(value[index], state, depth + 1);
      // `undefined` в массиве JSON.stringify превращает в null; фиксируем это
      // явно, чтобы форма копии совпадала с итоговой строкой.
      items.push(item === undefined ? null : item);
    }
    if (items.length < value.length) {
      state.truncated = true;
      items.push(TRUNCATED_VALUE);
    }
    return items;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const result: Record<string, unknown> = {};
  // Сначала сохраняются скалярные поля, затем вложенные значения в исходном порядке.
  // Иначе один большой соседний массив (например, `bulky`) выедал бы бюджет до
  // `providerCode`/`statusCode`, и диагностически важные скаляры терялись бы.
  const scalarEntries: Array<[string, unknown]> = [];
  const nestedEntries: Array<[string, unknown]> = [];
  for (const [key, entryValue] of entries) {
    if (
      entryValue === null ||
      typeof entryValue === "string" ||
      typeof entryValue === "number" ||
      typeof entryValue === "boolean" ||
      typeof entryValue === "bigint"
    ) {
      scalarEntries.push([key, entryValue]);
    } else {
      nestedEntries.push([key, entryValue]);
    }
  }

  let visited = 0;
  for (const [key, entryValue] of [...scalarEntries, ...nestedEntries]) {
    if (visited >= CONTEXT_MAX_ENTRIES || state.remainingBytes <= 16) {
      state.truncated = true;
      break;
    }
    visited += 1;
    if (key === "__proto__") {
      // Запись `result.__proto__ = ...` меняет прототип копии, а не создаёт поле:
      // такое поле не должно ни теряться молча, ни влиять на структуру.
      state.truncated = true;
      continue;
    }
    state.remainingBytes -= Buffer.byteLength(key, "utf8");
    const cloned = cloneContextValue(entryValue, state, depth + 1);
    // JSON.stringify отбрасывает undefined-значения и сам по себе; это не признак
    // бюджетного усечения, поэтому visited считается до фильтрации.
    if (cloned !== undefined) {
      result[key] = cloned;
    }
  }
  if (visited < entries.length) {
    state.truncated = true;
  }
  return result;
}

function cloneBoundedString(value: string, state: ContextCloneState, maxBytes: number): string {
  const originalBytes = Buffer.byteLength(value, "utf8");
  const allowed = Math.min(maxBytes, Math.max(0, state.remainingBytes));
  if (originalBytes <= allowed) {
    state.remainingBytes -= originalBytes;
    return value;
  }

  state.truncated = true;
  if (allowed < 16) {
    state.remainingBytes = 0;
    return TRUNCATED_VALUE;
  }
  const bounded = truncateUtf8Text(value, allowed);
  state.remainingBytes -= Buffer.byteLength(bounded, "utf8");
  return bounded;
}

/**
 * Детерминированно укладывает context в бюджет: сначала сохраняются скалярные поля
 * (providerCode, statusCode, reason и т.п.), затем вложенные значения в исходном
 * порядке. Усечение всегда помечается `contextTruncated: true`.
 */
function compactContext(
  source: Record<string, unknown>,
  maxBytes: number,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  // Учёт приблизительный: `{`+`}` (2) + пара маркера с запятой перед ней + пары
  // ключ/значение без запятых между ними. Точный бюджет гарантирует финальная
  // проверка `JSON.stringify` ниже, поэтому недоучёт запятых безопасен.
  const markerCost = Buffer.byteLength(`"${CONTEXT_TRUNCATED_KEY}":true`, "utf8") + 1;
  let used = 2 + markerCost;

  const scalarEntries: Array<{ key: string; value: string | number | boolean | null }> = [];
  const nestedEntries: Array<{ key: string; value: unknown }> = [];
  for (const [key, value] of Object.entries(source)) {
    if (key === CONTEXT_TRUNCATED_KEY) continue;
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      scalarEntries.push({ key, value });
    } else if (typeof value === "number") {
      scalarEntries.push({ key, value });
    } else if (typeof value === "bigint") {
      // bigint не сериализуется JSON.stringify; сохраняем текстом, чтобы не потерять
      // диагностическое поле и не уронить запись.
      scalarEntries.push({ key, value: value.toString() });
    } else {
      nestedEntries.push({ key, value });
    }
  }

  for (const entry of scalarEntries) {
    if (entry.key === "__proto__") continue;
    let value: string | number | boolean | null = entry.value;
    if (typeof value === "number" && !Number.isFinite(value)) {
      value = null;
    }
    if (typeof value === "string") {
      // Скалярное поле занимает остаток бюджета, но не больше лимита строки context:
      // иначе один длинный providerMessage резался бы до 256 B при свободном месте.
      const keyBytes = Buffer.byteLength(entry.key, "utf8");
      const allowance = Math.max(
        16,
        Math.min(CONTEXT_STRING_MAX_BYTES, maxBytes - used - keyBytes - 8),
      );
      value = truncateUtf8Text(value, allowance);
    }
    const cost = jsonEntryCost(entry.key, value);
    if (used + cost > maxBytes) {
      // Не влезло: пропускаем именно это поле, но даём шанс более дешёвым следующим.
      continue;
    }
    result[entry.key] = value;
    used += cost;
  }

  const state: ContextCloneState = {
    remainingBytes: Math.max(0, maxBytes - used),
    remainingNodes: CONTEXT_MAX_NODES,
    seen: new WeakSet(),
    truncated: false,
  };
  for (const entry of nestedEntries) {
    if (entry.key === "__proto__") continue;
    if (state.remainingBytes <= 16) break;
    const cloned = cloneContextValue(entry.value, state, 0);
    if (cloned === undefined) continue;
    const cost = jsonEntryCost(entry.key, cloned);
    if (used + cost > maxBytes) break;
    result[entry.key] = cloned;
    used += cost;
    state.remainingBytes = Math.max(0, maxBytes - used);
  }

  // compactContext вызывается только когда context уже не влез целиком, поэтому
  // маркер ставится безусловно.
  result[CONTEXT_TRUNCATED_KEY] = true;

  // JSON-экранирование оценено приблизительно, поэтому хвост удаляется до тех пор,
  // пока фактическая сериализация не уложится в бюджет (маркер сохраняется).
  while (Object.keys(result).length > 1 && utf8JsonBytes(result) > maxBytes) {
    const removable = Object.keys(result).filter((key) => key !== CONTEXT_TRUNCATED_KEY);
    const lastKey = removable.pop();
    if (lastKey === undefined) break;
    delete result[lastKey];
  }
  return result;
}

/**
 * Финальная страховка кадра: считает байты уже собранного JSON и детерминированно
 * сжимает его, пока не уложится в {@link LOG_ERROR_FRAME_MAX_BYTES}. Вложенные
 * массивы/объекты не могут обойти бюджет, потому что измеряется итоговая строка.
 */
function fitErrorFrameToBudget(
  frame: SerializedLogError,
  maxBytes = LOG_ERROR_FRAME_MAX_BYTES,
): SerializedLogError {
  let current = frame;
  if (errorFrameBytes(current) <= maxBytes) {
    return current;
  }

  // Ограничение итераций защищает от циклического cause, если кадр пришёл не из
  // `serializeLogError`, а от кастомного redactor, сохранившего ссылку на себя.
  let causeDrops = 0;
  while (
    current.cause !== undefined &&
    causeDrops <= ERROR_MAX_CAUSE_DEPTH + 1 &&
    errorFrameBytes(current) > maxBytes
  ) {
    const dropped = dropDeepestCause(current);
    if (dropped === current) break;
    current = dropped;
    causeDrops += 1;
  }
  if (errorFrameBytes(current) <= maxBytes) {
    return current;
  }

  current = mapFrameChain(current, (item) => {
    if (item.stack === undefined) {
      return item;
    }
    const { stack: _stack, ...rest } = item;
    return addContextMarker(rest, "stackTruncated");
  });
  if (errorFrameBytes(current) <= maxBytes) {
    return current;
  }

  current = mapFrameChain(current, (item) =>
    item.context === undefined || utf8JsonBytes(item.context) <= ERROR_CONTEXT_MIN_BYTES
      ? item
      : { ...item, context: compactContext(item.context, ERROR_CONTEXT_MIN_BYTES) },
  );
  if (errorFrameBytes(current) <= maxBytes) {
    return current;
  }

  current = mapFrameChain(current, (item) =>
    Buffer.byteLength(item.message, "utf8") > ERROR_MESSAGE_MIN_BYTES
      ? { ...item, message: truncateUtf8Text(item.message, ERROR_MESSAGE_MIN_BYTES) }
      : item,
  );
  if (errorFrameBytes(current) <= maxBytes) {
    return current;
  }

  current = mapFrameChain(current, (item) => {
    if (item.context === undefined) {
      return item;
    }
    const { context: _context, ...rest } = item;
    return rest;
  });
  if (errorFrameBytes(current) <= maxBytes) {
    return current;
  }

  // Крайний случай: сохраняем identity корня и marker. Если cause был, его исчезновение
  // тоже помечаем, чтобы усечение цепочки не выглядело как её отсутствие.
  const minimalContext: Record<string, unknown> = { [LOG_FRAME_TRUNCATED_KEY]: true };
  if (current.cause !== undefined) {
    minimalContext.causeTruncated = true;
  }
  // code/type — идентификаторы ошибки для сопоставления бизнес-кодов; они уже
  // ограничены 256 B, поэтому сохраняем их, пока кадр укладывается.
  const withIdentity: SerializedLogError = {
    name: boundIdentityText(current.name, 64),
    message: boundIdentityText(current.message, ERROR_MESSAGE_MIN_BYTES),
    context: minimalContext,
  };
  if (current.code !== undefined) withIdentity.code = current.code;
  if (current.type !== undefined) withIdentity.type = current.type;
  if (errorFrameBytes(withIdentity) <= maxBytes) {
    return withIdentity;
  }

  // Крайний кадр: identity + маркер, без code/type.
  const minimal: SerializedLogError = {
    name: boundIdentityText(current.name, 64),
    message: boundIdentityText(current.message, ERROR_MESSAGE_MIN_BYTES),
    context: minimalContext,
  };
  return errorFrameBytes(minimal) <= maxBytes
    ? minimal
    : {
        name: "ErrorLogTruncated",
        message: "Error log frame exceeded the serialization byte budget.",
      };
}

function dropDeepestCause(frame: SerializedLogError, depth = 0): SerializedLogError {
  // Кадр может прийти не из `serializeLogError` (кастомный redactor мог сохранить
  // ссылку на себя), поэтому рекурсия ограничена явно.
  if (frame.cause === undefined || depth > ERROR_MAX_CAUSE_DEPTH + 1) {
    const { cause: _cause, ...rest } = frame;
    return addContextMarker(rest, "causeTruncated");
  }
  if (frame.cause.cause === undefined) {
    const { cause: _cause, ...rest } = frame;
    return addContextMarker(rest, "causeTruncated");
  }
  return { ...frame, cause: dropDeepestCause(frame.cause, depth + 1) };
}

function addContextMarker(frame: SerializedLogError, key: string): SerializedLogError {
  return {
    ...frame,
    context: { ...(frame.context ?? {}), [key]: true },
  };
}

function mapFrameChain(
  frame: SerializedLogError,
  transform: (item: SerializedLogError) => SerializedLogError,
  depth = 0,
): SerializedLogError {
  const transformed = transform(frame);
  const cause = transformed.cause;
  if (cause === undefined) {
    return transformed;
  }
  if (depth > ERROR_MAX_CAUSE_DEPTH + 1) {
    // Циклический/слишком глубокий cause (возможен при кастомном redactor):
    // обрываем цепочку явным маркером вместо переполнения стека. Остальные поля
    // кадра сохраняем — они уже прошли трансформацию.
    const { cause: _cause, ...rest } = transformed;
    return addContextMarker(rest, "causeTruncated");
  }
  return { ...transformed, cause: mapFrameChain(cause, transform, depth + 1) };
}

/**
 * Страховка уровня строки: после редакции измеряется сериализованная запись целиком.
 * Сначала сжимается payload-context и message, затем удаляется context; error-кадр уже
 * ограничен `serializeLogError`, поэтому до минимальной записи дело доходит редко.
 */
function boundSerializedEntryLine(entry: SerializableLogEntry): SerializableLogEntry {
  if (utf8JsonBytes(entry) <= LOG_LINE_MAX_BYTES) {
    return entry;
  }

  let candidate: SerializableLogEntry = entry;

  // Шаг 1: ужимаем именно error-кадр под остаток строки. Иначе следующий шаг удалил бы
  // payload-context журнала, хотя виноват был большой cause/context ошибки.
  const fitted = fitEntryErrorFrame(candidate);
  if (fitted !== undefined) {
    candidate = fitted;
    if (utf8JsonBytes(candidate) <= LOG_LINE_MAX_BYTES) {
      return candidate;
    }
  }

  // Шаг 2: сжимаем payload-context журнала, но только если он сам превышает свой
  // бюджет — иначе маркер `contextTruncated` появился бы на нетронутом контексте.
  if (
    candidate.context !== undefined &&
    utf8JsonBytes(candidate.context) > LINE_CONTEXT_MAX_BYTES
  ) {
    candidate = {
      ...candidate,
      context: compactEntryValue(candidate.context, LINE_CONTEXT_MAX_BYTES),
    };
    // Остаток бюджета мог вырасти — повторяем ужатие error-кадра, чтобы не потерять
    // identity ошибки из-за большого payload-context записи.
    const refitted = fitEntryErrorFrame(candidate);
    if (refitted !== undefined) {
      candidate = refitted;
    }
  }
  if (utf8JsonBytes(candidate) <= LOG_LINE_MAX_BYTES) {
    return candidate;
  }

  candidate = {
    ...candidate,
    message: truncateUtf8Text(stringEntryValue(candidate.message), LINE_MESSAGE_MAX_BYTES),
  };
  if (utf8JsonBytes(candidate) <= LOG_LINE_MAX_BYTES) {
    return candidate;
  }

  candidate = {
    ...candidate,
    message: truncateUtf8Text(stringEntryValue(candidate.message), LINE_MESSAGE_MIN_BYTES),
  };
  if (utf8JsonBytes(candidate) <= LOG_LINE_MAX_BYTES) {
    return candidate;
  }

  const { context: _context, ...withoutContext } = candidate;
  candidate = { ...withoutContext, [LOG_LINE_TRUNCATED_KEY]: true };
  if (utf8JsonBytes(candidate) <= LOG_LINE_MAX_BYTES) {
    return candidate;
  }

  // Поля-идентификаторы записи тоже строки от вызывающего кода и тоже режутся:
  // иначе огромный traceId/sessionId снова вывел бы строку за бюджет.
  const minimal: SerializableLogEntry = {
    timestamp: boundIdentityValue(candidate.timestamp, 64),
    level: boundIdentityValue(candidate.level, 32),
    event: boundIdentityValue(candidate.event, 256),
    module: boundIdentityValue(candidate.module, 256),
    traceId: boundIdentityValue(candidate.traceId, 128),
    spanId: boundIdentityValue(candidate.spanId, 128),
    parentSpanId: boundIdentityValue(candidate.parentSpanId, 128),
    sessionId: boundIdentityValue(candidate.sessionId, 128),
    turnId: boundIdentityValue(candidate.turnId, 128),
    toolCallId: boundIdentityValue(candidate.toolCallId, 128),
    message: truncateUtf8Text(stringEntryValue(candidate.message), LINE_MESSAGE_MIN_BYTES),
    [LOG_LINE_TRUNCATED_KEY]: true,
  };
  const minimalFrame = coerceSerializedErrorFrame(candidate.error);
  if (minimalFrame !== undefined) {
    minimal.error = {
      name: boundIdentityText(minimalFrame.name, 64),
      message: boundIdentityText(minimalFrame.message, 256),
      context: { [LOG_FRAME_TRUNCATED_KEY]: true },
    };
  }
  if (utf8JsonBytes(minimal) <= LOG_LINE_MAX_BYTES) {
    return minimal;
  }
  // Последняя ступень: ни payload, ни error-кадр не помещаются даже в минимальной
  // форме. Строка остаётся валидной JSONL-записью с явным маркером.
  return {
    level: "error",
    message: "Log entry exceeded the serialization byte budget.",
    [LOG_LINE_TRUNCATED_KEY]: true,
  };
}

function fitEntryErrorFrame(entry: SerializableLogEntry): SerializableLogEntry | undefined {
  const frame = coerceSerializedErrorFrame(entry.error);
  if (frame === undefined) {
    return undefined;
  }
  const overheadBytes = utf8JsonBytes({ ...entry, error: undefined });
  const available = LOG_LINE_MAX_BYTES - overheadBytes - 32;
  if (available < ERROR_CONTEXT_MIN_BYTES) {
    return undefined;
  }
  return { ...entry, error: fitErrorFrameToBudget(frame, available) };
}

/**
 * Приводит redacted-значение из `LogEntry.error` к форме кадра. Кастомный redactor
 * может вернуть не-строки или cause произвольной формы; такие поля отбрасываются,
 * чтобы `fitErrorFrameToBudget` работал с валидным кадром.
 */
function coerceSerializedErrorFrame(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): SerializedLogError | undefined {
  if (!isPlainObject(value) || depth > ERROR_MAX_CAUSE_DEPTH + 1) {
    return undefined;
  }
  // Кастомный redactor мог сохранить циклический cause: без этой проверки обход
  // ушёл бы в рекурсию до переполнения стека.
  if (seen.has(value)) {
    return undefined;
  }
  seen.add(value);
  const frame: SerializedLogError = {
    name: typeof value.name === "string" ? value.name : "Error",
    message: typeof value.message === "string" ? value.message : "",
  };
  if (typeof value.code === "string") frame.code = value.code;
  if (typeof value.type === "string") frame.type = value.type;
  if (typeof value.stack === "string") frame.stack = value.stack;
  if (isPlainObject(value.context)) frame.context = value.context;
  const cause = coerceSerializedErrorFrame(value.cause, depth + 1, seen);
  if (cause !== undefined) frame.cause = cause;
  return frame;
}

function compactEntryValue(value: unknown, maxBytes: number): unknown {
  if (isPlainObject(value)) {
    return compactContext(value, maxBytes);
  }
  const state: ContextCloneState = {
    remainingBytes: maxBytes,
    remainingNodes: CONTEXT_MAX_NODES,
    seen: new WeakSet(),
    truncated: false,
  };
  return cloneContextValue(value, state, 0);
}

function stringEntryValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return value === undefined ? "" : String(value);
}

function boundIdentityValue(value: unknown, maxBytes: number): unknown {
  return typeof value === "string" ? boundIdentityText(value, maxBytes) : value;
}

function truncateUtf8Text(value: string, maxBytes: number): string {
  const originalBytes = Buffer.byteLength(value, "utf8");
  if (originalBytes <= maxBytes) {
    return value;
  }

  const marker = ` [truncated: ${originalBytes} bytes]`;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (markerBytes >= maxBytes) {
    return TRUNCATED_VALUE;
  }
  const bytes = Buffer.from(value, "utf8");
  let end = Math.min(bytes.length, maxBytes - markerBytes);
  // Откат по continuation-byte: многобайтный UTF-8 символ не разрезается.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }
  return `${bytes.subarray(0, end).toString("utf8")}${marker}`;
}

/**
 * Обрезает identity-поля (code/type) без маркера: маркер внутри бизнес-кода сломал бы
 * его сопоставление. Факт усечения виден по длине в диагностике.
 */
function boundIdentityText(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) {
    return value;
  }
  let end = maxBytes;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }
  return bytes.subarray(0, end).toString("utf8");
}

function jsonEntryCost(key: string, value: unknown): number {
  // Стоимость пары key:value с запятой: JSON.stringify({key:value}) минус скобки ({}
  // дают 2 байта, запятая в реальном объекте — 1).
  return utf8JsonBytes({ [key]: value }) - 1;
}

function errorFrameBytes(frame: SerializedLogError): number {
  return utf8JsonBytes(frame);
}

function utf8JsonBytes(value: unknown): number {
  try {
    // JSON.stringify может вернуть undefined (например, для функции/символа),
    // хотя lib.d.ts объявляет только string; сравнение приведено явно.
    const serialized = JSON.stringify(value) as string | undefined;
    return serialized === undefined ? 0 : Buffer.byteLength(serialized, "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function stringProperty(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isObjectLike(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}
