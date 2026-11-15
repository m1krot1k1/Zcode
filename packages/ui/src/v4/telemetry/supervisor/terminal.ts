import type { ZCodeStreamEvent } from "@zcode/shared";
import type { ConversationTelemetryFact } from "@zcode/shared/zcode-protocol-v4";
import {
  composeAgentComposition,
  finalizePromptTelemetry,
  recordAgentStepTelemetryEvent,
} from "@/lib/messageTelemetry.js";
import { clearStreamStallTracking } from "@/lib/uiPerfArmsTelemetry.js";
import { drainPromptBlockedByDeferredTerminal } from "@/v4/telemetry/supervisor/budgets.js";
import { terminalStatus } from "@/v4/telemetry/supervisor/events.js";
import {
  enqueueReport,
  reportCompletionArms,
  reportFinalizedSteps,
  withWorkspaceTelemetryDetail,
} from "@/v4/telemetry/supervisor/sending.js";
import type { PromptLifecycle, SupervisorState } from "@/v4/telemetry/supervisor/state.js";

export function handleTerminal(
  state: SupervisorState,
  lifecycle: PromptLifecycle,
  fact: Extract<ConversationTelemetryFact, { kind: "turn.terminal" }>,
  receivedAt: number,
  foregroundAtReceipt: boolean,
): void {
  const hasRunningForegroundChild = [...state.foregroundSubagentUsageByChildSession.values()].some(
    (child) => child.parentCommandId === lifecycle.sourceCommandId && !child.stopped,
  );
  if (hasRunningForegroundChild) {
    if (state.deferredTerminalsByCommandId.has(lifecycle.sourceCommandId)) return;
    // 同一 parent stream 正常顺序是 Agent tool terminal -> turn terminal。这里只处理
    // transport 反序：等待真实 SubagentStopped 或 Agent tool terminal，二者都能立即 flush。
    state.deferredTerminalsByCommandId.set(lifecycle.sourceCommandId, {
      lifecycle,
      fact,
      receivedAt,
      foregroundAtReceipt,
    });
    return;
  }
  const terminalKey = `${fact.sessionId}\u0000${lifecycle.sourceCommandId}\u0000message_completion`;
  if (!state.terminalKeys.remember(terminalKey)) return;
  const status = terminalStatus(fact.status);
  const terminalEvent = // 修复原因：旧 adapter 把所有 TurnComplete（包括 cancelled）先投影成
    // task_complete；UI 再单独把 completion 标成 user_interrupt。
    (
      fact.status === "success" || fact.resultType !== undefined
        ? {
            type: "task_complete",
            taskId: fact.sessionId,
            traceId: fact.eventId,
            inputId: lifecycle.sourceCommandId,
            stopReason: fact.resultType ?? "complete",
          }
        : {
            type: "task_error",
            taskId: fact.sessionId,
            traceId: fact.eventId,
            inputId: lifecycle.sourceCommandId,
            error: fact.errorMessage ?? lifecycle.lastErrorMessage ?? fact.errorCode ?? "",
            code: fact.errorCode,
          }
    ) as Extract<ZCodeStreamEvent, { type: "task_complete" | "task_error" }>;
  reportFinalizedSteps(
    state,
    lifecycle,
    recordAgentStepTelemetryEvent({
      taskId: lifecycle.taskKey,
      event: terminalEvent,
      activeInputId: lifecycle.sourceCommandId,
      clientMode: "desktop-continuous",
      now: receivedAt,
    }),
  );
  const completion = finalizePromptTelemetry({
    taskId: lifecycle.taskKey,
    status,
    finishedAt: receivedAt,
    errorType: fact.errorCode,
    errorMsg: fact.errorMessage ?? lifecycle.lastErrorMessage,
    ...(lifecycle.completionMessageSource
      ? { messageSource: lifecycle.completionMessageSource }
      : {}),
    agentComposition: composeAgentComposition(lifecycle),
  });
  if (completion) {
    enqueueReport(state, {
      elementName: "message_completion",
      eventRegion: "app",
      eventType: "agent_trace",
      // 修复原因：workspace 场景维度必须和 completion/step 一起出现在最终 report，
      // 不能只停留在 attachment 的隔离 key，否则数仓无法区分本地与远程对话。
      eventExtraDetail: withWorkspaceTelemetryDetail(state, completion.eventExtraDetail),
      talkId: fact.sessionId,
      messageId: lifecycle.sourceCommandId,
    });
    if (foregroundAtReceipt) {
      reportCompletionArms(
        state,
        fact.sessionId,
        lifecycle.sourceCommandId,
        completion.eventExtraDetail,
        lifecycle.foregroundFirstTokenAt === null
          ? lifecycle.legacyFirstTokenObserved
            ? undefined
            : -1
          : lifecycle.foregroundFirstTokenAt - lifecycle.sendTime,
      );
    }
  }
  clearStreamStallTracking(lifecycle.taskKey);
  state.deferredTerminalsByCommandId.delete(lifecycle.sourceCommandId);
  // finalize 已清当前 active；同 session 后续 queued seed 仍需等待 promotion，不能整 task 丢弃。
  state.activeCommandBySessionId.delete(fact.sessionId);
  state.lifecyclesByCommandId.delete(lifecycle.sourceCommandId);
  if (lifecycle.turnId) {
    state.commandIdByTurnKey.delete(`${fact.sessionId}\u0000${lifecycle.turnId}`);
  }
  for (const [childSessionId, child] of state.foregroundSubagentUsageByChildSession) {
    if (child.parentCommandId === lifecycle.sourceCommandId) {
      state.onSubagentUsageChanged?.(childSessionId, null);
      state.foregroundSubagentUsageByChildSession.delete(childSessionId);
    }
  }
  drainPromptBlockedByDeferredTerminal(state, lifecycle.taskKey);
}
