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

  runtime.logger?.error(`${params.logLabel} failed`, coreError, {
    ...traceContextToLogContext(traceContext),
    event: params.logEvent,
    module: "core.runtime",
    status: cancelled ? "cancelled" : "failed",
    turnPhase,
  });
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
