// Subagent runner: запуск child runtime, watchdog и готовность сессии.

import {
  AgentErrorCode,
  CoreErrorType,
  createCoreError,
  isCoreError,
  traceContextToLogContext,
  type AgentCompletedOutput,
  type Logger,
  type SessionEvent,
  type SubagentRunOptions,
  type SubagentRunRequest,
} from "@zcode/contracts";
import {
  resolveSubagentMaxParallel,
  isTerminalRuntimeTask,
  type RuntimeTaskMessageSink,
  type RuntimeTaskRegistry,
} from "../runtime-task/registry.js";
import type { ExploreSubagentPortOptions, SubagentLifecycle, CompletedAgentRun } from "./runner-types.js";
import { resolveAllowedTools } from "./runner-admission.js";
import { aggregateModelUsage, resolveSubagentToolUseCount } from "./runner-artifacts.js";
import {
  finalizeBackgroundCompletion,
  finalizeBackgroundFailure,
  finalizeBackgroundStopped,
} from "./runner-finalize.js";
import { resolveChildMaxParallel } from "./runner-parallel.js";
import {
  deriveWorkResult,
  parsePresentationBlock,
  collectWorkResultClaims,
} from "./runner-work-result.js";

/**
 * Дефолтный watchdog бездействия субагента.
 *
 * Выровнен с `DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS` (600_000): субагент, не публикующий
 * событий дольше одного idle-окна модели, считается зависшим. Значение сознательно
 * дублируется, а не импортируется: core не должен зависеть от config-слоя, но обязан
 * оставаться совместимым по смыслу. Явный `inactivityTimeoutMs: 0` отключает watchdog.
 */
export const DEFAULT_SUBAGENT_INACTIVITY_TIMEOUT_MS = 600_000;

