import {
  CoreErrorType,
  SessionEventType,
  createCoreError,
  createModelUsageSummaryFromEvents,
  isCoreError,
  traceContextToLogContext,
} from "../deps.js";
import type { SessionEvent, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  ErrorPayloadRole,
  projectExecutionErrorPayload,
  withErrorPayloadRole,
  type ExecutionErrorPayloadProjection,
} from "../../errors/error-payload.js";
import { isModelContextExceededError } from "./model-errors.js";

const SWARM_CRASH_BOUNDARY_ENV = "ZCODE_E2E_SWARM_CRASH_BOUNDARY";
const SWARM_CRASH_BOUNDARY_HOLD_MS = 1_500;

/**
 * Окно для crash-injection Desktop E2E. Без env сразу возвращает управление:
 * commit графа и резервирование child остаются соседними транзакциями.
 */
export async function holdSwarmCrashBoundary(): Promise<void> {
  if (process.env[SWARM_CRASH_BOUNDARY_ENV] !== "1") return;
  await new Promise((resolve) => setTimeout(resolve, SWARM_CRASH_BOUNDARY_HOLD_MS));
}

export const SWARM_RECONCILED_COMPLETION_RESULT =
  "Дочерняя сессия уже завершилась до перезапуска. Журнал зафиксировал этот факт по lastOutcome; текст транскрипта в результат узла не копировался.";

export const SWARM_RECONCILED_RESULT_MAX_CHARS = 4_000;

export interface ChildTranscriptMessage {
  info: { role: string };
  parts: readonly { type: string; text?: string; ignored?: boolean }[];
}

/** Последняя assistant-реплика: только text-части. Tool, reasoning и user prompt не входят. */
export function childAssistantResultText(
  messages: readonly ChildTranscriptMessage[],
): string | undefined {
  let latest = "";
  for (const message of messages) {
    if (message.info.role !== "assistant") continue;
    const chunks: string[] = [];
    for (const part of message.parts) {
      if (part.type !== "text" || part.ignored) continue;
      const text = part.text?.trim();
      if (text) chunks.push(text);
    }
    if (chunks.length > 0) latest = chunks.join("\n\n");
  }
  if (!latest) return undefined;
  return latest.length > SWARM_RECONCILED_RESULT_MAX_CHARS
    ? latest.slice(0, SWARM_RECONCILED_RESULT_MAX_CHARS)
    : latest;
}

export interface SwarmRestartClassification {
  pendingNodeIds: string[];
  completedNodeIds: string[];
}

/** Узел без попытки считается pending только когда каждая зависимость уже completed или тоже pending. */
export function classifySwarmRestartNodes(
  nodes: readonly { id: string; depends_on?: readonly string[] }[] | undefined,
  attempts: readonly { nodeID: string; attemptNo: number; status: string }[],
): SwarmRestartClassification {
  const latest = new Map<string, { attemptNo: number; status: string }>();
  for (const attempt of attempts) {
    const current = latest.get(attempt.nodeID);
    if (!current || attempt.attemptNo >= current.attemptNo) latest.set(attempt.nodeID, attempt);
  }
  const completed = new Set<string>();
  for (const [nodeID, attempt] of latest) {
    if (attempt.status === "completed") completed.add(nodeID);
  }
  const pending = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes ?? []) {
      if (latest.has(node.id) || pending.has(node.id)) continue;
      const ready = (node.depends_on ?? []).every(
        (dependencyId) => completed.has(dependencyId) || pending.has(dependencyId),
      );
      if (!ready) continue;
      pending.add(node.id);
      changed = true;
    }
  }
  return {
    pendingNodeIds: (nodes ?? []).flatMap((node) => (pending.has(node.id) ? [node.id] : [])),
    completedNodeIds: [...completed],
  };
}

export { projectExecutionErrorPayload } from "../../errors/error-payload.js";

interface TurnAbortScope {
  dispose: () => void;
  abort: (reason?: unknown) => void;
  signal: AbortSignal;
}

const EXTERNAL_TURN_FAULT_MARKER = "zcode.externalTurnFault";

