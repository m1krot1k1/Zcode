import {
  extractPlanStepsFromToolInput,
  extractPlanStepsFromToolOutput,
  isMainAgentToolProjectionSource,
  attachZCodeBackgroundTaskNotificationToRaw,
  zcodeBackgroundTaskNotificationToolUpdateStatus,
  finalizeZCodeToolProjectionInput,
  forgetZCodeToolProjectionMetadata,
  resolveZCodeToolProjectionMetadata,
  type ZCodeBackgroundTaskNotificationInfo,
  type ZCodePersistedToolCall,
  type ZCodeStreamEvent,
  type InputId,
  type TraceId,
  type ZCodeMessagePart,
  type ZCodeToolProjectionMemory,
} from "@zcode/shared";
import { asRecord, stringValue } from "./primitives.js";

export function mapToolPart(
  part: Extract<ZCodeMessagePart, { type: "tool" }>,
  backgroundTaskNotifications?: ReadonlyMap<
    string,
    ZCodeBackgroundTaskNotificationInfo
  >,
): ZCodePersistedToolCall {
  const state = part.state;
  const taskNotification = backgroundTaskNotifications?.get(part.callId);
  // 修复原因：ZCode Protocol 的 part.callId 是实时流和终态 snapshot 共同的工具身份。
  // 以前只保存 metadata 会丢掉 toolCallId，手机 replayable 里 result-only 临时工具就无法被终态快照覆盖。
  const raw = attachZCodeBackgroundTaskNotificationToRaw(
    attachToolCallIdToRaw(
      "metadata" in state ? (state.metadata ?? state) : state,
      part.callId,
    ),
    taskNotification,
  );
  if (state.status === "completed") {
    // 修复原因：background Agent 的 completed 只代表 launch ACK；匹配的 failed
    // notification 才能在本次错误修复中覆盖它，不能顺带改变 stopped 等既有恢复语义。
    const notificationStatus = taskNotification?.status
      ? zcodeBackgroundTaskNotificationToolUpdateStatus(taskNotification.status)
      : undefined;
    const notificationFailed = notificationStatus === "failed";
    return {
      toolName: part.tool,
      title: state.title || part.tool,
      kind: part.tool,
      status: notificationFailed ? "failed" : "completed",
      input: state.input,
      output: state.output,
      ...(notificationFailed && taskNotification?.error
        ? { error: taskNotification.error }
        : {}),
      raw,
    };
  }
  if (state.status === "error") {
    return {
      toolName: part.tool,
      title: part.tool,
      kind: part.tool,
      status: "failed",
      input: state.input,
      error: state.error,
      raw,
    };
  }
  return {
    toolName: part.tool,
    title: "title" in state && state.title ? state.title : part.tool,
    kind: part.tool,
    input: state.input,
    raw,
  };
}

function attachToolCallIdToRaw(raw: unknown, toolCallId: string): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { toolCallId, raw };
  }
  return {
    ...raw,
    toolCallId:
      typeof (raw as Record<string, unknown>).toolCallId === "string"
        ? (raw as Record<string, unknown>).toolCallId
        : toolCallId,
  };
}

