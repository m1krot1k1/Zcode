import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";
import {
  reportChatErrorBannerTelemetry,
  resolveVisibleChatErrorTelemetryRecoveryAction,
  type ChatErrorBannerSurface,
} from "@/lib/chatErrorBannerTelemetry.js";
import {
  recordComposerFocus as recordComposerFocusTrace,
  recordComposerTextChange as recordComposerTextChangeTrace,
} from "@/lib/messageTelemetry.js";
import { reportPlanUsageTtftToArms } from "@/lib/planUsageArmsTelemetry.js";
import {
  reportSendFunnelInputFocus,
  reportSendFunnelSendClick,
  reportSendFunnelSendResult,
  type SendFunnelReasonCode,
} from "@/lib/sendFunnelArmsTelemetry.js";
import {
  reportUiFirstToken,
  reportUiMessageComplete,
  reportUiTurnBreakdown,
} from "@/lib/uiPerfArmsTelemetry.js";
import type { ZCodeUiError } from "@/lib/zcodeUiError.js";
import { createSendClickId, finiteNumber } from "@/v4/telemetry/supervisor/events.js";
import type {
  ConversationPromptTelemetrySeed,
  FinalizedAgentStep,
  PromptLifecycle,
  SupervisorState,
} from "@/v4/telemetry/supervisor/state.js";

/** 队列二次确认的 ACK reasonCode，语义是「等用户裁决后复用同一 seed 重发」，不是终态。 */
const HELD_QUEUE_CONFIRMATION_STALE_REASON = "guard.heldQueueConfirmationStale";

/** 从点击发送起算，超过这个时长仍未渲染出用户消息就判超时。 */
const SEND_RENDER_WAIT_TIMEOUT_MS = 30_000;

/** 发送落定的失败原因，取值口径见 docs/monitoring/composer-send-funnel-telemetry.md。 */
export type ConversationSendFailureReason = SendFunnelReasonCode;

/**
 * ACK 的处置：要么转入待渲染等待（命令被受理，但用户消息还没画出来），
 * 要么立即落定为失败。返回 null 表示本次两者都不做。
 */
type ConversationSendAckOutcome =
  | { kind: "awaitRender"; ackStatus: string }
  | {
      kind: "settle";
      status: "fail";
      ackStatus: string;
      reasonCode: ConversationSendFailureReason;
    };

/**
 * 把 CommandAck 折算成 send_result 的处置口径，返回 null 表示本次不落定。
 * 抽成纯函数是为了让 dispatchCommand 只负责调用，分支逻辑可单测。
 */
export function resolveSendAckSettlement(ack: {
  status: string;
  reasonCode?: string;
}): ConversationSendAckOutcome | null {
  // 必须先于 status 判断：这条 ACK 的 status 本身非 accepted，
  // 一旦落定，first-wins 会把用户确认后的真实成败结果吃掉。
  if (ack.reasonCode === HELD_QUEUE_CONFIRMATION_STALE_REASON) return null;
  // accepted/duplicate 只代表 Host 收下了命令，此时屏幕上还什么都没有；
  // z-code 没有乐观渲染，要等投影回流出 userInput row 才算发送成功。
  if (ack.status === "accepted" || ack.status === "duplicate") {
    return { kind: "awaitRender", ackStatus: ack.status };
  }
  const reasonCode: ConversationSendFailureReason =
    ack.status === "rejected" || ack.status === "stale" ? ack.status : "failed";
  // noop 不单列 reason_code，用户视角就是没发出去；原始值保留在 ackStatus 供下钻。
  return { kind: "settle", status: "fail", ackStatus: ack.status, reasonCode };
}

export function recordComposerFocus(state: SupervisorState): void {
  if (state.disposed) return;
  recordComposerFocusTrace(state.workspaceScopeKey, state.now());
}

export function recordComposerTextChange(state: SupervisorState, nextText: string): void {
  if (state.disposed) return;
  recordComposerTextChangeTrace(state.workspaceScopeKey, nextText, state.now());
}

/**
 * 用户真实点击/聚焦输入框。程序性自动聚焦（新建任务、切会话、挂载回焦、上下文块移除后回焦）
 * 由 composer 侧拦截，不得进入本函数，否则「点击输入框」会被切会话动作污染。
 * 与 recordComposerFocus 是两条独立链路：后者只写时间戳喂 send_btn，本函数只负责上报。
 */
export function recordComposerFocusClick(
  state: SupervisorState,
  input: { sessionId: string | null },
): void {
  if (state.disposed) return;
  reportSendFunnelInputFocus({ sessionId: input.sessionId, focusTime: state.now() });
}