export async function runAgentToCompletion(
  options: ExploreSubagentPortOptions,
  request: SubagentRunRequest,
  lifecycle: SubagentLifecycle,
  registry: RuntimeTaskRegistry,
  runOptions?: SubagentRunOptions,
  monitorOptions: { reportActivity?: () => void } = {},
  executionOptions: SubagentExecutionOptions = {},
): Promise<CompletedAgentRun> {
  let evidenceCursor: number | undefined;
  if (registry.get(lifecycle.agentId)?.prismTaskContract && options.getChildEventCursor) {
    try {
      evidenceCursor = await options.getChildEventCursor(lifecycle.childSessionId);
    } catch {
      // A verifier cannot infer success when it cannot establish the event-log boundary.
      evidenceCursor = undefined;
    }
  }
  let sessionReady = false;
  let resolvedReasoningLevel: string | undefined;
  const notifySessionReady = async (info?: { reasoningLevel?: string }) => {
    if (info?.reasoningLevel) resolvedReasoningLevel = info.reasoningLevel;
    if (sessionReady) return;
    if (runOptions?.signal?.aborted) {
      throw runOptions.signal.reason ?? new Error("Subagent startup aborted before readiness");
    }
    await executionOptions.onSessionReady?.(info);
    if (runOptions?.signal?.aborted) {
      throw runOptions.signal.reason ?? new Error("Subagent startup aborted before readiness");
    }
    sessionReady = true;
  };
  const taskSnapshot = registry.get(lifecycle.agentId);
  const rootSessionId = taskSnapshot?.rootSessionId ?? request.sessionId;
  const activeCap =
    (taskSnapshot?.rootRunId === undefined
      ? undefined
      : registry.getRootRunMaxParallel?.(taskSnapshot.rootRunId)) ??
    resolveSubagentMaxParallel(options.maxParallel);
  const childMaxParallel = resolveChildMaxParallel({
    ...(registry.getActiveSubagentWorkItemCount === undefined
      ? {}
      : { activeCount: registry.getActiveSubagentWorkItemCount(rootSessionId) }),
    ...(taskSnapshot === undefined
      ? {}
      : { parentOccupiesSlot: registry.isActiveSubagentWorkItem?.(lifecycle.agentId) === true }),
    activeCap,
  });
  const childResult = await options.runExploreAgent(
    {
      agentId: lifecycle.agentId,
      agentType: request.agentType,
      allowedTools: resolveAllowedTools(lifecycle.profile, options),
      // 显式 background Agent 的 child tool 会被镜像到父会话；
      // 过去丢失这个来源会让父 turn 把仍在运行的 child tool 误当前台孤儿收口。这里必须
      // 保留 getter，foreground 后续转后台时，每条 mirror event 才会读取 registry 当前值，
      // 而不是继续携带 child 启动时的 false 快照。
      get background() {
        return registry.get(lifecycle.agentId)?.isBackgrounded === true;
      },
      disallowedTools: lifecycle.profile.disallowedTools,
      sessionId: lifecycle.childSessionId,
      description: request.description,
      maxTurns: lifecycle.profile.maxTurns,
      onSessionReady: notifySessionReady,
      permissionMode: lifecycle.profile.permissionMode,
      prompt: request.prompt,
      profile: lifecycle.profile,
      registerMessageSink: createMessageSinkRegistration(options, lifecycle, registry),
      reportActivity: monitorOptions.reportActivity,
      resumeFromStore: executionOptions.resumeFromStore,
      systemPrompt: lifecycle.profile.systemPrompt,
      ...(childMaxParallel === undefined ? {} : { maxParallel: childMaxParallel }),
      ...(taskSnapshot?.level === undefined ? {} : { level: taskSnapshot.level }),
      ...(request.effort === undefined ? {} : { effort: request.effort }),
      ...(request.effortAboveParent === undefined
        ? {}
        : { effortAboveParent: request.effortAboveParent }),
      workingDirectory: request.workingDirectory,
      workspaceRoot: request.workspaceRoot,
      ...(request.writePaths === undefined ? {} : { writePaths: request.writePaths }),
      traceContext: lifecycle.childTraceContext,
    },
    runOptions,
  );
  // Тестовые реализации порта могут не вызвать readiness hook; реальный runtime
  // вызывает его после persist. Уровень берём из результата как fallback.
  if (!resolvedReasoningLevel) resolvedReasoningLevel = childResult.reasoningLevel;
  await notifySessionReady();

  let evidenceEvents: SessionEvent[] = [];
  if (evidenceCursor !== undefined && options.getChildEventsAfter) {
    try {
      evidenceEvents = await options.getChildEventsAfter(lifecycle.childSessionId, evidenceCursor);
    } catch (error) {
      options.logger?.warn("PRISM verifier could not read child events", {
        event: "subagent.prism.child_events_unavailable",
        module: "core.subagent",
        taskId: lifecycle.agentId,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const usage = aggregateModelUsage(childResult.events);
  const totalTokens = usage?.totalTokens;
  const totalToolUseCount = resolveSubagentToolUseCount(childResult.events);
  const totalDurationMs = Date.now() - lifecycle.startedAt;
  const workResult = deriveWorkResult({
    text: childResult.response,
    events: childResult.events,
    durationMs: totalDurationMs,
    toolUses: totalToolUseCount,
    ...(totalTokens === undefined ? {} : { tokens: totalTokens }),
    claims: collectWorkResultClaims(registry, registry.get(lifecycle.agentId)),
  });
  // Причина: presentation — пользовательский конверт, который формирует только start.
  // Worker-роли и DAG-узлы (internalSwarmNodeID) не парсятся, даже если блок попал в текст.
  const presentation =
    request.agentType === "start" && runOptions?.internalSwarmNodeID === undefined
      ? parsePresentationBlock(childResult.response)
      : undefined;

  const output: AgentCompletedOutput = {
    status: "completed",
    agentId: lifecycle.agentId,
    agentType: request.agentType,
    description: request.description,
    prompt: request.prompt,
    content: [
      {
        type: "text",
        text: childResult.response,
      },
    ],
    totalToolUseCount,
    totalDurationMs,
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(resolvedReasoningLevel ? { reasoningLevel: resolvedReasoningLevel } : {}),
    ...(usage === undefined ? {} : { usage }),
    workResult,
    ...(presentation === undefined ? {} : { presentation }),
  };

  return { events: childResult.events, evidenceEvents, output };
}

export function createSubagentActivityWatchdog(options: {
  abort: (reason?: unknown) => void;
  lifecycle: SubagentLifecycle;
  logger?: Logger;
  request: SubagentRunRequest;
  signal: AbortSignal;
  timeoutMs: number;
}): {
  reportActivity: () => void;
  start: () => void;
  stop: () => void;
} {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    return {
      reportActivity: () => {},
      start: () => {},
      stop: () => {},
    };
  }

  let lastActivityAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const schedule = () => {
    stop();
    if (options.signal.aborted) return;
    timer = setTimeout(() => {
      const idleMs = Date.now() - lastActivityAt;
      const error = createCoreError(
        CoreErrorType.ToolTimeout,
        `Subagent was inactive for ${options.timeoutMs}ms`,
        {
          context: {
            code: AgentErrorCode.CHILD_RUNTIME_FAILED,
            agentId: options.lifecycle.agentId,
            agentType: options.request.agentType,
            idleMs,
            parentToolCallId: options.request.parentToolCallId,
            timeoutMs: options.timeoutMs,
          },
          recoverable: true,
          retryable: true,
        },
      );
      options.logger?.warn("Explore subagent activity watchdog fired", {
        ...traceContextToLogContext(options.lifecycle.runTraceContext),
        agentId: options.lifecycle.agentId,
        agentType: options.request.agentType,
        event: "subagent.activity_timeout",
        idleMs,
        module: "core.subagent",
        parentToolCallId: options.request.parentToolCallId,
        status: "failed",
        timeoutMs: options.timeoutMs,
      });
      options.abort(error);
    }, options.timeoutMs);
  };

  const reportActivity = () => {
    lastActivityAt = Date.now();
    schedule();
  };

  return {
    reportActivity,
    start: reportActivity,
    stop,
  };
}

export function guardSubagentPromiseWithAbort<T>(
  promise: Promise<T>,
  request: SubagentRunRequest,
  lifecycle: SubagentLifecycle,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;

  // 子运行时或模型适配器在 abort 后可能永不 settle；外层 Agent 必须自己监听
  // 父 signal，否则 `Agent` 工具会一直停在 running，直到用户手动 Stop。
  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abortHandler);
      callback();
    };

    const abortHandler = () => {
      if (isCoreError(signal.reason)) {
        settle(() => reject(signal.reason));
        return;
      }
      settle(() =>
        reject(
          createCoreError(
            CoreErrorType.ToolCancelled,
            "Agent was cancelled before the subagent returned findings or background launch completed",
            {
              cause: signal.reason instanceof Error ? signal.reason : undefined,
              context: {
                code: AgentErrorCode.CHILD_RUNTIME_FAILED,
                agentId: lifecycle.agentId,
                agentType: request.agentType,
                parentToolCallId: request.parentToolCallId,
              },
              recoverable: true,
            },
          ),
        ),
      );
    };

    promise.then(
      (completed) => settle(() => resolve(completed)),
      (error: unknown) => settle(() => reject(error)),
    );

    if (signal.aborted) {
      abortHandler();
      return;
    }
    signal.addEventListener("abort", abortHandler, { once: true });
  });
}

