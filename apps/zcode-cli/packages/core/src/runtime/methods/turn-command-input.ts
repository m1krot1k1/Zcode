import type { Model, MessagePart, TraceContext } from "../deps.js";
import {
  HookEventName,
  SessionEventType,
  TurnMachineImpl,
  createModelUsageSummaryFromEvents,
  formatLocalIsoDate,
} from "../deps.js";
import { startProjectMemoryRecallPrefetch } from "../helpers/project-memory-recall.js";
import { ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH } from "../../memory/project-memory-retrieval-branch.js";
import { buildReferencedSessionContextReminderBody } from "../../session-context/read-session-context.js";
import { runtimeInputMetadata } from "../../agent/runtime-input-presentation.js";
import { withConversationQuotes } from "../helpers/conversation-quotes.js";
import { buildCodeIndexTurnHint, hasCodeReadingTools } from "../helpers/runtime-reminders.js";
import {
  buildDateChangeReminderBody,
  buildRuntimeUserEntriesFromTurn,
  buildUserContentFromTurn,
  logResolvedTurnAttachments,
  resolveTurnAttachments,
  runtimeMetadataForSyntheticUserMessageSource,
  throwIfTurnAborted,
} from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { ExecuteTurnOptions, ResolvedTurnAttachment, TurnResult } from "../types.js";
import { rebuildContextPrefix } from "./context-refresh.js";
import { recordTurnUsageFact } from "./usage-observability.js";
import { maybeStartSessionTitleGeneration } from "./session-title.js";
import type { TurnCommandContext } from "./turn-command-context.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";

/** Контекст и SessionStart-хуки выполняются один раз перед основной цепочкой. */
export async function initializeTurnContext(ctx: TurnCommandContext): Promise<void> {
  const { runtime, turnTraceContext, turnAbortSignal } = ctx;
  // Bug 根因：创建错误确定后仍执行 Context/SessionStart，会在 TurnStarted 前被二次 I/O 错误覆盖，
  // 并提前消费一次性 SessionStart。失败轮跳过它们，只复用后续输入持久化与终态主链。
  if (ctx.state.model.creationFailure) return;
  const admittedModel = ctx.state.model.admittedModel;
  let phaseStartedAt = ctx.startTurnPhase("context_initialization");
  if (runtime.contextInitialized) {
    // 每个后续 model step 都按该步骤实际持有的 Model 重新投影 Context；
    // Session Selection 只决定未来创建哪个 Model，不能充当执行事实。
    rebuildContextPrefix(runtime, { model: admittedModel });
  } else {
    // 首轮初始化已经用 admitted Model 构造并安装完整 Context，随后再 rebuild
    // 会把同一 Prefix 连续构造两次。未初始化与已初始化分支互斥，每个 model step 只构造一次。
    await runtime.ensureContextInitialized(turnTraceContext, admittedModel);
  }
  ctx.completeTurnPhase("context_initialization", phaseStartedAt);
  throwIfTurnAborted(turnAbortSignal);
  phaseStartedAt = ctx.startTurnPhase("session_start_hooks");
  const sessionStartHookResult = await runtime.runSessionStartHooks(
    "startup",
    turnTraceContext,
    turnAbortSignal,
    admittedModel,
  );
  ctx.completeTurnPhase("session_start_hooks", phaseStartedAt);
  runtime.injectHookAdditionalContextIntoMessageHistory(
    HookEventName.SessionStart,
    sessionStartHookResult.additionalContexts,
  );
}

/**
 * UserPromptSubmit-хуки и ветка preventContinuation. Возвращает готовый TurnResult,
 * если хук заблокировал продолжение; иначе undefined и цепочка идёт дальше.
 */
