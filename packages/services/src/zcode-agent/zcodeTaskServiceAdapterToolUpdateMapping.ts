/**
 * zcodeTaskServiceAdapterToolUpdateMapping.ts: Маппинг tool_call_update, включая фоновые subagent-запуски.
 */
import type { InputId, TraceId, ZCodeStreamEvent, ZCodeToolProjectionMemory } from "@zcode/shared";
import {
  agentTextFromContentField,
  parseJsonRecord,
} from "./zcodeTaskServiceAdapterElicitationMapping.js";
import { asRecord, stringValue } from "./zcodeTaskServiceAdapterRuntimePayloads.js";
import {
  extractPlanStepsFromToolInput,
  extractPlanStepsFromToolOutput,
  finalizeZCodeToolProjectionInput,
  forgetZCodeToolProjectionMetadata,
  isMainAgentToolProjectionSource,
  resolveZCodeToolProjectionMetadata,
} from "@zcode/shared";

export function compactFailureToTimelineEvent(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  reason: string,
): Extract<ZCodeStreamEvent, { type: "agent_message_chunk" }> {
  return {
    type: "agent_message_chunk",
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    content: "",
    zcodeTimeline: {
      version: 1,
      kind: "synthetic",
      type: "context_compaction",
      operationId: `compact-failed-${inputId ?? traceId}`,
      status: /abort|cancel|interrupt|stop/i.test(reason) ? "interrupted" : "failed",
      trigger: "manual",
      display: "separator",
      ...(inputId ? { inputId } : {}),
      reason,
      endedAt: Date.now(),
    },
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
  const rememberedTool = resolveZCodeToolProjectionMetadata(payload, toolId, memory);
  const rememberedToolName = rememberedTool.toolName;
  const rememberedInput = rememberedTool.hasInput ? rememberedTool.input : undefined;
  if ("input" in payload && "toolName" in payload) {
    const toolName = rememberedToolName ?? "tool";
    toolNameById?.set(toolId, toolName);
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
    if (!planSteps) {
      return [toolEvent];
    }
    return [
      toolEvent,
      {
        type: "plan",
        taskId,
        traceId,
        ...(inputId ? { inputId } : {}),
        steps: planSteps,
      },
    ];
  }
  if ("result" in payload) {
    const result = asRecord(payload.result);
    // ZCode Protocol 的 ToolCallResult 只有 toolCallId/result，不再重复带 toolName。
    // 去掉 ZCode Agent 后如果不记住前序 ToolCallScheduled 的 TodoWrite 名称，result 里的 todos
    // 就只能当普通字符串输出，无法继续投射成顶部 todo/plan 事件。
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
    if (!planSteps) {
      return [toolEvent];
    }
    return [
      toolEvent,
      {
        type: "plan",
        taskId,
        traceId,
        ...(inputId ? { inputId } : {}),
        steps: planSteps,
      },
    ];
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

export function toolResultStatus(
  toolName: string | undefined,
  result: Record<string, unknown>,
): Extract<ZCodeStreamEvent, { type: "tool_call_update" }>["status"] {
  if (result.success === false) {
    return "failed";
  }
  if (isBackgroundAgentLaunchResult(toolName, result)) {
    // Agent 后台启动 ACK 只是子 agent 已创建，不代表子 agent 已完成；
    // 投影成 completed 会让前端在真实 completion 前把 subagent 卡片误标为完成。
    return "in_progress";
  }
  return "completed";
}

export function isBackgroundAgentLaunchResult(
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
    (isSubagentDispatchToolName(toolName) || stringValue(parsed.agentId) !== undefined) &&
    ((parsedStatus === "backgrounded" && stringValue(parsed.backgroundTaskId) !== undefined) ||
      (parsedStatus === "async_launched" &&
        stringValue(parsed.agentId) !== undefined &&
        stringValue(parsed.outputFile) !== undefined))
  );
}

export function isBackgroundAgentLaunchAcknowledgement(content: string): boolean {
  // subagent async launch 的模型可见 ACK 从 backgroundTaskId/outputFile 文案迁到 output_file 文案；
  // service projection 需要同时识别新旧格式，否则会把启动确认当成已完成结果发给 UI。
  return (
    isLegacyBackgroundAgentLaunchAcknowledgement(content) ||
    isPreviousBackgroundAgentLaunchAcknowledgement(content) ||
    isCurrentBackgroundAgentLaunchAcknowledgement(content)
  );
}

export function isLegacyBackgroundAgentLaunchAcknowledgement(content: string): boolean {
  return (
    content.includes("backgroundTaskId:") &&
    content.includes("Runtime will wait for this background Agent")
  );
}

export function isPreviousBackgroundAgentLaunchAcknowledgement(content: string): boolean {
  return (
    content.startsWith("Agent ") &&
    content.includes(" started in background.") &&
    content.includes("agentId:") &&
    content.includes("outputFile:") &&
    content.includes("You will be notified when the Agent completes.")
  );
}

export function isCurrentBackgroundAgentLaunchAcknowledgement(content: string): boolean {
  return (
    content.startsWith("Async agent launched successfully.") &&
    content.includes("agentId:") &&
    content.includes("The agent is working in the background.") &&
    content.includes("notified automatically when it completes")
  );
}

export function isSubagentDispatchToolName(toolName: string | undefined): boolean {
  return toolName === "Agent" || toolName === "Task";
}

export function parentToolUseIdFromToolPayload(payload: Record<string, unknown>): string | null {
  // ZCode Protocol 发送的父级字段叫 parentToolCallId；
  // UI stream 模型统一消费 parentToolUseId，必须在服务投影层完成一次性归一。
  return (
    stringValue(payload.parentToolUseId) ??
    stringValue(payload.parentToolCallId) ??
    rawClaudeParentToolUseId(payload)
  );
}

export function rawClaudeParentToolUseId(raw: unknown): string | null {
  const meta = asRecord(raw)._meta;
  const claudeCode = asRecord(meta).claudeCode;
  return stringValue(asRecord(claudeCode).parentToolUseId) ?? null;
}

export function normalizeToolResultContent(
  toolName: string | undefined,
  result: Record<string, unknown>,
): unknown {
  const content = result.content;
  const agentActivity = parseAgentActivityResultContent(toolName, content);
  return agentActivity ?? stringValue(content);
}

export function parseAgentActivityResultContent(
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
  // Agent 工具结果是 JSON 字符串，最终摘要在 content[].text；
  // 服务层先转成 agent_activity，避免 UI 每条渲染路径都猜原始 JSON。
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