export async function runBackgroundAgent(
  options: ExploreSubagentPortOptions,
  request: SubagentRunRequest,
  lifecycle: SubagentLifecycle,
  registry: RuntimeTaskRegistry,
  runOptions?: SubagentRunOptions,
  executionOptions: SubagentExecutionOptions = {},
  onSettled?: () => void,
): Promise<void> {
  let sessionReady = false;
  try {
    if (isTerminalRuntimeTask(registry.get(lifecycle.agentId) ?? { status: "lost" })) {
      return;
    }
    const completed = await runAgentToCompletion(
      options,
      request,
      lifecycle,
      registry,
      runOptions,
      {},
      {
        ...executionOptions,
        onSessionReady: async () => {
          await executionOptions.onSessionReady?.();
          sessionReady = true;
        },
      },
    );
    await finalizeBackgroundCompletion(options, request, lifecycle, registry, completed);
  } catch (error) {
    try {
      if (!sessionReady) {
        executionOptions.onSessionStartFailed?.(error);
        if (runOptions?.signal?.aborted) {
          await finalizeBackgroundStopped(options, request, lifecycle, registry, false);
        }
        return;
      }
      if (runOptions?.signal?.aborted) {
        await finalizeBackgroundStopped(options, request, lifecycle, registry, true);
      } else {
        await finalizeBackgroundFailure(options, request, lifecycle, registry, error);
      }
    } catch (finalizationError) {
      // Runtime settlement still releases the registry owner in finally; its fallback marks
      // the task failed and wakes waiters if artifacts/events prevented a normal terminal update.
      options.logger?.warn("Subagent background finalization failed", {
        errorMessage:
          finalizationError instanceof Error
            ? finalizationError.message
            : String(finalizationError),
        event: "subagent.background.finalization_failed",
        agentId: lifecycle.agentId,
      });
    }
  } finally {
    onSettled?.();
  }
}

export interface SubagentExecutionOptions {
  resumeFromStore?: boolean;
  onSessionReady?: (info?: { reasoningLevel?: string }) => Promise<void>;
  onSessionStartFailed?: (error: unknown) => void;
}

export function createSubagentSessionReadyGate(): {
  promise: Promise<void>;
  reject(error: unknown): void;
  resolve(): void;
} {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  let settled = false;
  return {
    promise,
    reject: (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    },
    resolve: () => {
      if (settled) return;
      settled = true;
      resolvePromise();
    },
  };
}

function createMessageSinkRegistration(
  options: ExploreSubagentPortOptions,
  lifecycle: SubagentLifecycle,
  registry: RuntimeTaskRegistry,
): (sink: RuntimeTaskMessageSink) => void {
  return (sink) => {
    registry.update(lifecycle.agentId, (task) => ({
      ...task,
      messageSink: sink,
    }));
    void flushPendingMessages(options, lifecycle, registry, sink);
  };
}

async function flushPendingMessages(
  options: ExploreSubagentPortOptions,
  lifecycle: SubagentLifecycle,
  registry: RuntimeTaskRegistry,
  sink: RuntimeTaskMessageSink,
): Promise<void> {
  const pending = registry.drainMessages(lifecycle.agentId);
  for (let index = 0; index < pending.length; index++) {
    const message = pending[index];
    if (!message) continue;
    try {
      await sink.send(message);
    } catch (error) {
      for (const undelivered of pending.slice(index)) {
        registry.queueMessage(lifecycle.agentId, undelivered);
      }
      options.logger?.warn("Failed to flush pending subagent message", {
        ...traceContextToLogContext(lifecycle.runTraceContext),
        agentId: lifecycle.agentId,
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "subagent.message.flush.failed",
        module: "core.subagent",
        status: "failed",
      });
      return;
    }
  }
}

