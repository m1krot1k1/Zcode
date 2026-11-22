import { refreshOffPeakTurnAfterTakeover } from "../off-peak/turn.js";
import { appendRuntimeAgentListing } from "../helpers/agent-listing.js";
import { beginLocalTurnPreparation } from "@zcode/contracts";
import { buildToolSearchAnnouncement } from "../../tool/search/exposure.js";
import {
  CompactPhase,
  CompactReason,
  createMessageId,
  traceContextToLogContext,
  TurnMachineImpl,
} from "../deps.js";
import {
  buildRuntimeModeReminderBody,
  buildPlanModeExitReminderBody,
  buildRuntimeOutputStyleReminderBody,
  buildTodoReminderBody,
  buildRuntimeProviderRequestMessages,
  prepareRuntimeProviderRequest,
  createCompactRapidRefillError,
  resolveMaxTurnsWrapUpReminder,
  throwIfTurnAborted,
  shouldBuildTodoReminder,
} from "../helpers/index.js";
import {
  systemReminderAttachmentEntry,
  todoReminderRuntimeMetadata,
} from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { runModelBackedTurnStep } from "./turn-model-step.js";
import { persistRuntimeReminderMessage } from "./runtime-reminder-persistence.js";
import { buildProjectionAnchor } from "./projection-anchor.js";
import {
  evaluateRapidRefill,
  getTurnTools,
  MAX_CONSECUTIVE_RAPID_REFILLS,
  RAPID_REFILL_TOOL_TURN_THRESHOLD,
  recordCompactHistoryRound,
  recordCompactSuccess,
} from "./turn-loop-state.js";
import type { RegularTurnLoopState } from "./turn-loop-state.js";
import { consumeSettledProjectMemoryRecall } from "../helpers/project-memory-recall.js";
import { consumePendingProjectMemoryUpdate } from "../helpers/project-memory-dream.js";
import { ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH } from "../../memory/project-memory-retrieval-branch.js";
import {
  appendTurnRequestEntries,
  commitTurnRequestEntries,
  filterOutputTokenContinuationEntries,
} from "./turn-output-token-continuation.js";

/**
 * maxTurns 的生效条件只有显式正整数；undefined、0、负数、NaN、非整数都表示无限制
 * （docs/specs/max-turns-limit.md「Контракт」）。这里不接受任何静默 default。
 */