export async function runUserPromptStage(ctx: TurnCommandContext): Promise<TurnResult | undefined> {
  const { runtime, options, input, attachments, turnTraceContext, turnAbortSignal, events } = ctx;
  const { state } = ctx;
  const phaseStartedAt = ctx.startTurnPhase("user_prompt_hooks");
  const userPromptHookResult = options?.skipUserPromptSubmitHooks
    ? { additionalContexts: [] }
    : await runtime.runUserPromptSubmitHooks(input, attachments, turnTraceContext, turnAbortSignal);
  ctx.completeTurnPhase("user_prompt_hooks", phaseStartedAt);
  if (userPromptHookResult.preventContinuation) {
    const response = userPromptHookResult.stopReason ?? "Prompt blocked by UserPromptSubmit hook.";
    if (state.activeTurn) state.activeTurn.steerable = false;
    state.turnMachine = new TurnMachineImpl(state.turnMachine.complete(response, "success"));
    const turnUsage = createModelUsageSummaryFromEvents(events);
    const completeEvent = runtime.createEvent(
      SessionEventType.TurnComplete,
      {
        response,
        tokenCount: 0,
        usage: turnUsage,
        toolCallCount: 0,
        duration: Date.now() - state.turnMachine.state.startedAt.getTime(),
        resultType: "success",
        cacheStats: runtime.messageHistory.getCacheStats(),
        inputId: options?.inputId,
      },
      turnTraceContext,
    );
    await runtime.appendEvent(completeEvent, turnTraceContext);
    events.push(completeEvent);
    await recordTurnUsageFact(runtime, {
      completedAt: Date.now(),
      events,
      startedAt: ctx.turnStartedAtMs,
      status: "completed",
      traceContext: turnTraceContext,
      turnId: ctx.turnId,
    });
    runtime.turnNumber++;
    const projection = await runtime.rebuildProjection();
    await runtime.accountTargetTurnCompletion({
      inputID: ctx.targetRunInputID,
      startedAtMs: ctx.turnStartedAtMs,
      startedTarget: state.startedTarget,
      traceContext: turnTraceContext,
      usage: turnUsage,
    });
    return {
      response,
      turnId: ctx.turnId,
      traceId: ctx.traceId,
      usage: turnUsage,
      events,
      projection,
    };
  }
  runtime.injectHookAdditionalContextIntoMessageHistory(
    HookEventName.UserPromptSubmit,
    userPromptHookResult.additionalContexts,
  );
  return undefined;
}

