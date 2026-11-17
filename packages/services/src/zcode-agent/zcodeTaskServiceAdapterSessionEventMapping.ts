/**
 * zcodeTaskServiceAdapterSessionEventMapping.ts: Маппинг session event'ов ZCode Agent в stream-события.
 */
import type { TaskTarget } from "./zcodeTaskServiceAdapterCore.js";
import type {
  InputId,
  ZCodeBackgroundTaskControlItem,
  ZCodeSessionEvent,
  ZCodeStateUpdatedNotification,
  ZCodeStreamEvent,
  ZCodeToolProjectionMemory,
} from "@zcode/shared";
import {
  formatModelPickerValue,
  getZCodeAgentAvailableModes,
  normalizeAvailableZCodeMode,
} from "./zcodeConfigOptions.js";
import { logger } from "./zcodeTaskServiceAdapterCore.js";
import { permissionPayloadToStreamEvent } from "./zcodeTaskServiceAdapterElicitationMapping.js";
import { backgroundTaskNotificationToolUpdateFromInput } from "./zcodeTaskServiceAdapterMessageMapping.js";
import {
  asRecord,
  isUserInputBackedPermissionToolName,
  stringArray,
  stringValue,
  turnSteerCommandKindValue,
  turnSteerSourceValue,
  usageFromPayload,
} from "./zcodeTaskServiceAdapterRuntimePayloads.js";
import {
  mapSessionInfoLikePayload,
  permissionResolvedPayloadToStreamEvents,
} from "./zcodeTaskServiceAdapterSessionInfoPayloads.js";
import {
  mapCompactTimelinePayload,
  mapModelStreaming,
  mapSyntheticTimelinePartPayload,
  maybeBuildApiRetryClearOnModelProgress,
} from "./zcodeTaskServiceAdapterStreamingToolInput.js";
import {
  compactFailureToTimelineEvent,
  mapToolUpdated,
  parentToolUseIdFromToolPayload,
} from "./zcodeTaskServiceAdapterToolUpdateMapping.js";
import {
  generateTraceId,
  resolveWorkspaceKey,
  zcodeFileTransactionEventPayloadSchema,
  zcodeSessionSettingsStateSchema,
} from "@zcode/shared";
import { errorAttributionSchema } from "@zcode/shared/zcode-protocol-v4";

export function mapStateUpdated(
  params: TaskTarget,
  notification: ZCodeStateUpdatedNotification,
): ZCodeStreamEvent[] {
  const parsedSettings = zcodeSessionSettingsStateSchema.safeParse(notification.patch);
  if (!parsedSettings.success) {
    return [];
  }
  const traceId = generateTraceId(params.taskId);
  return [
    {
      type: "mode_update",
      taskId: params.taskId,
      traceId,
      currentModeId: normalizeAvailableZCodeMode(parsedSettings.data.mode.current),
      availableModes: getZCodeAgentAvailableModes(),
    },
    {
      type: "glm_agent_model_state_update",
      taskId: params.taskId,
      traceId,
      version: 1,
      sessionId: params.taskId,
      reason:
        notification.reason === "thought_level_changed"
          ? "thought_level_changed"
          : notification.reason === "model_changed"
            ? "model_changed"
            : "session_initialized",
      model: {
        currentValue: formatModelPickerValue(parsedSettings.data.model.current),
      },
      thoughtLevel: {
        enabled: parsedSettings.data.thoughtLevel.enabled,
        currentValue: parsedSettings.data.thoughtLevel.current,
        options: parsedSettings.data.thoughtLevel.available.map((option) => ({
          value: option.value,
          name: option.label,
        })),
      },
      contextWindow: {
        tokens:
          parsedSettings.data.model.available.find(
            (option) =>
              formatModelPickerValue(option.ref) ===
              formatModelPickerValue(parsedSettings.data.model.current),
          )?.contextWindow ?? 0,
      },
    },
  ];
}