interface ExternalTurnFaultError extends Error {
  code: string;
  zcodeTurnFault: typeof EXTERNAL_TURN_FAULT_MARKER;
}

/** 宿主用此窄入口中止 turn，同时要求 core 持久化 TurnError 而不是用户取消。 */
export function createExternalTurnFaultError(code: string, message = code): Error {
  return Object.assign(new Error(message), {
    code,
    zcodeTurnFault: EXTERNAL_TURN_FAULT_MARKER as typeof EXTERNAL_TURN_FAULT_MARKER,
  }) satisfies ExternalTurnFaultError;
}

function findExternalTurnFault(error: unknown): ExternalTurnFaultError | null {
  let current = error;
  const seen = new WeakSet<object>();
  for (let depth = 0; depth <= 6; depth += 1) {
    if (!current || typeof current !== "object" || seen.has(current)) return null;
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (
      record.zcodeTurnFault === EXTERNAL_TURN_FAULT_MARKER &&
      typeof record.code === "string" &&
      current instanceof Error
    ) {
      return current as ExternalTurnFaultError;
    }
    current = record.cause;
  }
  return null;
}

export function createTurnAbortScope(parentSignal?: AbortSignal): TurnAbortScope {
  const controller = new AbortController();

  const abortTurn = () => {
    if (!controller.signal.aborted) {
      controller.abort(parentSignal?.reason);
    }
  };
  const abort = (reason?: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };

  if (parentSignal?.aborted) {
    abortTurn();
    return { abort, dispose: () => {}, signal: controller.signal };
  }

  parentSignal?.addEventListener("abort", abortTurn, { once: true });

  return {
    abort,
    dispose: () => {
      parentSignal?.removeEventListener("abort", abortTurn);
    },
    signal: controller.signal,
  };
}

export function throwIfTurnAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw createTurnCancelledError(signal.reason);
}

export function createTurnFailureError(
  error: unknown,
  abortSignal: AbortSignal | undefined,
  fallbackMessage: string,
) {
  const externalFault = findExternalTurnFault(abortSignal?.reason) ?? findExternalTurnFault(error);
  if (externalFault) {
    return createCoreError(CoreErrorType.UnknownError, externalFault.message, {
      cause: externalFault,
      recoverable: true,
    });
  }
  if (isTurnCancellationError(error, abortSignal)) {
    return createTurnCancelledError(error);
  }

  if (
    isCoreError(error) &&
    (error.type === CoreErrorType.ModelContextExceeded ||
      (fallbackMessage === "Turn execution failed" && error.type === CoreErrorType.ModelError))
  ) {
    return error;
  }

  if (isModelContextExceededError(error)) {
    return createCoreError(
      CoreErrorType.ModelContextExceeded,
      "Model request exceeded the provider context window.",
      { cause: error instanceof Error ? error : undefined, recoverable: true, retryable: true },
    );
  }

  return createCoreError(CoreErrorType.UnknownError, fallbackMessage, {
    cause: error instanceof Error ? error : undefined,
    // turn 级 UnknownError 只是统一生命周期包装；UI/error payload
    // 需要展示下层 provider/tool 给出的用户可读根因，不能让泛化文案抢占摘要。
    context: withErrorPayloadRole(undefined, ErrorPayloadRole.Wrapper),
  });
}

export function createTurnCancelledError(error: unknown) {
  if (isCoreError(error) && error.type === CoreErrorType.TurnCancelled) {
    return error;
  }

  return createCoreError(CoreErrorType.TurnCancelled, "Turn was cancelled.", {
    cause: error instanceof Error ? error : undefined,
    recoverable: true,
  });
}

const ABORT_REASON_MAX_LENGTH = 240;

/**
 * R06: бюджет одной строки JSONL / support bundle. Core не сериализует неограниченные
 * значения в лог: `logger.error` получает ограниченную проекцию ошибки. Раньше туда
 * уходил сырой `coreError` вместе с cause-цепочкой, а в ней лежал
 * `context.responseBodySummary` с полным request body (prompt/messages/tools).
 * Причина по-прежнему нужна для диагностики (docs/design/v2/logging.md), поэтому
 * каждый кадр сохраняется, но только с allowlist скаляров и байтовыми границами.
 */