/** Напоминания, вложения и общий контекст, которые формируют историю до записи user prompt. */
export async function prepareTurnInputEntries(
  ctx: TurnCommandContext,
): Promise<ResolvedTurnAttachment[]> {
  const { runtime, options, input, attachments, turnTraceContext, turnAbortSignal } = ctx;
  const turnId = ctx.turnId;
  injectReferencedSessionContextReminderIntoMessageHistory(runtime, input, options);
  // 话题原文由标准文本附件按需读取，可信来源归档不能再次生成隐藏上下文。
  injectDateChangeReminderIntoMessageHistory(runtime);
  // 无端口或 model-only 唤醒不进入 async：通知回合若多让出一个 microtask，
  // 会和下一轮 prepareAgentDefinitions 抢同一次 profile 加载。
  if (options?.inputVisibility !== "model-only" && runtime.codeIntelligencePort) {
    await injectCodeIndexTurnHint(runtime, input, turnAbortSignal, turnTraceContext, options);
  }
  const resolvedAttachments = await resolveTurnAttachments(attachments, {
    abortSignal: turnAbortSignal,
    artifactStore: runtime.artifactStore,
    fileSystemPort: runtime.fileSystemPort,
    imageProcessorPort: runtime.imageProcessorPort,
    sessionId: runtime.sessionId,
    traceContext: turnTraceContext,
    turnId,
    workingDirectory: runtime.workingDirectory,
  });
  logResolvedTurnAttachments(runtime.logger, turnTraceContext, resolvedAttachments);
  const sharedContextRefs = options?.sharedContextRefs ?? options?.intent?.sharedContextRefs;
  if (sharedContextRefs && sharedContextRefs.length > 0) {
    const [reference] = sharedContextRefs;
    if (!reference || reference.kind !== "shared_context_import") {
      throw new Error("invalid shared context reference");
    }
    if (!runtime.sessionStore) throw new Error("shared context import storage is unavailable");
    const alreadyHydrated = runtime.messageHistory
      .borrowReadOnlyRuntimeEntries()
      .some((entry) => entry.kind !== "attachment" && entry.metadata?.source === "shared_context");
    if (!alreadyHydrated) {
      const importedMessages = await runtime.sessionStore.messages({
        sessionID: runtime.sessionId,
      });
      const contextMessage = importedMessages.find(
        (message) =>
          message.info.role === "user" &&
          message.info.source === "shared_context" &&
          message.info.metadata &&
          typeof message.info.metadata === "object" &&
          (message.info.metadata as Record<string, unknown>).contextId === reference.context_id,
      );
      const contextText = contextMessage?.parts
        .filter((part): part is Extract<MessagePart, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();
      if (!contextText) throw new Error("shared context content is unavailable");
      runtime.messageHistory.addUser(
        contextText,
        runtimeMetadataForSyntheticUserMessageSource("shared_context"),
      );
    }
  }
  await runtime.persistPendingModelChangeTimeline(turnTraceContext);
  return resolvedAttachments;
}

/** Записывает user prompt в историю и session store ровно один раз. */
export async function persistTurnUserInput(
  ctx: TurnCommandContext,
  resolvedAttachments: ResolvedTurnAttachment[],
): Promise<void> {
  const { runtime, options, input, turnTraceContext } = ctx;
  const userMessageId = ctx.state.userMessageId;
  if (options?.skipInputRecord !== true && options?.inputVisibility === "model-only") {
    const inputSource = options.inputSource ?? "goal-continuation";
    const userContent = buildUserContentFromTurn(input, resolvedAttachments);
    runtime.messageHistory.addUser(
      userContent,
      runtimeInputMetadata(options.inputPresentation) ??
        runtimeMetadataForSyntheticUserMessageSource(inputSource),
    );
    // /goal 自动续跑是 runtime 注入给模型的内部 user-role 输入，
    // 不是用户在聊天里新发的一条消息。持久化时保留 raw 输入供恢复/排查使用，
    // 但用 model-only 语义阻止 UI-facing snapshot 把它渲染成用户气泡。
    await runtime.persistSyntheticUserNoticeForSession({
      messageID: userMessageId!,
      metadata: {
        ...(options.targetId ? { targetId: options.targetId } : {}),
        ...(options.inputPresentation ? { inputPresentation: options.inputPresentation } : {}),
        visibility: "model-only",
      },
      sessionId: runtime.sessionId,
      source: inputSource,
      text: input,
      traceContext: turnTraceContext,
      visibility: "model-only",
    });
  } else if (options?.skipInputRecord !== true) {
    runtime.messageHistory.addEntries(
      buildRuntimeUserEntriesFromTurn(
        withConversationQuotes(
          input,
          options?.intent?.conversationQuotes,
          options?.intent?.botGroupSource,
        ),
        resolvedAttachments,
        {
          browserAmbientContext: options?.browserAmbientContext,
        },
      ).map((entry) => {
        const metadata = runtimeInputMetadata(options?.inputPresentation);
        return entry.kind !== "attachment" && metadata ? { ...entry, metadata } : entry;
      }),
    );
    // /init 和自定义 slash command 会把模型输入展开成较长的内部
    // prompt。模型可见的历史必须使用展开后的 input，但 UI 展示、会话标题和
    // 恢复快照只能展示用户真实提交的原始 query。
    await runtime.persistUserPrompt(
      userMessageId!,
      ctx.displayInput,
      resolvedAttachments,
      turnTraceContext,
      {
        intent: options?.intent,
        inputPresentation: options?.inputPresentation,
        sessionInputId: options?.intent?.queueItemId,
        sourceCommandId: options?.inputId,
        ...(options?.epilogueStart === undefined ? {} : { epilogueStart: options.epilogueStart }),
      },
    );
  }
}

/** Публикует fallback исполнения, фиксирует определения агентов и запускает заголовок. */
export async function prepareTurnForLoop(ctx: TurnCommandContext): Promise<Model> {
  const { runtime, options, turnTraceContext, turnAbortSignal, events } = ctx;
  const { state } = ctx;
  const { creationFailure, creationFallback } = state.model;
  if (creationFailure) {
    // 已接纳输入已随 TurnStarted 和用户消息落库；不准备 Agent、不生成标题、不请求模型，
    // 终态由下方 catch 统一写入。
    throw creationFailure.error;
  }
  if (creationFallback) {
    // TurnStarted 与用户消息已先落库，continuous/replayable 投影都能把退回事实关联到同一输入行。
    const fallbackEvent = runtime.createEvent(
      SessionEventType.TurnExecutionModelFallback,
      {
        ...(options?.inputId ? { inputId: options.inputId } : {}),
        reason: creationFallback.reason,
        fromModelSelection: creationFallback.fromModelSelection,
        toModelSelection: creationFallback.toModelSelection,
      },
      turnTraceContext,
    );
    await runtime.appendEvent(fallbackEvent, turnTraceContext);
    events.push(fallbackEvent);
  }
  // 配置读取曾早于输入展示/持久化，失败会让已发送消息从界面消失。
  // 在原有输入记录后固定本轮定义，错误/取消复用本层收尾，且不启动标题或模型请求。
  await runtime.prepareAgentDefinitions({
    signal: turnAbortSignal,
    traceContext: turnTraceContext,
  });
  throwIfTurnAborted(turnAbortSignal);
  if (options?.skipInputRecord !== true && options?.inputVisibility !== "model-only") {
    // 修复原因：标题生成以前等主 turn 成功后才启动，用户 stop/cancel 首轮请求时
    // generated title 永远没有机会发起。首条 query 持久化后即可异步生成，避免被主链路取消拖死。
    const titleGenerationStarted = maybeStartSessionTitleGeneration.call(
      runtime,
      ctx.displayInput,
      state.userMessageId!,
      turnTraceContext,
      {
        deferIfProviderRuntimeHeadersRefresh: true,
        offPeakExecutionId: options?.offPeakExecutionId,
      },
    );
    state.shouldRetryTitleGenerationAfterTurn = !titleGenerationStarted;
  }
  // Plugin reminder 必须在对应 user 消息写入历史和 session store 后再追加：
  // provider 形态因此稳定为 user → system，cold hydration 也按同一因果顺序恢复。
  // 根因：input 可能已经被自定义命令展开，解析它会让命令模板里的 plugin://
  // 凭空获得“用户引用”语义；这里只解析真实持久化的 canonical displayInput。
  // runtime 内部的 model-only continuation 不代表新的用户意图，不重复解析。
  if (options?.inputVisibility !== "model-only") {
    await runtime.injectPluginReferenceReminderFromTurn(
      ctx.displayInput,
      turnTraceContext,
      options?.toolDisallowlist,
    );
  }

  runtime.messageHistory.setCacheMiss();
  const loopModel = state.model.submissionModel ?? state.model.admittedModel;
  if (!loopModel) {
    throw new Error("Turn model was not created before execution");
  }
  startProjectMemoryRecallPrefetch(
    runtime,
    {
      model: loopModel,
      traceContext: turnTraceContext,
      turnAbortSignal,
    },
    ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH,
  );
  return loopModel;
}

/** Собирает RegularTurnLoopState из уже подготовленных фактов Turn. */
export function createTurnLoopState(
  ctx: TurnCommandContext,
  loopModel: Model,
): RegularTurnLoopState {
  const { runtime, options, input, events, turnAbortSignal, turnTraceContext } = ctx;
  const { state } = ctx;
  return {
    activeTurn: state.activeTurn,
    ...(options?.automationId ? { automationId: options.automationId } : {}),
    // 闲时派发轮的身份进入 loop state，供工具执行边界 deny OffPeakCreate。
    ...(options?.offPeakTaskId ? { offPeakTaskId: options.offPeakTaskId } : {}),
    ...(options?.offPeakExecutionId ? { offPeakExecutionId: options.offPeakExecutionId } : {}),
    anomalyWarningsInjected: 0,
    backgroundSubagentResultConsumed: options?.backgroundSubagentResultConsumed === true,
    workflowResultConsumed: options?.workflowResultConsumed === true,
    completedRealToolResultBatch: false,
    currentUserMessageId: state.userMessageId!,
    events,
    input,
    ...(options?.inputId ? { inputId: options.inputId } : {}),
    modelResponse: "",
    model: loopModel,
    ...(options?.modelExecution?.selectionScope === "execution"
      ? { modelSelectionScope: "execution" as const }
      : {}),
    // 加速卡回退仅使用启动时快照，不随随后接纳的用户选择变化。
    ...(!state.model.creationFallback && options?.modelExecution?.selectionFallback
      ? {
          selectionFallback: options.modelExecution.selectionFallback,
          highspeedFallbackSelection: ctx.highspeedFallbackSelection,
        }
      : {}),
    ...(options?.modelExecution?.subagents && state.model.effectiveExecutionSelection
      ? {
          subagentModelOverride: {
            selection: state.model.effectiveExecutionSelection,
            requestDependencies: state.model.effectiveRequestDependencies,
            background: options.modelExecution.subagents.background,
          },
        }
      : {}),
    modelStepCount: 0,
    historyRoundCount: 0,
    reactiveCompactAttemptedInCurrentModelStep: false,
    repeatedToolCallSignature: undefined,
    repeatedToolCallStreakCount: 0,
    stopHookContinuationCount: 0,
    streamRecoveryRetryCount: 0,
    tokenCount: 0,
    toolCallCount: 0,
    turnRequestState: {
      // Turn 只借一次 canonical 成员集合，之后由显式 commit 推进；entry 本身
      // 遵循 MessageHistory 的不可变约定。
      entries: [...runtime.messageHistory.borrowReadOnlyRuntimeEntries()],
      outputTokenContinuationCount: 0,
    },
    toolDisallowlist: options?.toolDisallowlist,
    traceId: ctx.traceId,
    turnAbortSignal,
    turnId: ctx.turnId,
    turnMachine: state.turnMachine,
    turnOutputStyle: ctx.admittedOutputStyle,
    turnTraceContext,
    userMessageId: state.userMessageId!,
  };
}

function injectDateChangeReminderIntoMessageHistory(runtime: AgentRuntimeInternal): void {
  const currentDate = formatLocalIsoDate(runtime.now());
  const previousDate = runtime.lastEmittedLocalDate;
  runtime.lastEmittedLocalDate = currentDate;

  if (!previousDate || previousDate === currentDate) {
    return;
  }

  runtime.messageHistory.addAttachment(
    "date_change",
    buildDateChangeReminderBody(previousDate, currentDate),
  );
}

async function injectCodeIndexTurnHint(
  runtime: AgentRuntimeInternal,
  input: string,
  signal: AbortSignal,
  trace: TraceContext,
  options?: ExecuteTurnOptions,
): Promise<void> {
  if (options?.inputVisibility === "model-only") return;
  // 原因: у router-ролей (start/orchestrator) единственный инструмент — Task.
  // Подсказка стоит до 2 секунд ожидания Host и до 12 КБ контекста на каждом
  // переходе цепочки, но применить её нечем. Выдаём только ролям с доступом к коду.
  const toolNames = new Set(runtime.getTools().map((tool) => tool.name));
  if (!hasCodeReadingTools(toolNames)) return;
  const hint = await buildCodeIndexTurnHint({
    port: runtime.codeIntelligencePort,
    query: input,
    signal,
    trace,
  });
  if (!hint) return;
  runtime.messageHistory.addAttachment("code_index_hint", hint);
}

function injectReferencedSessionContextReminderIntoMessageHistory(
  runtime: AgentRuntimeInternal,
  input: string,
  options?: ExecuteTurnOptions,
): void {
  if (options?.inputVisibility === "model-only") return;
  const reminderBody = buildReferencedSessionContextReminderBody(input);
  if (!reminderBody) return;
  runtime.messageHistory.addAttachment("referenced_session_context", reminderBody);
}
