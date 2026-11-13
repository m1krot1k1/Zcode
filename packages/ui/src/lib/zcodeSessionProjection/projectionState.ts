import {
  attachZCodeBackgroundTaskNotificationToRaw,
  parseZCodeBackgroundTaskNotificationText,
  zcodeBackgroundTaskNotificationToolUpdateStatus,
  ensureZCodeToolProjectionMemory,
  isZCodeModelRetryRecoveryProgressPayload,
  type ZCodeStreamEvent,
  type InputId,
  type TraceId,
  type ZCodeToolProjectionMemory,
} from "@zcode/shared";
import { type ZCodeSessionEventProjectionState } from "./primitives.js";

export function ensureProjectionToolMemory(
  state: ZCodeSessionEventProjectionState | undefined,
): ZCodeToolProjectionMemory | undefined {
  if (!state) {
    return undefined;
  }
  // 修复原因：前台 useTaskStreamEvents 曾漏初始化这个 Map，导致 Write 输入 delta
  // 每次都从空字符串重新解析，界面只能看到首段和最终完整 tool_call，无法实时递增行数。
  return ensureZCodeToolProjectionMemory(state);
}

function ensureProjectionApiRetrySessionIds(
  state: ZCodeSessionEventProjectionState | undefined,
): Set<string> | undefined {
  if (!state) {
    return undefined;
  }
  state.activeApiRetrySessionIds ??= new Set<string>();
  return state.activeApiRetrySessionIds;
}

export function trackProjectionApiRetryEvents(
  state: ZCodeSessionEventProjectionState | undefined,
  sessionId: string,
  events: ZCodeStreamEvent[],
): ZCodeStreamEvent[] {
  const apiRetrySessionIds = ensureProjectionApiRetrySessionIds(state);
  if (!apiRetrySessionIds) {
    return events;
  }
  for (const event of events) {
    if (event.type === "session_info_update" && event.apiRetry !== undefined) {
      if (event.apiRetry) {
        apiRetrySessionIds.add(sessionId);
      } else {
        apiRetrySessionIds.delete(sessionId);
      }
    }
  }
  return events;
}

export function clearProjectionApiRetryState(
  state: ZCodeSessionEventProjectionState | undefined,
  sessionId: string,
): void {
  state?.activeApiRetrySessionIds?.delete(sessionId);
}

export function takeProjectionApiRetryClearOnModelProgress(
  state: ZCodeSessionEventProjectionState | undefined,
  sessionId: string,
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
): Extract<ZCodeStreamEvent, { type: "session_info_update" }> | null {
  if (
    !state?.activeApiRetrySessionIds?.has(sessionId) ||
    !isZCodeModelRetryRecoveryProgressPayload(payload)
  ) {
    return null;
  }
  // 修复原因：普通 adapter retry 的 request_started 只是开始重试，立即清理会让输入栏闪烁；
  // 等到 retry attempt 真正产出模型内容时再清理，才表示用户可见的连接已经恢复。
  state.activeApiRetrySessionIds.delete(sessionId);
  return {
    type: "session_info_update",
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    apiRetry: null,
  };
}

export function backgroundTaskNotificationToolUpdateFromInput(params: {
  input: string | undefined;
  inputId: InputId | undefined;
  taskId: string;
  traceId: TraceId;
}): Extract<ZCodeStreamEvent, { type: "tool_call_update" }> | null {
  const parsed = parseZCodeBackgroundTaskNotificationText(params.input);
  if (!parsed) {
    return null;
  }
  const status = zcodeBackgroundTaskNotificationToolUpdateStatus(
    parsed.notification.status,
  );
  return {
    type: "tool_call_update",
    taskId: params.taskId,
    traceId: params.traceId,
    ...(params.inputId ? { inputId: params.inputId } : {}),
    toolId: parsed.toolUseId,
    status,
    content: parsed.notification.result ?? parsed.notification.summary,
    // 修复原因：ToolLayout 的既有失败 hover 只读取 toolCall.error；notification
    // 原先只更新 status/raw，导致“执行失败”没有可展示的详情。
    ...(status === "failed" && parsed.notification.error
      ? { error: parsed.notification.error }
      : {}),
    raw: attachZCodeBackgroundTaskNotificationToRaw(
      { toolCallId: parsed.toolUseId },
      parsed.notification,
    ),
  };
}

export function getActivePromptInputId(
  state: ZCodeSessionEventProjectionState | undefined,
  sessionId: string,
): InputId | undefined {
  return state?.activePromptInputIdBySession?.get(sessionId);
}

export function setActivePromptInputId(
  state: ZCodeSessionEventProjectionState | undefined,
  sessionId: string,
  inputId: InputId,
): void {
  if (!state) {
    return;
  }
  const map = state.activePromptInputIdBySession ?? new Map<string, InputId>();
  map.set(sessionId, inputId);
  state.activePromptInputIdBySession = map;
}

export function clearActivePromptInputId(
  state: ZCodeSessionEventProjectionState | undefined,
  sessionId: string,
  inputId: InputId,
): void {
  if (state?.activePromptInputIdBySession?.get(sessionId) === inputId) {
    state.activePromptInputIdBySession.delete(sessionId);
  }
}

export function rememberRewindControlTurn(
  state: ZCodeSessionEventProjectionState | undefined,
  turnKey: string,
  input: string | undefined,
): void {
  if (!state) {
    return;
  }
  const rewindControlTurnKeys =
    state.rewindControlTurnKeys ?? new Set<string>();
  // 修复原因：编辑/重试会通过内部 `/rewind conversation <messageId>` 控制命令回滚上下文。
  // 该命令的 TurnComplete.response 只是协议 ACK，不是 assistant 回复；不能合成聊天气泡。
  if (isConversationRewindControlInput(input)) {
    rewindControlTurnKeys.add(turnKey);
  } else {
    rewindControlTurnKeys.delete(turnKey);
  }
  state.rewindControlTurnKeys = rewindControlTurnKeys;
}

function isConversationRewindControlInput(input: string | undefined): boolean {
  const normalized = input?.trim();
  if (!normalized?.startsWith("/rewind ")) {
    return false;
  }
  const [scope, target, ...rest] = normalized
    .slice("/rewind ".length)
    .trim()
    .split(/\s+/);
  return (
    rest.length === 0 &&
    Boolean(target) &&
    (scope === "conversation" || scope === "message" || scope === "both")
  );
}