export const TURN_ERROR_LOG_MAX_BYTES = 32 * 1024;
/**
 * Строка JSONL содержит не только error: event/module/status, trace-контекст и JSON-обёртку.
 * Оставляем этот запас, чтобы весь сериализованный entry оставался в бюджете.
 */
const TURN_ERROR_LOG_LINE_RESERVE_BYTES = 4 * 1024;
/** Бюджет самой лог-ошибки (один error-объект с cause-цепочкой). */
const TURN_ERROR_LOG_VIEW_MAX_BYTES = TURN_ERROR_LOG_MAX_BYTES - TURN_ERROR_LOG_LINE_RESERVE_BYTES;
/** Каждый кадр ограничен по отдельности, а итоговая цепочка — общим бюджетом строки. */
const TURN_ERROR_LOG_ATTRIBUTION_MAX_BYTES = 1_024;
const TURN_ERROR_LOG_MESSAGE_MAX_BYTES = 1_024;
const TURN_ERROR_LOG_STACK_MAX_BYTES = 1_024;
const TURN_ERROR_LOG_STRING_MAX_BYTES = 256;
const TURN_ERROR_LOG_MIN_MESSAGE_BYTES = 128;
/**
 * R06: name/code/type — identity кадра, а не свободный текст. Без границы провайдерский
 * `code`/`name` в тысячи байт сам выводил строку за 32 KiB и переживал hard fallback.
 */
const TURN_ERROR_LOG_IDENTITY_MAX_BYTES = 128;
const TURN_ERROR_LOG_MAX_CAUSE_DEPTH = 8;
/** Только эти поля ошибки считаются безопасными для лога: они скалярные и низкокардинальные. */
const TURN_ERROR_LOG_CONTEXT_KEYS = [
  "attempt",
  "envKey",
  "errorPhase",
  "exceptionKind",
  "finishReason",
  "maxAttempts",
  "modelId",
  "providerCode",
  "providerErrorCode",
  "providerId",
  "providerKind",
  "providerRequestId",
  "rawFinishReason",
  "reason",
  "responseStatus",
  "retryAfterMs",
  "retryable",
  "source",
  "statusCode",
  "transport",
] as const;

export interface TurnErrorLogView extends Error {
  cause?: TurnErrorLogView;
  code?: string;
  context?: Record<string, unknown>;
  type?: string;
}

/**
 * Маркеры усечения живут в `context`: adapters logging (`serializeLogError`) копирует
 * name/message/code/type/stack/context/cause и не переносит произвольные поля Error,
 * поэтому отдельные флаги на объекте ошибки в JSONL не попали бы.
 */
const TURN_ERROR_LOG_MARKER_KEYS = new Set([
  "causeTruncated",
  "logViewTruncated",
  "stackTruncated",
]);

/**
 * Ошибка для JSONL: name/message/code/type/stack каждого кадра и сокращённый
 * cause-хвост. Значения берутся только из allowlist скалярных полей; объектные
 * payload-ы (`responseBodySummary`, `headers`, `data`, `responseBody`) не копируются.
 */
export function createTurnErrorLogView(
  coreError: ReturnType<typeof createTurnFailureError>,
  projection: ExecutionErrorPayloadProjection,
): TurnErrorLogView {
  const view = buildTurnErrorLogFrame(coreError, projection, new WeakSet<object>(), 0);
  return fitLogViewBudget(view);
}