export function mapToolUpdated(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
  toolProjectionMemory?: ZCodeToolProjectionMemory,
): ZCodeStreamEvent[] {
  const toolId = stringValue(payload.toolCallId);
  if (!toolId) {
    return [];
  }
  const parentToolUseId = parentToolUseIdFromToolPayload(payload);
  const memory = toolProjectionMemory ?? {};
  const toolNameById = memory.toolNameById;
  const rememberedTool = resolveZCodeToolProjectionMetadata(
    payload,
    toolId,
    memory,
  );
  const rememberedToolName = rememberedTool.toolName;
  const rememberedInput = rememberedTool.hasInput
    ? rememberedTool.input
    : undefined;
  if ("input" in payload && "toolName" in payload) {
    const toolName = rememberedToolName ?? "tool";
    toolNameById?.set(toolId, toolName);
    const duplicateMaterializedInput =
      memory.completeToolInputById?.has(toolId) ?? false;
    if (duplicateMaterializedInput) {
      return [
        {
          type: "tool_call_update",
          taskId,
          traceId,
          ...(inputId ? { inputId } : {}),
          toolId,
          parentToolUseId,
          toolName,
          kind: toolName,
          status: toolStatusFromPayload(payload),
          raw: omitRepeatedToolInputFromRaw(payload),
        },
      ];
    }
    finalizeZCodeToolProjectionInput(toolId, payload.input, memory);
    const toolEvent: ZCodeStreamEvent = {
      type: "tool_call",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      toolId,
      parentToolUseId,
      input: payload.input,
      toolName,
      kind: toolName,
      title: toolName,
      raw: payload,
    };
    const planSteps = isMainAgentToolProjectionSource(payload)
      ? extractPlanStepsFromToolInput({
          title: toolName,
          kind: toolName,
          input: payload.input,
        })
      : null;
    return planSteps
      ? [
          toolEvent,
          {
            type: "plan",
            taskId,
            traceId,
            ...(inputId ? { inputId } : {}),
            steps: planSteps,
          },
        ]
      : [toolEvent];
  }
  if ("result" in payload) {
    const result = asRecord(payload.result);
    const toolName = rememberedToolName;
    const content = normalizeToolResultContent(toolName, result);
    const status = toolResultStatus(toolName, result);
    const toolEvent: ZCodeStreamEvent = {
      type: "tool_call_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      toolId,
      parentToolUseId,
      toolName,
      kind: toolName,
      title: toolName,
      ...(rememberedInput !== undefined ? { input: rememberedInput } : {}),
      status,
      content,
      error: stringValue(asRecord(result.error).message),
      raw: payload,
    };
    if (status !== "in_progress") {
      forgetZCodeToolProjectionMetadata(toolId, memory);
    }
    const planSteps = isMainAgentToolProjectionSource(payload)
      ? extractPlanStepsFromToolOutput({
          title: toolName,
          kind: toolName,
          output: content ?? result,
        })
      : null;
    return planSteps
      ? [
          toolEvent,
          {
            type: "plan",
            taskId,
            traceId,
            ...(inputId ? { inputId } : {}),
            steps: planSteps,
          },
        ]
      : [toolEvent];
  }
  if ("error" in payload) {
    forgetZCodeToolProjectionMetadata(toolId, memory);
    return [
      {
        type: "tool_call_update",
        taskId,
        traceId,
        ...(inputId ? { inputId } : {}),
        toolId,
        parentToolUseId,
        toolName: rememberedToolName,
        kind: rememberedToolName,
        title: rememberedToolName,
        ...(rememberedInput !== undefined ? { input: rememberedInput } : {}),
        status: "failed",
        error: stringValue(asRecord(payload.error).message) ?? "Tool failed",
        raw: payload,
      },
    ];
  }
  return [
    {
      type: "tool_call_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      toolId,
      parentToolUseId,
      toolName: rememberedToolName,
      kind: rememberedToolName,
      title: rememberedToolName,
      ...(rememberedInput !== undefined && payload.inputOmitted !== true
        ? { input: rememberedInput }
        : {}),
      status: "in_progress",
      raw: payload,
    },
  ];
}

function toolResultStatus(
  toolName: string | undefined,
  result: Record<string, unknown>,
): Extract<ZCodeStreamEvent, { type: "tool_call_update" }>["status"] {
  if (result.success === false) {
    return "failed";
  }
  if (isBackgroundAgentLaunchResult(toolName, result)) {
    // 修复原因：Agent 后台启动 ACK 只说明子 agent 已经开始运行；
    // replay/snapshot 投影不能把它当成最终完成，否则运行中会被前端显示为 completed。
    return "in_progress";
  }
  return "completed";
}

function isBackgroundAgentLaunchResult(
  toolName: string | undefined,
  result: Record<string, unknown>,
): boolean {
  const content = stringValue(result.content);
  if (!content) {
    return false;
  }
  if (
    (isSubagentDispatchToolName(toolName) || toolName === undefined) &&
    isBackgroundAgentLaunchAcknowledgement(content)
  ) {
    return true;
  }
  const parsed = parseJsonRecord(content);
  const parsedStatus = stringValue(parsed?.status);
  return (
    parsed !== null &&
    (isSubagentDispatchToolName(toolName) ||
      stringValue(parsed.agentId) !== undefined) &&
    ((parsedStatus === "backgrounded" &&
      stringValue(parsed.backgroundTaskId) !== undefined) ||
      (parsedStatus === "async_launched" &&
        stringValue(parsed.agentId) !== undefined &&
        stringValue(parsed.outputFile) !== undefined))
  );
}

