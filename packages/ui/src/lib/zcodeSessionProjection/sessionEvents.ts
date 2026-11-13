import {
  normalizeAvailableZCodeMode,
  generateTraceId,
  type ZCodeStreamEvent,
  type ZCodeSessionEvent,
  type ZCodeSessionSettingsState,
  type ZCodeStateUpdatedNotification,
  type ZCodeUserInputRequestParams,
  type ZCodeUserInputResponse,
} from "@zcode/shared";
import { errorAttributionSchema } from "@zcode/shared/zcode-protocol-v4";
import {
  formatModelPickerValue,
  getZCodeAgentAvailableModes,
  resolveSettingsThoughtLevelCurrentValue,
} from "./config.js";
import {
  asRecord,
  stringArray,
  stringValue,
  turnSteerCommandKindValue,
  turnSteerSourceValue,
  type ZCodeSessionEventProjectionState,
  type ZCodeSessionProjectionMode,
} from "./primitives.js";
import {
  isUserInputBackedPermissionToolName,
  permissionPayloadToStreamEvent,
  permissionResolvedPayloadToStreamEvents,
} from "./permissions.js";
import { mapSessionInfoLikePayload } from "./sessionInfo.js";
import { mapModelStreaming } from "./toolStreaming.js";
import { mapToolUpdated } from "./tools.js";
import {
  compactFailureToTimelineEvent,
  mapCompactTimelinePayload,
  mapGoalVerificationTimelinePayload,
  mapSyntheticTimelinePartPayload,
} from "./timelines.js";
import {
  backgroundTaskNotificationToolUpdateFromInput,
  clearProjectionApiRetryState,
  ensureProjectionToolMemory,
  getActivePromptInputId,
  rememberRewindControlTurn,
  setActivePromptInputId,
  clearActivePromptInputId,
  takeProjectionApiRetryClearOnModelProgress,
  trackProjectionApiRetryEvents,
} from "./projectionState.js";
import { usageFromPayload } from "./usage.js";