function buildTurnErrorLogFrame(
  error: unknown,
  projection: ExecutionErrorPayloadProjection | undefined,
  seen: WeakSet<object>,
  depth: number,
): TurnErrorLogView {
  const record = isLoggableObject(error) ? (error as Record<string, unknown>) : undefined;
  if (record) {
    seen.add(record);
  }

  const message = readLogString(record, "message") ?? "";
  const boundedMessage = boundUtf8(
    redactTurnErrorLogText(message),
    TURN_ERROR_LOG_MESSAGE_MAX_BYTES,
  );
  const frame = new Error(boundedMessage ?? "") as TurnErrorLogView;
  frame.name =
    boundUtf8(
      redactTurnErrorLogText(readLogString(record, "name") ?? "Error"),
      TURN_ERROR_LOG_IDENTITY_MAX_BYTES,
    ) ?? "Error";

  const code = readLogScalar(record, "code");
  if (code !== undefined) {
    const boundedCode = boundUtf8(
      redactTurnErrorLogText(String(code)),
      TURN_ERROR_LOG_IDENTITY_MAX_BYTES,
    );
    if (boundedCode !== undefined) frame.code = boundedCode;
  }
  const type = readLogScalar(record, "type");
  if (type !== undefined) {
    const boundedType = boundUtf8(
      redactTurnErrorLogText(String(type)),
      TURN_ERROR_LOG_IDENTITY_MAX_BYTES,
    );
    if (boundedType !== undefined) frame.type = boundedType;
  }

  const stack = readLogString(record, "stack");
  const boundedStack = stack
    ? boundUtf8(redactTurnErrorLogText(stack), TURN_ERROR_LOG_STACK_MAX_BYTES)
    : undefined;
  if (boundedStack) {
    frame.stack = boundedStack;
  } else {
    // new Error() всегда создаёт stack текущего места; без исходного stack
    // синтетический след только вводит в заблуждение и раздувает запись.
    delete frame.stack;
  }

  const context = turnErrorLogContext(record, projection);
  if (context) frame.context = context;

  const cause = record?.cause;
  if (isLoggableObject(cause) && !seen.has(cause)) {
    if (depth + 1 < TURN_ERROR_LOG_MAX_CAUSE_DEPTH) {
      // Проекция последнего кадра уже отдана первому уровню; глубже идёт только
      // безопасная сводка самой ошибки.
      frame.cause = buildTurnErrorLogFrame(cause, undefined, seen, depth + 1);
    } else {
      // Глубина — тоже часть бюджета: обрезаем хвост детерминированно и явно.
      addContextMarker(frame, "causeTruncated");
    }
  }

  return frame;
}

/**
 * Детерминированно укладывает всю цепочку кадров в {@link TURN_ERROR_LOG_MAX_BYTES}.
 * Порядок усечения фиксирован: сначала отбрасывается самый глубокий cause (маркер
 * `causeTruncated` в оставшемся кадре), затем stack (`stackTruncated`), затем хвостовые
 * поля context, затем message. Результат зависит только от входа, поэтому одинаковые
 * ошибки дают одинаковую строку.
 */
function fitLogViewBudget(view: TurnErrorLogView): TurnErrorLogView {
  let truncated = false;
  const markTruncated = (): void => {
    truncated = true;
  };

  // Ограниченное число шагов: каждая операция монотонно уменьшает данные, а жёсткий
  // fallback ниже гарантирует бюджет даже для pathological входа.
  for (let step = 0; step < 256; step += 1) {
    if (turnErrorLogViewBytes(view) > TURN_ERROR_LOG_VIEW_MAX_BYTES) {
      if (dropDeepestCause(view, markTruncated)) continue;
      if (dropStack(view)) {
        markTruncated();
        continue;
      }
      if (dropLastContextValue(view)) {
        markTruncated();
        continue;
      }
      if (shrinkDeepestMessage(view)) {
        markTruncated();
        continue;
      }
      break;
    }
    if (truncated && !view.context?.logViewTruncated) {
      // Маркер добавляется один раз и сам входит в следующий замер бюджета.
      addContextMarker(view, "logViewTruncated");
      continue;
    }
    break;
  }

  if (turnErrorLogViewBytes(view) > TURN_ERROR_LOG_VIEW_MAX_BYTES) {
    // Жёсткий предел: сохраняем только identity ошибки и флаг усечения.
    view.message = "";
    delete view.stack;
    delete view.cause;
    view.context = { logViewTruncated: true };
  }
  return view;
}

function dropDeepestCause(root: TurnErrorLogView, markTruncated: () => void): boolean {
  let parent: TurnErrorLogView = root;
  for (;;) {
    const child = parent.cause;
    if (!child) return false;
    if (!child.cause) {
      delete parent.cause;
      addContextMarker(parent, "causeTruncated");
      markTruncated();
      return true;
    }
    parent = child;
  }
}