export function mapSessionEvent(
  params: TaskTarget,
  event: ZCodeSessionEvent,
  streamedTurnText: Map<string, { messageId?: string; text: string }>,
  activePromptInputId?: InputId,
  toolProjectionMemory?: ZCodeToolProjectionMemory,
  backgroundTaskControlsByTaskKey?: Map<string, ZCodeBackgroundTaskControlItem[]>,
  hasActiveApiRetry = false,
): ZCodeStreamEvent[] {
  const protocolTraceId = event.traceId ?? generateTraceId(params.taskId);
  const payload = asRecord(event.payload);
  const inputId = stringValue(payload.inputId);
  const queryId = stringValue(payload.queryId);
  // 兼容层对外的 traceId 语义是“一次用户输入到本轮回复结束”的轮次标识。
  // ZCode Protocol runtime trace 只在事件没有 inputId 时兜底，避免同一轮 chunk/tool/complete 被拆成不同 trace。
  const eventInputId = inputId ?? activePromptInputId;
  const traceId = eventInputId ?? protocolTraceId;
  if (eventInputId && eventInputId !== protocolTraceId) {
    logger.debug(
      eventInputId,
      `对齐 ZCode prompt inputId eventType=${event.type} protocolTrace=${protocolTraceId}`,
    );
  }
  const turnKey = `${resolveWorkspaceKey(params)}:${event.sessionId}:${event.turnId ?? eventInputId ?? traceId}`;

  if (event.type === "turn.started") {
    streamedTurnText.delete(turnKey);
    const inputOrigin = asRecord(payload.intent).inputOrigin;
    const runStartedEvent: ZCodeStreamEvent = {
      ...(inputOrigin === "desktop" || inputOrigin === "mobile" ? { inputOrigin } : {}),
      type: "task_run_started",
      taskId: params.taskId,
      traceId,
      ...(eventInputId ? { inputId: eventInputId } : {}),
      ...(event.turnId ? { turnId: event.turnId } : {}),
      startedAt: event.timestamp,
    };
    const taskNotificationToolUpdate = backgroundTaskNotificationToolUpdateFromInput({
      input: stringValue(payload.input),
      taskId: params.taskId,
      traceId,
      inputId: eventInputId,
    });
    if (taskNotificationToolUpdate) {
      return [runStartedEvent, taskNotificationToolUpdate];
    }
    if (
      stringValue(payload.inputSource) === "goal-continuation" &&
      stringValue(payload.inputVisibility) === "model-only"
    ) {
      return [
        runStartedEvent,
        {
          type: "goal_iteration_started",
          taskId: params.taskId,
          traceId,
          ...(eventInputId ? { inputId: eventInputId } : {}),
          ...(stringValue(payload.targetId) ? { targetId: stringValue(payload.targetId) } : {}),
          startedAt: event.timestamp,
        },
      ];
    }
    return [runStartedEvent];
  }

  const compactTimeline = mapCompactTimelinePayload(params.taskId, traceId, eventInputId, payload);
  if (compactTimeline) {
    return [compactTimeline];
  }

  const partTimeline = mapSyntheticTimelinePartPayload(
    params.taskId,
    traceId,
    eventInputId,
    payload,
  );
  if (partTimeline) {
    return [partTimeline];
  }

  const modelStreaming = mapModelStreaming(
    params.taskId,
    traceId,
    eventInputId,
    payload,
    toolProjectionMemory,
  );
  const apiRetryClearEvent = maybeBuildApiRetryClearOnModelProgress(
    hasActiveApiRetry,
    params.taskId,
    traceId,
    eventInputId,
    payload,
  );
  if (modelStreaming) {
    if (modelStreaming.type === "agent_message_chunk" && !modelStreaming.parentToolUseId) {
      const previous = streamedTurnText.get(turnKey);
      const messageId = modelStreaming.messageId;
      const sameMessage = !messageId || !previous?.messageId || messageId === previous.messageId;
      streamedTurnText.set(turnKey, {
        messageId: messageId ?? previous?.messageId,
        text: (sameMessage ? (previous?.text ?? "") : "") + modelStreaming.content,
      });
    }
    return apiRetryClearEvent ? [apiRetryClearEvent, modelStreaming] : [modelStreaming];
  }
  if (apiRetryClearEvent) {
    return [apiRetryClearEvent];
  }

  if (event.type === "fileTransaction.updated") {
    // Инкремент 4.2: владелец факта — CLI; сервис лишь зеркалит его в поток,
    // сохраняя форму payload (полный patch либо компактная сводка).
    const parsed = zcodeFileTransactionEventPayloadSchema.safeParse(event.payload);
    if (!parsed.success) return [];
    return [
      {
        type: "file_transaction_update",
        taskId: params.taskId,
        traceId: traceId ?? generateTraceId(params.taskId),
        transaction: parsed.data,
        ...(eventInputId ? { inputId: eventInputId } : {}),
      },
    ];
  }

  if (event.type === "tool.updated") {
    // 工具调用前的前言不是最终回答；下一条模型消息需要独立核对已接收正文。
    if (payload.kind === "scheduled" && !parentToolUseIdFromToolPayload(payload)) {
      streamedTurnText.delete(turnKey);
    }
    return mapToolUpdated(params.taskId, traceId, eventInputId, payload, toolProjectionMemory);
  }

  if (event.type === "permission.requested") {
    const toolCallId = stringValue(payload.toolCallId);
    const toolName = stringValue(payload.toolName);
    if (toolCallId && toolName) {
      toolProjectionMemory?.toolNameById?.set(toolCallId, toolName);
    }
    if (isUserInputBackedPermissionToolName(toolName)) {
      // AskUserQuestion/ExitPlanMode 的 permission.requested 只是 core 的等待态标记；
      // 真正需要展示的问题会通过 interaction/requestUserInput 到达。继续把它投成普通权限，
      // UI 会出现 Allow/Deny 弹窗且无法把答案写回工具 input。
      return [];
    }
    return [permissionPayloadToStreamEvent(params.taskId, traceId, eventInputId, payload)];
  }

  if (event.type === "permission.resolved") {
    return permissionResolvedPayloadToStreamEvents(
      params.taskId,
      traceId,
      eventInputId,
      payload,
      toolProjectionMemory?.toolNameById,
    );
  }

  if (event.type === "turn.steerQueued") {
    const source = turnSteerSourceValue(payload.source);
    return [
      {
        type: "turn_steer_queued",
        taskId: params.taskId,
        traceId,
        ...(eventInputId ? { inputId: eventInputId } : {}),
        ...(queryId ? { queryId } : {}),
        pendingInputId: stringValue(payload.pendingInputId) ?? event.eventId,
        messageId: eventInputId,
        ...(turnSteerCommandKindValue(payload.commandKind)
          ? { commandKind: turnSteerCommandKindValue(payload.commandKind) }
          : {}),
        ...(source ? { source } : {}),
        targetTurnId: stringValue(payload.targetTurnId),
        content: stringValue(payload.input) ?? "",
        raw: payload,
      },
    ];
  }

  if (event.type === "turn.steerDrained") {
    return [
      {
        type: "turn_steer_status",
        taskId: params.taskId,
        traceId,
        ...(eventInputId ? { inputId: eventInputId } : {}),
        ...(stringArray(payload.queryIds).length > 0
          ? { queryIds: stringArray(payload.queryIds) }
          : {}),
        status: "drained",
        pendingInputIds: stringArray(payload.pendingInputIds),
        injectedMessageIds: stringArray(payload.injectedMessageIds),
        targetTurnId: stringValue(payload.targetTurnId),
        raw: payload,
      },
    ];
  }

  if (event.type === "turn.completed") {
    const events: ZCodeStreamEvent[] = [];
    const response = stringValue(payload.response);
    // Bugfix: 只记录“本轮收到过文字”会让工具前言屏蔽最终回答兜底。
    // 在终态之前补齐当前模型消息缺少的后缀；完整正文已到达时不重复投递。
    const streamed = streamedTurnText.get(turnKey)?.text ?? "";
    const missingResponse = response?.startsWith(streamed)
      ? response.slice(streamed.length)
      : response;
    if (missingResponse) {
      events.push({
        type: "agent_message_chunk",
        taskId: params.taskId,
        traceId,
        ...(eventInputId ? { inputId: eventInputId } : {}),
        content: missingResponse,
      });
    }
    events.push({
      type: "task_complete",
      taskId: params.taskId,
      traceId,
      ...(eventInputId ? { inputId: eventInputId } : {}),
      stopReason: stringValue(payload.resultType) ?? "complete",
      usage: usageFromPayload(payload.usage),
    });
    toolProjectionMemory?.streamingToolInputById?.clear();
    streamedTurnText.delete(turnKey);
    return events;
  }

  if (event.type === "turn.failed") {
    toolProjectionMemory?.streamingToolInputById?.clear();
    streamedTurnText.delete(turnKey);
    const errorPayload = asRecord(payload.error);
    if (stringValue(payload.turnPhase) === "compact") {
      return [
        compactFailureToTimelineEvent(
          params.taskId,
          traceId,
          eventInputId,
          stringValue(errorPayload.message) ?? "ZCode compact failed",
        ),
      ];
    }
    const attribution = errorAttributionSchema.safeParse(errorPayload.attribution);
    // dynamic task event 也会写入 task index；只修 snapshot 读路径仍会丢 live 归因。
    return [
      {
        type: "task_error",
        taskId: params.taskId,
        traceId,
        ...(eventInputId ? { inputId: eventInputId } : {}),
        error: stringValue(errorPayload.message) ?? "ZCode session failed",
        // type 是外层错误分类，code 才是 provider/subagent 要展示的真实错误码。
        code: stringValue(errorPayload.code) ?? stringValue(errorPayload.type),
        detail: stringValue(errorPayload.detail),
        ...(attribution.success ? { attribution: attribution.data } : {}),
      },
    ];
  }

  return mapSessionInfoLikePayload(
    params.taskId,
    traceId,
    eventInputId,
    event.eventId,
    payload,
    backgroundTaskControlsByTaskKey,
    `${resolveWorkspaceKey(params)}\u0000${params.taskId}`,
  );
}