export function zcodeSessionEventToZCodeStreamEvents(params: {
  event: ZCodeSessionEvent;
  projectionMode?: ZCodeSessionProjectionMode;
  state?: ZCodeSessionEventProjectionState;
  taskId: string;
}): ZCodeStreamEvent[] {
  const { event, state, taskId, projectionMode = "active-live" } = params;
  const protocolTraceId = event.traceId ?? generateTraceId(taskId);
  const payload = asRecord(event.payload);
  const inputId = stringValue(payload.inputId);
  const queryId = stringValue(payload.queryId);
  const activePromptInputId = getActivePromptInputId(state, event.sessionId);
  const toolProjectionMemory = ensureProjectionToolMemory(state);
  const toolNameById = toolProjectionMemory?.toolNameById;
  // 修复原因：UI 消费的 traceId 表示一次用户输入到本轮回复结束的轮次标识。
  // runtime trace 只在没有 inputId 时兜底，保证同一轮 chunk、工具调用和 complete 归到同一组。
  const eventInputId = inputId ?? activePromptInputId;
  const traceId = eventInputId ?? protocolTraceId;
  const turnKey = `${event.sessionId}:${event.turnId ?? eventInputId ?? traceId}`;

  if (event.type === "turn.started") {
    state?.streamedTurnKeys?.delete(turnKey);
    rememberRewindControlTurn(state, turnKey, stringValue(payload.input));
    if (inputId) {
      setActivePromptInputId(state, event.sessionId, inputId);
    }
    const runStartedEvent: ZCodeStreamEvent = {
      type: "task_run_started",
      taskId,
      traceId,
      ...(eventInputId ? { inputId: eventInputId } : {}),
      ...(event.turnId ? { turnId: event.turnId } : {}),
      startedAt: event.timestamp,
    };
    const taskNotificationToolUpdate =
      backgroundTaskNotificationToolUpdateFromInput({
        input: stringValue(payload.input),
        taskId,
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
          taskId,
          traceId,
          ...(eventInputId ? { inputId: eventInputId } : {}),
          ...(event.turnId ? { turnId: event.turnId } : {}),
          ...(stringValue(payload.targetId)
            ? { targetId: stringValue(payload.targetId) }
            : {}),
          startedAt: event.timestamp,
        },
      ];
    }
    return [runStartedEvent];
  }

  const compactTimeline = mapCompactTimelinePayload(
    taskId,
    traceId,
    eventInputId,
    payload,
  );
  if (compactTimeline) {
    state?.streamedTurnKeys?.add(turnKey);
    return [compactTimeline];
  }

  const partTimeline = mapSyntheticTimelinePartPayload(
    taskId,
    traceId,
    eventInputId,
    payload,
  );
  if (partTimeline) {
    state?.streamedTurnKeys?.add(turnKey);
    return [partTimeline];
  }

  const goalVerificationTimeline = mapGoalVerificationTimelinePayload(
    taskId,
    traceId,
    eventInputId,
    event.timestamp,
    payload,
  );
  if (goalVerificationTimeline) {
    state?.streamedTurnKeys?.add(turnKey);
    return [goalVerificationTimeline];
  }

  const modelStreaming = mapModelStreaming(
    taskId,
    traceId,
    eventInputId,
    payload,
    toolProjectionMemory,
    projectionMode,
  );
  const apiRetryClearEvent = takeProjectionApiRetryClearOnModelProgress(
    state,
    event.sessionId,
    taskId,
    traceId,
    eventInputId,
    payload,
  );
  if (modelStreaming) {
    if (modelStreaming.type === "agent_message_chunk") {
      state?.streamedTurnKeys?.add(turnKey);
    }
    return apiRetryClearEvent
      ? [apiRetryClearEvent, modelStreaming]
      : [modelStreaming];
  }
  if (apiRetryClearEvent) {
    return [apiRetryClearEvent];
  }

  switch (event.type) {
    case "tool.updated":
      return mapToolUpdated(
        taskId,
        traceId,
        eventInputId,
        payload,
        toolProjectionMemory,
      );
    case "permission.requested":
      if (stringValue(payload.toolCallId) && stringValue(payload.toolName)) {
        toolNameById?.set(
          stringValue(payload.toolCallId) ?? "",
          stringValue(payload.toolName) ?? "",
        );
      }
      if (isUserInputBackedPermissionToolName(stringValue(payload.toolName))) {
        // 修复原因：AskUserQuestion/ExitPlanMode 的 permission.requested 只是 runtime 等待态；
        // 真正的问题会从 interaction/requestUserInput 映射成 elicitation_request。
        return [];
      }
      return [
        permissionPayloadToStreamEvent(taskId, traceId, eventInputId, payload),
      ];
    case "permission.resolved":
      return permissionResolvedPayloadToStreamEvents(
        taskId,
        traceId,
        eventInputId,
        payload,
        toolNameById,
      );
    case "turn.steerQueued": {
      // 修复原因：desktop continuous 的 raw session event 不经过 service adapter；
      // 这里漏传 source 会把 ExitPlanMode 审批反馈误投影成普通手动 steer。
      const source = turnSteerSourceValue(payload.source);
      return [
        {
          type: "turn_steer_queued",
          taskId,
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
    case "turn.steerDrained": {
      return [
        {
          type: "turn_steer_status",
          taskId,
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
    case "turn.completed": {
      const events: ZCodeStreamEvent[] = [];
      const response = stringValue(payload.response);
      const isRewindControlTurn =
        state?.rewindControlTurnKeys?.has(turnKey) ?? false;
      if (
        response &&
        !isRewindControlTurn &&
        !state?.streamedTurnKeys?.has(turnKey)
      ) {
        events.push({
          type: "agent_message_chunk",
          taskId,
          traceId,
          ...(eventInputId ? { inputId: eventInputId } : {}),
          content: response,
        });
      }
      events.push({
        type: "task_complete",
        taskId,
        traceId,
        ...(eventInputId ? { inputId: eventInputId } : {}),
        stopReason: stringValue(payload.resultType) ?? "complete",
        usage: usageFromPayload(payload.usage),
      });
      state?.streamingToolInputById?.clear();
      state?.rewindControlTurnKeys?.delete(turnKey);
      state?.streamedTurnKeys?.delete(turnKey);
      clearProjectionApiRetryState(state, event.sessionId);
      if (eventInputId) {
        clearActivePromptInputId(state, event.sessionId, eventInputId);
      }
      return events;
    }
    case "turn.failed": {
      state?.streamingToolInputById?.clear();
      state?.rewindControlTurnKeys?.delete(turnKey);
      state?.streamedTurnKeys?.delete(turnKey);
      clearProjectionApiRetryState(state, event.sessionId);
      if (eventInputId) {
        clearActivePromptInputId(state, event.sessionId, eventInputId);
      }
      const errorPayload = asRecord(payload.error);
      if (stringValue(payload.turnPhase) === "compact") {
        return [
          compactFailureToTimelineEvent(
            taskId,
            traceId,
            eventInputId,
            stringValue(errorPayload.message) ?? "ZCode compact failed",
          ),
        ];
      }
      // 修复原因：旧 turn.failed → task_error 投影只保留文案/code/detail，live telemetry
      // 无法看到 adapter 已确认的 provider/network 事实；校验后透传安全归因字段。
      const attribution = errorAttributionSchema.safeParse(
        errorPayload.attribution,
      );
      return [
        {
          type: "task_error",
          taskId,
          traceId,
          ...(eventInputId ? { inputId: eventInputId } : {}),
          error: stringValue(errorPayload.message) ?? "ZCode session failed",
          code:
            stringValue(errorPayload.code) ?? stringValue(errorPayload.type),
          detail: stringValue(errorPayload.detail),
          ...(attribution.success ? { attribution: attribution.data } : {}),
        },
      ];
    }
    case "session.titleUpdated": {
      const title = stringValue(payload.title);
      return title
        ? [
            {
              type: "session_info_update",
              taskId,
              traceId,
              ...(eventInputId ? { inputId: eventInputId } : {}),
              title,
            },
          ]
        : [];
    }
    case "session.updated":
      return trackProjectionApiRetryEvents(
        state,
        event.sessionId,
        mapSessionInfoLikePayload(
          taskId,
          traceId,
          eventInputId,
          event.eventId,
          payload,
          state,
        ),
      );
    case "streamRecovery.updated":
      // 修复原因：SSE 断流恢复的权威进度先通过 streamRecovery.updated 到达。
      // 只依赖后续 model_request_started 会让部分会话看不到输入栏重试次数。
      return trackProjectionApiRetryEvents(
        state,
        event.sessionId,
        mapSessionInfoLikePayload(
          taskId,
          traceId,
          eventInputId,
          event.eventId,
          payload,
          state,
        ),
      );
    default:
      return [];
  }
}

export function zcodeStateUpdatedToZCodeStreamEvents(params: {
  notification: ZCodeStateUpdatedNotification;
  settings: ZCodeSessionSettingsState;
  taskId: string;
}): ZCodeStreamEvent[] {
  const traceId = generateTraceId(params.taskId);
  return [
    {
      type: "mode_update",
      taskId: params.taskId,
      traceId,
      currentModeId: normalizeAvailableZCodeMode(params.settings.mode.current),
      availableModes: getZCodeAgentAvailableModes(),
    },
    {
      type: "glm_agent_model_state_update",
      taskId: params.taskId,
      traceId,
      version: 1,
      sessionId: params.taskId,
      reason:
        params.notification.reason === "thought_level_changed"
          ? "thought_level_changed"
          : params.notification.reason === "model_changed"
            ? "model_changed"
            : "session_initialized",
      model: {
        currentValue: formatModelPickerValue(params.settings.model.current),
      },
      thoughtLevel: {
        enabled: params.settings.thoughtLevel.enabled,
        currentValue: resolveSettingsThoughtLevelCurrentValue(
          params.settings.thoughtLevel,
        ),
        options: params.settings.thoughtLevel.available.map((option) => ({
          value: option.value,
          name: option.label,
        })),
      },
      contextWindow: {
        tokens:
          params.settings.model.available.find(
            (option) =>
              formatModelPickerValue(option.ref) ===
              formatModelPickerValue(params.settings.model.current),
          )?.contextWindow ?? 0,
      },
    },
  ];
}

export function zcodeUserInputRequestToZCodeStreamEvent(
  taskId: string,
  request: ZCodeUserInputRequestParams,
): Extract<ZCodeStreamEvent, { type: "elicitation_request" }> {
  const questions =
    request.questions?.map((question) => ({
      question: question.question,
      header: question.header,
      options: question.options.map((option) => ({
        value: option.value,
        label: option.label,
        description: option.description,
      })),
      ...(question.multiSelect ? { multiSelect: true } : {}),
    })) ?? [];
  const firstQuestion = questions[0];
  return {
    type: "elicitation_request",
    taskId,
    traceId: generateTraceId(taskId),
    requestId: request.requestId,
    message: firstQuestion?.question ?? request.prompt ?? "Input required",
    header: firstQuestion?.header,
    options: firstQuestion?.options ?? [],
    ...(firstQuestion?.multiSelect ? { multiSelect: true } : {}),
    ...(questions.length > 0 ? { questions } : {}),
    ...(request.origin ? { origin: request.origin } : {}),
    schema: request.schema ?? request.input,
  };
}

export function zcodeUserInputResponseToZCodeStreamEvent(
  taskId: string,
  response: {
    requestId: string;
    action: ZCodeUserInputResponse["action"];
    content?: Record<string, unknown>;
  },
): Extract<ZCodeStreamEvent, { type: "elicitation_response" }> {
  return {
    type: "elicitation_response",
    taskId,
    traceId: generateTraceId(taskId),
    requestId: response.requestId,
    action: response.action,
    ...(response.content ? { content: response.content } : {}),
  };
}