function dropStack(root: TurnErrorLogView): boolean {
  const frame = deepestFrameMatching(root, (candidate) => candidate.stack !== undefined);
  if (!frame) return false;
  delete frame.stack;
  addContextMarker(frame, "stackTruncated");
  return true;
}

function dropLastContextValue(root: TurnErrorLogView): boolean {
  const frame = deepestFrameMatching(root, (candidate) => {
    const keys = Object.keys(candidate.context ?? {});
    return keys.some((key) => !TURN_ERROR_LOG_MARKER_KEYS.has(key));
  });
  if (!frame?.context) return false;
  const keys = Object.keys(frame.context).filter((key) => !TURN_ERROR_LOG_MARKER_KEYS.has(key));
  const lastKey = keys[keys.length - 1];
  if (lastKey === undefined) return false;
  delete frame.context[lastKey];
  return true;
}

function shrinkDeepestMessage(root: TurnErrorLogView): boolean {
  const frame = deepestFrameMatching(
    root,
    (candidate) => utf8StringBytes(candidate.message) > TURN_ERROR_LOG_MIN_MESSAGE_BYTES,
  );
  if (!frame) return false;
  const shrunk = boundUtf8(frame.message, TURN_ERROR_LOG_MIN_MESSAGE_BYTES);
  if (!shrunk || shrunk === frame.message) return false;
  frame.message = shrunk;
  return true;
}

function deepestFrameMatching(
  root: TurnErrorLogView,
  predicate: (frame: TurnErrorLogView) => boolean,
): TurnErrorLogView | undefined {
  let deepest: TurnErrorLogView | undefined;
  let current: TurnErrorLogView | undefined = root;
  while (current) {
    if (predicate(current)) deepest = current;
    current = current.cause;
  }
  return deepest;
}

function addContextMarker(frame: TurnErrorLogView, key: string): void {
  frame.context = { ...frame.context, [key]: true };
}

function turnErrorLogViewBytes(view: TurnErrorLogView): number {
  return utf8Bytes(describeTurnErrorLogView(view));
}

/** Форма, которую сериализует adapters logging (`serializeLogError`). */
function describeTurnErrorLogView(view: TurnErrorLogView): Record<string, unknown> {
  return {
    name: view.name,
    message: view.message,
    ...(view.code ? { code: view.code } : {}),
    ...(view.type ? { type: view.type } : {}),
    ...(view.stack ? { stack: view.stack } : {}),
    ...(view.context ? { context: view.context } : {}),
    ...(view.cause ? { cause: describeTurnErrorLogView(view.cause) } : {}),
  };
}

function turnErrorLogContext(
  record: Record<string, unknown> | undefined,
  projection: ExecutionErrorPayloadProjection | undefined,
): Record<string, unknown> | undefined {
  const context: Record<string, unknown> = {};
  const rawContext =
    record && isLoggableObject(record.context)
      ? (record.context as Record<string, unknown>)
      : undefined;
  // Поля одного смысла живут в context ошибки, в самом объекте ошибки
  // (ProviderBusinessError) или в projection. Кардинальность и приватность
  // у них одинаковая, поэтому все источники проходят один allowlist.
  const sources: unknown[] = [rawContext, record, projection?.attribution];
  for (const key of TURN_ERROR_LOG_CONTEXT_KEYS) {
    for (const source of sources) {
      const value = readLogScalar(source, key);
      if (value === undefined) continue;
      if (typeof value === "string") {
        // Маскировка до бюджета: allowlist не делает значение безопасным сам по себе.
        const boundedValue = boundUtf8(
          redactTurnErrorLogText(value),
          TURN_ERROR_LOG_STRING_MAX_BYTES,
        );
        if (boundedValue !== undefined) context[key] = boundedValue;
      } else {
        context[key] = value;
      }
      break;
    }
  }

  // `message` вставляется последним: при нехватке бюджета `fitContextBytes`
  // вытесняет хвост, а `frame.message` уже содержит сообщение самого кадра.
  const projectedMessage = projection
    ? boundUtf8(redactTurnErrorLogText(projection.message), TURN_ERROR_LOG_MESSAGE_MAX_BYTES)
    : undefined;
  if (projectedMessage) context.message = projectedMessage;

  const bounded = fitContextBytes(context, TURN_ERROR_LOG_ATTRIBUTION_MAX_BYTES);
  return Object.keys(bounded).length > 0 ? bounded : undefined;
}