function isBackgroundAgentLaunchAcknowledgement(content: string): boolean {
  // 修复原因：session projection 可能直接消费 replay/snapshot 结果，不能只依赖消息层兜底；
  // 新的 async_launched ACK 对齐 provider-visible output_file 文案，旧 session 仍保留 outputFile/backgroundTaskId 文案。
  return (
    isLegacyBackgroundAgentLaunchAcknowledgement(content) ||
    isPreviousBackgroundAgentLaunchAcknowledgement(content) ||
    isCurrentBackgroundAgentLaunchAcknowledgement(content)
  );
}

function isLegacyBackgroundAgentLaunchAcknowledgement(
  content: string,
): boolean {
  return (
    content.includes("backgroundTaskId:") &&
    content.includes("Runtime will wait for this background Agent")
  );
}

function isPreviousBackgroundAgentLaunchAcknowledgement(
  content: string,
): boolean {
  return (
    content.startsWith("Agent ") &&
    content.includes(" started in background.") &&
    content.includes("agentId:") &&
    content.includes("outputFile:") &&
    content.includes("You will be notified when the Agent completes.")
  );
}

function isCurrentBackgroundAgentLaunchAcknowledgement(
  content: string,
): boolean {
  return (
    content.startsWith("Async agent launched successfully.") &&
    content.includes("agentId:") &&
    content.includes("The agent is working in the background.") &&
    content.includes("notified automatically when it completes")
  );
}

function isSubagentDispatchToolName(toolName: string | undefined): boolean {
  return toolName === "Agent" || toolName === "Task";
}

function toolStatusFromPayload(
  payload: Record<string, unknown>,
): Extract<ZCodeStreamEvent, { type: "tool_call_update" }>["status"] {
  switch (stringValue(payload.status)) {
    case "tool_started":
      return "in_progress";
    case "tool_denied":
      return "denied";
    case "tool_result_committed":
    case "tool_call_closed":
    case "tool_queued":
    default:
      return "pending";
  }
}

function omitRepeatedToolInputFromRaw(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const { input: _input, ...rest } = payload;
  return {
    ...rest,
    inputOmitted: true,
    inputRef: "tool_call",
  };
}

export function parentToolUseIdFromToolPayload(
  payload: Record<string, unknown>,
): string | null {
  // 修复原因：前端 replay/snapshot projection 可能绕过 services adapter；
  // 这里和服务层保持同一套 parentToolCallId -> parentToolUseId 归一规则。
  return (
    stringValue(payload.parentToolUseId) ??
    stringValue(payload.parentToolCallId) ??
    rawClaudeParentToolUseId(payload)
  );
}

function rawClaudeParentToolUseId(raw: unknown): string | null {
  const meta = asRecord(raw)._meta;
  const claudeCode = asRecord(meta).claudeCode;
  return stringValue(asRecord(claudeCode).parentToolUseId) ?? null;
}

function normalizeToolResultContent(
  toolName: string | undefined,
  result: Record<string, unknown>,
): unknown {
  const content = result.content;
  const agentActivity = parseAgentActivityResultContent(toolName, content);
  return agentActivity ?? stringValue(content);
}

function parseAgentActivityResultContent(
  toolName: string | undefined,
  content: unknown,
): { kind: "agent_activity"; content: string; thought?: string } | null {
  if (typeof content !== "string" || content.trim().length === 0) {
    return null;
  }
  const parsed = parseJsonRecord(content);
  if (!parsed) {
    return null;
  }
  const isAgentResult =
    toolName === "Agent" ||
    toolName === "Task" ||
    stringValue(parsed.agentId) !== undefined ||
    stringValue(parsed.agentType) !== undefined;
  if (!isAgentResult) {
    return null;
  }
  const output = agentTextFromContentField(parsed.content);
  if (!output) {
    return null;
  }
  const thought = stringValue(parsed.thought);
  return {
    kind: "agent_activity",
    content: output,
    ...(thought ? { thought } : {}),
  };
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function agentTextFromContentField(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const text = value
    .map((item) => stringValue(asRecord(item).text))
    .filter((item): item is string => Boolean(item))
    .join("\n");
  return text || undefined;
}