/**
 * 用户点击发送键 / Enter 提交并通过发送门禁的瞬间。返回补齐 sendClickId 的 seed，
 * 调用方需把它一路带到落定处，保证 send_click 与 send_result 严格 1:1。
 * 队列二次确认复用既有 seed 时不得再调本函数（否则一次点击报两条）。
 */
export function recordSendClick(
  state: SupervisorState,
  input: {
    sessionId: string | null;
    seed: ConversationPromptTelemetrySeed;
    trigger: "button" | "shortcut";
  },
): ConversationPromptTelemetrySeed {
  const seed: ConversationPromptTelemetrySeed = {
    ...input.seed,
    sendClickId: input.seed.sendClickId ?? createSendClickId(),
  };
  if (state.disposed) return seed;
  reportSendFunnelSendClick({
    sessionId: input.sessionId,
    sendClickId: seed.sendClickId ?? "",
    sendTime: input.seed.sendTime,
    trigger: input.trigger,
    extraDetail: input.seed.extraDetail,
  });
  return seed;
}

/**
 * 发送落定（用户消息渲染完成、ACK 失败、产品 guard 拒绝、传输异常、等待渲染超时）。
 * 按 sendClickId first-wins 去重：ACK 与 catch 可能对同一次点击各调一次，只认最先到达的结果。
 */
export function settleSendResult(
  state: SupervisorState,
  input: {
    seed: ConversationPromptTelemetrySeed;
    sessionId: string | null;
    commandId?: string;
    status: "success" | "fail";
    ackStatus?: string;
    reasonCode?: ConversationSendFailureReason;
    /** 「点击发送 → 收到 ACK」那一段；未拿到 ACK 的失败路径不传。 */
    ackCostMs?: number;
    /** 覆盖端到端耗时；只有超时兜底会用（此时 now 已越过 30s 上限，需钉死在阈值上）。 */
    costMs?: number;
  },
): void {
  if (state.disposed) return;
  const sendClickId = input.seed.sendClickId;
  // 后台自动任务的 seed 没有点击来源，落定不能伪造成用户发送。
  if (!sendClickId || !state.settledSendClickIds.remember(sendClickId)) return;
  reportSendFunnelSendResult({
    sessionId: input.sessionId,
    commandId: input.commandId,
    sendClickId,
    status: input.status,
    ackStatus: input.ackStatus,
    reasonCode: input.reasonCode,
    costMs: input.costMs ?? state.now() - input.seed.sendTime,
    ackCostMs: input.ackCostMs,
    queueConfirmed: input.seed.queueConfirmed === true,
    extraDetail: input.seed.extraDetail,
  });
}

/**
 * ACK 已 accepted/duplicate：命令被 Host 收下了，但用户消息还没画到屏幕上。
 * 登记待渲染并挂超时定时器，等 notifyUserInputRendered 或超时任一先到再落定。
 */
export function awaitSendRender(
  state: SupervisorState,
  input: {
    seed: ConversationPromptTelemetrySeed;
    sessionId: string | null;
    commandId: string;
    ackStatus: string;
  },
): void {
  if (state.disposed) return;
  // 后台自动任务无点击来源；同一 commandId 重复登记时保留首次（含其定时器）。
  if (!input.seed.sendClickId) return;
  if (state.pendingSendRenderWaits.has(input.commandId)) return;
  const ackCostMs = Math.max(0, state.now() - input.seed.sendTime);
  // 超时口径从点击发送起算，故剩余时长要扣掉已经花在 ACK 上的那一段。
  const remainingMs = Math.max(0, SEND_RENDER_WAIT_TIMEOUT_MS - ackCostMs);
  const timer = setTimeout(() => {
    const wait = state.pendingSendRenderWaits.get(input.commandId);
    if (!wait) return;
    state.pendingSendRenderWaits.delete(input.commandId);
    settleSendResult(state, {
      seed: wait.seed,
      sessionId: wait.sessionId,
      commandId: input.commandId,
      status: "fail",
      ackStatus: wait.ackStatus,
      reasonCode: "render_timeout",
      ackCostMs: wait.ackCostMs,
      costMs: SEND_RENDER_WAIT_TIMEOUT_MS,
    });
  }, remainingMs);
  state.pendingSendRenderWaits.set(input.commandId, {
    seed: input.seed,
    sessionId: input.sessionId,
    ackStatus: input.ackStatus,
    ackCostMs,
    timer,
  });
}

/**
 * 用户消息已渲染进对话历史（投影回流出 userInput row，且 React 完成 commit）。
 * 没登记过的 commandId 直接忽略——历史消息回填、切会话重载都会推一堆 row 过来。
 */