function resolveMaxTurnsLimit(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * 达到显式 maxTurns 且模型仍要求继续时，由唯一 turn loop 收口本轮：
 * 不再发起新的 model step，已提交的 assistant 文本/工具结果保留，terminal 事实由
 * turn.ts 根据 turnMachine.resultType 发布 TurnComplete(error_max_turns)。
 */
async function finishTurnAtMaxTurns(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  limit: number,
): Promise<void> {
  if (state.activeTurn) {
    // 与其它 no-tool 边界一致：不能把尚未合并的 guide 吞掉，也不能让 Router 继续 steer。
    await runtime.fallbackPendingGuidesToQueue({
      activeTurn: state.activeTurn,
      events: state.events,
      reasonCode: "guide.noToolBoundary",
      traceContext: state.turnTraceContext,
    });
    state.activeTurn.steerable = false;
  }
  // 修复原因：guide 回退是 async 边界，用户 Stop 可能恰好落在这里；取消必须优先于 maxTurns，
  // 不能被误报成受限完成（docs/specs/max-turns-limit.md「Контракт」）。
  throwIfTurnAborted(state.turnAbortSignal);
  // 修复原因：cold hydration 从 transcript 反向合成 TurnComplete，看不到 live 事件；
  // 没有 durable 标记时它会把最终步骤当成普通 success，重启后受限 turn 会显示为成功
  // （docs/specs/max-turns-limit.md「Контракт」）。标记必须先于终态事件落盘：即使进程在
  // TurnComplete 之后退出，冷恢复也已经能看到 error_max_turns。
  // 修复原因：旧实现用 runtime 全局 latestAssistantMessageId；空 length 步骤回滚后它仍指向
  // 上一个 turn 的 assistant，会把标记写进别人的 turn。现在由 persistTurnResultMarker
  // 按 turnId 在本 turn 内查找锚点，缺失时创建技术锚点；这里不再传递全局指针。
  await runtime.persistTurnResultMarker({
    parentMessageId: state.currentUserMessageId,
    resultType: "error_max_turns",
    traceContext: state.turnTraceContext,
    turnId: state.turnId,
    historyRoundCount: state.historyRoundCount,
    model: state.model,
  });
  runtime.logger?.info("Turn reached max turns limit", {
    ...traceContextToLogContext(state.turnTraceContext),
    event: "turn.max_turns.reached",
    module: "core.runtime",
    maxTurns: limit,
    modelStepCount: state.modelStepCount,
    // 受限结束不是普通 completed：诊断状态必须反映失败语义，否则监控会把
    // 达到上限当成成功收口。
    status: "failed",
  });
  state.turnMachine = new TurnMachineImpl(
    state.turnMachine.complete(state.modelResponse, "error_max_turns"),
  );
}

export async function runRegularTurnLoop(
  this: AgentRuntimeInternal,
  state: RegularTurnLoopState,
): Promise<void> {
  // maxTurns 只在显式正整数时生效；undefined/0/负数/非整数都表示无限制
  // （docs/specs/max-turns-limit.md「Контракт」）。
  const maxTurnsLimit = resolveMaxTurnsLimit(this.config.maxTurns);
  while (true) {
    throwIfTurnAborted(state.turnAbortSignal);
    refreshOffPeakTurnAfterTakeover(this, state);
    // 检查只发生在新 model step 的边界：已完成 maxTurns 步后，模型若仍要求继续，
    // 不再发起下一次请求，也不影响当前步内已开始的工具执行与权限交互。
    if (maxTurnsLimit !== undefined && state.modelStepCount >= maxTurnsLimit) {
      await finishTurnAtMaxTurns(this, state, maxTurnsLimit);
      break;
    }
    const outputTokenRecoveryActive = state.turnRequestState.outputTokenContinuationCount > 0;
    // guide 只允许由完整 tool result batch 设置这个一次性诊断；普通 queue 不在
    // model roundtrip 起点消费，避免把未来 turn 错并入当前 product turn。
    const drainedSteerForNextRequest = state.drainedSteerForNextRequest;
    state.drainedSteerForNextRequest = undefined;

    if (state.modelStepCount > 0 && !outputTokenRecoveryActive) {
      const drainedRuntimeCommands = await this.drainPendingRuntimeCommandsForActiveLoop();
      state.backgroundSubagentResultConsumed ||=
        drainedRuntimeCommands.backgroundSubagentResultConsumed;
      state.workflowResultConsumed ||= drainedRuntimeCommands.workflowResultConsumed;
      appendTurnRequestEntries(state.turnRequestState, drainedRuntimeCommands.runtimeEntries);
      if (drainedRuntimeCommands.drained > 0) {
        state.repeatedToolCallSignature = undefined;
        state.repeatedToolCallStreakCount = 0;
      }
    }

    if (state.completedRealToolResultBatch && !outputTokenRecoveryActive) {
      state.completedRealToolResultBatch = false;
      const recallEntry = consumeSettledProjectMemoryRecall(
        this,
        ACTIVE_PROJECT_MEMORY_RETRIEVAL_BRANCH,
      );
      appendTurnRequestEntries(state.turnRequestState, recallEntry ? [recallEntry] : []);
    }

    const compactPhase =
      state.modelStepCount === 0 ? CompactPhase.PreRequest : CompactPhase.MidTurn;
    await this.microcompactIfNeeded(state.turnTraceContext, state.events, state.turnAbortSignal, {
      model: state.model,
      modelStepIndex: state.modelStepCount,
      phase: compactPhase,
      turnRequestState: state.turnRequestState,
    });
    throwIfTurnAborted(state.turnAbortSignal);

    const rapidRefill = evaluateRapidRefill(state.compactTracking);
    const autoCompactOutcome = await this.autoCompactIfNeeded(
      state.turnTraceContext,
      state.events,
      state.turnAbortSignal,
      {
        getAgentListingTools: () => getTurnTools(this, state),
        compactReason: CompactReason.ContextLimit,
        modelStepIndex: state.modelStepCount,
        phase: compactPhase,
        rapidRefill,
        model: state.model,
        turnRequestState: state.turnRequestState,
        getContinuationTools: () => getTurnTools(this, state),
      },
    );
    if (autoCompactOutcome === "rapid_refill_blocked") {
      throw createCompactRapidRefillError({
        consecutiveRapidRefills: rapidRefill.consecutiveRapidRefills,
        maxConsecutiveRapidRefills: MAX_CONSECUTIVE_RAPID_REFILLS,
        toolTurnThreshold: RAPID_REFILL_TOOL_TURN_THRESHOLD,
        toolTurnsSinceCompact: rapidRefill.toolTurnsSinceCompact,
      });
    }
    if (autoCompactOutcome === "compacted") {
      recordCompactSuccess(state, rapidRefill);
      recordCompactHistoryRound(state);
    }
    throwIfTurnAborted(state.turnAbortSignal);

    const finishMcp = beginLocalTurnPreparation(state.turnTraceContext, "mcp");
    await this.initializeMcp(state.turnTraceContext);
    // Lazy plugin servers pay their process cost only when this turn names their format.
    await this.activateLazyMcpServersForInput(state.input, state.turnTraceContext);
    // tools/list_changed 只在回合开始前生效。
    await this.refreshMcpToolsIfChanged(state.turnTraceContext);
    finishMcp();
    throwIfTurnAborted(state.turnAbortSignal);
    const finishTools = beginLocalTurnPreparation(state.turnTraceContext, "tools");
    const tools = getTurnTools(this, state);
    finishTools();
    if (!outputTokenRecoveryActive) {
      await appendRuntimeAgentListing(this, state.turnRequestState, tools, state.turnTraceContext);
    }
    if (!outputTokenRecoveryActive && this.needsPlanModeExitReminder) {
      this.needsPlanModeExitReminder = false;
      commitTurnRequestEntries(this, state.turnRequestState, [
        systemReminderAttachmentEntry("plan_mode_exit", buildPlanModeExitReminderBody()),
      ]);
    }
    const runtimeModeReminderBody = outputTokenRecoveryActive
      ? null
      : buildRuntimeModeReminderBody(
          state.turnRequestState.entries,
          this.getMode(),
          this.getPlanEnabled(),
        );
    if (runtimeModeReminderBody) {
      commitTurnRequestEntries(this, state.turnRequestState, [
        systemReminderAttachmentEntry("runtime_mode", runtimeModeReminderBody),
      ]);
    }
    if (!outputTokenRecoveryActive) {
      const wrapUpReminder = resolveMaxTurnsWrapUpReminder({
        modelStepCount: state.modelStepCount,
        maxTurns: maxTurnsLimit,
        alreadyInjected: state.maxTurnsWrapUpReminderInjected,
      });
      if (wrapUpReminder) {
        state.maxTurnsWrapUpReminderInjected = true;
        commitTurnRequestEntries(this, state.turnRequestState, [
          systemReminderAttachmentEntry("model_anomaly", wrapUpReminder),
        ]);
      }
    }
    if (
      !outputTokenRecoveryActive &&
      tools.some((tool) => tool.name === "TodoWrite") &&
      shouldBuildTodoReminder(state.turnRequestState.entries)
    ) {
      const currentTodos = await this.readSessionTodosForContext(state.turnTraceContext);
      const reminderBody = buildTodoReminderBody(currentTodos);
      commitTurnRequestEntries(this, state.turnRequestState, [
        systemReminderAttachmentEntry("todo_reminder", reminderBody),
      ]);
      await this.persistSyntheticUserNoticeForSession({
        messageID: createMessageId(),
        metadata: { runtimeMessage: todoReminderRuntimeMetadata() },
        sessionId: this.sessionId,
        source: "todo_reminder",
        text: reminderBody,
        traceContext: state.turnTraceContext,
      });
    }
    const outputStyleReminderBody =
      state.modelStepCount === 0
        ? buildRuntimeOutputStyleReminderBody(state.turnOutputStyle)
        : null;
    if (outputStyleReminderBody) {
      // output_style 是 provider-visible 的当前 turn runtime attachment，
      // 需要进入内存历史参与后续 request 的增量轨迹；但不把它落 session。
      commitTurnRequestEntries(this, state.turnRequestState, [
        systemReminderAttachmentEntry("output_style", outputStyleReminderBody),
      ]);
    }
    if (!outputTokenRecoveryActive) {
      const announcement = buildToolSearchAnnouncement({
        model: state.model,
        mode: this.config.toolSearch?.mode,
        tools,
        registry: this.getToolRegistry(),
        entries: state.turnRequestState.entries,
      });
      if (announcement) {
        // 公告正文和增量事实必须先一起落盘；否则 fork/resume 会把已公告工具重新当成首次出现。
        const messageId = await persistRuntimeReminderMessage.call(
          this,
          announcement,
          state.turnTraceContext,
          {
            model: state.model,
            anchor: buildProjectionAnchor(state.turnTraceContext, "synthetic"),
          },
        );
        if (messageId) this.latestConversationMessageId = messageId;
        commitTurnRequestEntries(this, state.turnRequestState, [announcement]);
      }
    }
    // （2026-09-12）：原"回合开始注入 plugin_ui_state reminder"已删除，插件给模型的信息
    // 一律走 ui/update-model-context。
    const providerEntries = [...state.turnRequestState.entries];
    // Dream 可能在同一 turn 的首个模型请求期间完成；每次 attachment collection 都检查，
    // 才能把一次性更新放进紧随其后的模型请求，而不是延迟到下一次用户输入。
    const memoryUpdate = outputTokenRecoveryActive
      ? undefined
      : consumePendingProjectMemoryUpdate(this);
    const requestEntries = memoryUpdate ? [...providerEntries, memoryUpdate] : providerEntries;
    const prepared = prepareRuntimeProviderRequest(this, {
      model: state.model,
      tools,
      registry: this.getToolRegistry(),
      entries: requestEntries,
      applyCacheControl: true,
    });
    this.logger?.debug("ToolSearch request exposure", {
      event: "tool.search.exposure",
      enabled: prepared.toolSearch.enabled,
      mode: prepared.toolSearch.mode,
      reason: prepared.reason,
      catalogSize: prepared.toolSearch.catalog.length,
      schemaCount: prepared.request.tools.length,
    });
    // 修复原因：provider-visible user ordering projection 会改变最终 latest user 落点，
    // cache-control 必须在 projection 后统一设置，避免 raw synthetic entry 抢占缓存锚点。
    const providerProjection = prepared.projection;
    const { messages } = prepared.request;
    const recordableEntries = filterOutputTokenContinuationEntries(prepared.entries);
    const recordableProjection =
      recordableEntries === prepared.entries
        ? providerProjection
        : buildRuntimeProviderRequestMessages(this, {
            entries: recordableEntries,
            loadedToolCallIds: prepared.loadedToolCallIds,
            applyCacheControl: true,
            model: state.model,
          });
    state.turnMachine = new TurnMachineImpl(
      state.turnMachine.startModelRequest(
        `${state.model.providerId}/${state.model.modelId}`,
        recordableProjection.messages,
      ),
    );

    // 生产包需要知道 Turn 是否已经跨过 provider 边界；这里只记录请求元数据，
    // 不记录 prompt、消息内容或 streaming chunk，避免泄露内容并控制日志量。
    this.logger?.info("Model request started", {
      ...traceContextToLogContext(state.turnTraceContext),
      event: "model.request.started",
      module: "core.runtime",
      status: "started",
      messageCount: messages.length,
      iteration: state.toolCallCount === 0 ? 0 : Math.ceil(state.toolCallCount / 10),
    });

    const result = await runModelBackedTurnStep.call(this, state, {
      drainedSteerForNextRequest,
      latestRealUserMessageIndex: providerProjection.diagnostics.latestRealUserMessageIndex,
      messages,
      sourceEntries: providerProjection.sourceEntries,
      requestEntries,
      recordedMessages: recordableProjection.messages,
      tools: prepared.request.tools,
      toolSearch: prepared.toolSearch,
    });

    if (result === "break") {
      break;
    }
  }
}