function fitContextBytes(
  context: Record<string, unknown>,
  maxBytes: number,
): Record<string, unknown> {
  const entries = Object.entries(context);
  // Последним оставляем `reason`/`source`: без них запись теряет диагностический смысл,
  // поэтому при нехватке бюджета вытесняются хвостовые поля, а не первые.
  while (entries.length > 1 && utf8Bytes(Object.fromEntries(entries)) > maxBytes) {
    entries.pop();
  }
  return Object.fromEntries(entries);
}

function readLogScalar(source: unknown, key: string): unknown {
  if (!isLoggableObject(source)) return undefined;
  const value = (source as Record<string, unknown>)[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  return value.trim().length > 0 ? value : undefined;
}

function readLogString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isLoggableObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function boundUtf8(value: string, maxBytes: number): string | undefined {
  const originalBytes = utf8StringBytes(value);
  if (originalBytes <= maxBytes) {
    return value;
  }
  const marker = ` [truncated: ${originalBytes} bytes]`;
  const markerBytes = utf8StringBytes(marker);
  if (markerBytes >= maxBytes) {
    return undefined;
  }
  const bytes = Buffer.from(value, "utf8");
  let end = Math.min(bytes.length, maxBytes - markerBytes);
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }
  return `${bytes.subarray(0, end).toString("utf8")}${marker}`;
}

/**
 * R06: маскировка до усечения. Порядок обязателен: если сначала обрезать по бюджету,
 * первые байты `Authorization: Bearer …` останутся в префиксе и секрет попадёт в JSONL.
 * Редактор логгера работает по именам ключей, поэтому свободный текст ошибки должен
 * очищаться здесь, у владельца проекции (docs/specs/2026-11-11-error-redaction.md).
 */