export function notifyUserInputRendered(state: SupervisorState, commandId: string): void {
  if (state.disposed) return;
  const wait = state.pendingSendRenderWaits.get(commandId);
  if (!wait) return;
  state.pendingSendRenderWaits.delete(commandId);
  clearTimeout(wait.timer);
  settleSendResult(state, {
    seed: wait.seed,
    sessionId: wait.sessionId,
    commandId,
    status: "success",
    ackStatus: wait.ackStatus,
    ackCostMs: wait.ackCostMs,
  });
}

export function enqueueReport(
  state: SupervisorState,
  payload: Parameters<typeof reportAppTelemetryEvent>[1],
): void {
  const report = () =>
    reportAppTelemetryEvent(state.platform, payload, "v4-conversation-telemetry");
  // 修复原因：renderer 发起顺序虽然是 step → completion，但两个异步 IPC 会在 main
  // 并发执行，最终 net.fetch 偶发反序。workspace supervisor 内串行化最终 reporter，
  // 同时保持第一条立即发起，避免额外推迟 send_btn。
  const queued = state.reportTail ? state.reportTail.then(report) : report();
  state.reportTail = queued;
  void queued.then(() => {
    if (state.reportTail === queued) state.reportTail = null;
  });
}

/** 仅供 focused tests 等待串行 reporter 清空。 */
export async function flushReports(state: SupervisorState): Promise<void> {
  await state.reportTail;
}

export function withWorkspaceTelemetryDetail(
  state: SupervisorState,
  detail: Record<string, string>,
): Record<string, string> {
  return state.workspaceTelemetryDetail ? { ...detail, ...state.workspaceTelemetryDetail } : detail;
}

export function reportFinalizedSteps(
  state: SupervisorState,
  lifecycle: PromptLifecycle,
  finalized: FinalizedAgentStep[],
  extraDetail?: Record<string, string>,
): void {
  for (const step of finalized) {
    enqueueReport(state, {
      elementName: "agent_step",
      eventRegion: "app",
      eventType: "agent_trace",
      eventExtraDetail: withWorkspaceTelemetryDetail(state, {
        ...lifecycle.stepSourceDetail,
        ...step.eventExtraDetail,
        ...extraDetail,
      }),
      talkId: lifecycle.sessionId,
      messageId: lifecycle.sourceCommandId,
    });
  }
}

export function reportCompletionArms(
  state: SupervisorState,
  sessionId: string,
  sourceCommandId: string,
  detail: Record<string, string>,
  foregroundTtftMs: number | undefined,
): void {
  if (foregroundTtftMs !== undefined) {
    reportUiFirstToken({
      ttftMs: foregroundTtftMs,
      model: detail.model_name || undefined,
      talkId: sessionId,
      messageId: sourceCommandId,
    });
    reportPlanUsageTtftToArms(state.platform, {
      providerId: detail.model_provider,
      modelName: detail.model_name,
      askMode: detail.ask_mode,
      ttftMs: foregroundTtftMs,
    });
  }
  const durationMs = finiteNumber(detail.duration_ms);
  if (durationMs === undefined) return;
  reportUiMessageComplete({
    durationMs,
    result: detail.status ?? "",
    model: detail.model_name || undefined,
    talkId: sessionId,
    messageId: sourceCommandId,
  });
  reportUiTurnBreakdown({
    durationMs,
    result: detail.status ?? "",
    model: detail.model_name || undefined,
    talkId: sessionId,
    messageId: sourceCommandId,
    ttftMs: foregroundTtftMs,
    waitingMs: finiteNumber(detail.waiting_ms),
    toolCallTotal: finiteNumber(detail.tool_call_total),
    toolCallFailed: finiteNumber(detail.tool_call_failed),
    agentStepCount: finiteNumber(detail.agent_step_cnt),
    retryCount: finiteNumber(detail.retry_cnt),
    fileChangeCount: finiteNumber(detail.file_change_cnt),
    generatedCodeLines: finiteNumber(detail.generated_code_lines),
  });
}

export function reportVisibleChatError(
  state: SupervisorState,
  params: {
    surface?: ChatErrorBannerSurface;
    errorKey?: string | null;
    displayMessage: string;
    error: ZCodeUiError;
  },
): void {
  if (state.disposed) return;
  void reportChatErrorBannerTelemetry(state.platform, {
    ...params,
    providerBusinessRecoveryAction: resolveVisibleChatErrorTelemetryRecoveryAction(params.error),
  });
}