function redactTurnErrorLogText(value: string): string {
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

function utf8StringBytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function utf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
// abort(reason) 可能是 Error、字符串或任意值；协议只接受一行人类可读摘要。
// 这里只取 message（绝不带 stack），压平空白并截断，避免把对象序列化进事件。
export function readAbortReasonText(reason: unknown): string | undefined {
  const raw =
    typeof reason === "string" ? reason : reason instanceof Error ? reason.message : undefined;
  const text = raw?.replace(/\s+/gu, " ").trim().slice(0, ABORT_REASON_MAX_LENGTH);
  if (!text) return undefined;
  return text;
}

// 用户主动中断（TurnCancelled）属于正常结束，不应记为错误。turn/compact/rewind 三处 catch
// 之前都无条件 emit TurnError，会被 reducer/UI/桌面统一映射成 turn.failed（status:error、追加错误消息）。
// 这里统一收口：取消时改发 TurnComplete(resultType:"cancelled") 让状态干净回到 idle，真实错误才发 TurnError。
// 调用方仍负责向上 throw coreError 与记录 usage。
export async function appendTurnOutcomeEvent(
  runtime: AgentRuntimeInternal,
  params: {
    coreError: ReturnType<typeof createTurnFailureError>;
    events: SessionEvent[];
    durationMs: number;
    turnPhase: string;
    inputId?: string;
    highspeedCardId?: string;
    highspeedFallbackUnavailable?: boolean;
    traceContext: TraceContext;
    fallbackMessage: string;
    logEvent: string;
    logLabel: string;
    preserveQueueAutoDrainOnCancel?: boolean;
    // 中断原因原文（stopActiveForegroundExecution 的 reason）：投影据此区分
    // 用户停止 / 预算耗尽 / 会话抢占 / 真实错误，避免 UI 只显示裸 “Stopped”。
    abortReason?: string;
    backgroundSubagentResultConsumed?: boolean;
    workflowResultConsumed?: boolean;
    historyRoundCount?: number;
  },
): Promise<void> {
  const { coreError, events, traceContext, turnPhase, inputId } = params;
  const cancelled = coreError.type === CoreErrorType.TurnCancelled;
  const externalFault = findExternalTurnFault(coreError);
  const projectedError = projectExecutionErrorPayload(coreError, params.fallbackMessage);

  const outcomeEvent = cancelled
    ? runtime.createEvent(
        SessionEventType.TurnComplete,
        {
          response: "",
          tokenCount: 0,
          usage: createModelUsageSummaryFromEvents(events),
          toolCallCount: 0,
          historyRoundCount: params.historyRoundCount ?? 0,
          duration: params.durationMs,
          resultType: "cancelled",
          inputId,
          ...(params.backgroundSubagentResultConsumed
            ? { backgroundSubagentResultConsumed: true }
            : {}),
          ...(params.workflowResultConsumed ? { workflowResultConsumed: true } : {}),
          ...(params.preserveQueueAutoDrainOnCancel
            ? { preserveQueueAutoDrainOnCancel: true }
            : {}),
          ...(params.abortReason ? { abortReason: params.abortReason } : {}),
        },
        traceContext,
      )
    : runtime.createEvent(
        SessionEventType.TurnError,
        {
          error: {
            type: externalFault?.code ?? coreError.type,
            // coreError.message 常是泛化文案，真实 provider/network 原因藏在 cause 链里；
            // 写入可读 payload fields 让桌面端和恢复链路都能展示根因。
            ...projectedError,
            attribution: {
              ...projectedError.attribution,
              // Bug 根因：创建期尚无 userInput 行。每个新错误都发布 string/null，
              // 让 Renderer 区分“普通轮”与“旧 Agent 没有该字段”。
              highspeedCardId: params.highspeedCardId ?? null,
              // 无处可退时没有 fallback 事件，且请求期失败的 code 是 provider 错误码（如 3402），
              // Renderer 不能按错误码推断退卡；由 Core 把“已归因且无处可退”作为结构化事实发布。
              ...(params.highspeedFallbackUnavailable
                ? { highspeedFallbackUnavailable: true }
                : {}),
            },
            stack: coreError.stack,
          },
          turnPhase,
          inputId,
          ...(params.backgroundSubagentResultConsumed
            ? { backgroundSubagentResultConsumed: true }
            : {}),
          ...(params.workflowResultConsumed ? { workflowResultConsumed: true } : {}),
        },
        traceContext,
      );
  await runtime.appendEvent(outcomeEvent, traceContext);
  events.push(outcomeEvent);

  runtime.logger?.error(
    `${params.logLabel} failed`,
    // R06: сырой coreError несёт cause-цепочку с provider body (prompt/messages/tools).
    // В JSONL уходит только ограниченная проекция с безопасными кадрами cause;
    // TurnError payload и projectExecutionErrorPayload не меняются.
    createTurnErrorLogView(coreError, projectedError),
    {
      ...traceContextToLogContext(traceContext),
      event: params.logEvent,
      module: "core.runtime",
      status: cancelled ? "cancelled" : "failed",
      turnPhase,
    },
  );
}

export function isTurnCancellationError(error: unknown, abortSignal?: AbortSignal): boolean {
  if (findExternalTurnFault(abortSignal?.reason) || findExternalTurnFault(error)) return false;
  if (abortSignal?.aborted) return true;

  let current = error;
  const seen = new WeakSet<object>();
  for (let depth = 0; depth <= 6; depth += 1) {
    if (current === undefined || current === null) return false;
    if (typeof current !== "object") return false;
    if (seen.has(current)) return false;
    seen.add(current);

    if (isCoreError(current) && current.type === CoreErrorType.TurnCancelled) {
      return true;
    }

    const record = current as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : undefined;
    const code = typeof record.code === "string" ? record.code : undefined;
    const name = typeof record.name === "string" ? record.name : undefined;
    if (
      type === CoreErrorType.TurnCancelled ||
      code === CoreErrorType.TurnCancelled ||
      code === "MODEL_REQUEST_CANCELLED" ||
      code === "model_request_cancelled" ||
      code === "ABORT_ERR" ||
      name === "AbortError"
    ) {
      return true;
    }

    current = record.cause;
  }

  return false;
}
