import type { ZCodeStreamEvent } from "@zcode/shared";

import {
  applyAgentStepSkillMetadata,
  applyAgentStepToolAttribution,
} from "./agentStepAttribution.js";
import {
  closeGenerationStep,
  closeReasoningStep,
  closeToolSteps,
  createAgentStep,
  cronCreateAutomationId,
  finalizeAgentStep,
  markPromptFirstToken,
} from "./agentStepLifecycle.js";
import {
  applySettledPermissionWaitAttribution,
  findEarliestPermissionRequestedAt,
  settleAllPermissionWaits,
  settlePermissionWaitsForTool,
} from "./permissionWaits.js";
import {
  activePromptTelemetryByTask,
  agentStepTelemetryByTask,
  getAgentStepTelemetryState,
} from "./state.js";
import type {
  AgentStepSkillMetadata,
  AgentStepTelemetryClientMode,
  AgentStepTelemetryState,
  AgentStepToolAttribution,
  FinalizedAgentStepTelemetry,
  PromptTelemetryState,
} from "./types.js";

export function materializePendingModelUsageBeforeTool(input: {
  prompt: PromptTelemetryState;
  state: AgentStepTelemetryState;
  now: number;
  finalized: FinalizedAgentStepTelemetry[];
  clientMode?: AgentStepTelemetryClientMode;
}): void {
  const requestId = input.state.currentModelRequest?.requestId;
  if (
    !requestId ||
    input.state.reasoningStep ||
    input.state.generationStep ||
    !input.state.pendingUsageByRequestId.has(requestId)
  ) {
    return;
  }

  // Bug 根因：模型直接返回 tool_use 时没有正文 step，旧逻辑会让 pending usage
  // 被随后创建的工具 step 消费。Agent 工具再叠加 child usage 后，就会把主模型 A
  // 和 child 模型 B 的 token 混在同一模型维度。这里补一个零时长 generation，
  // 只承接本次真实模型 request；工具 step 保持独立，等待工具或前台 child 的事实。
  input.state.generationStep = createAgentStep(input.state, "generation", input.now);
  closeGenerationStep(
    input.prompt,
    input.state,
    input.now,
    "success",
    input.finalized,
    undefined,
    "tool_call",
    input.clientMode,
  );
}

export function recordAgentStepTelemetryEvent(input: {
  taskId: string;
  event: ZCodeStreamEvent;
  activeInputId?: string;
  clientMode?: AgentStepTelemetryClientMode;
  toolAttribution?: AgentStepToolAttribution;
  skillMetadata?: AgentStepSkillMetadata;
  now?: number;
}): FinalizedAgentStepTelemetry[] {
  const prompt = activePromptTelemetryByTask.get(input.taskId);
  if (!prompt) {
    return [];
  }
  const eventInputId =
    "inputId" in input.event && typeof input.event.inputId === "string"
      ? input.event.inputId
      : undefined;
  if (input.activeInputId && eventInputId && input.activeInputId !== eventInputId) {
    // Bugfix：completion 改用逐 step 聚合后，旧 input 的迟到 chunk/tool 也会污染当前 message。
    // ownership 以 runtime activeInputId 为准，兼容 queued prompt 发送时实际 inputId 重绑定。
    return [];
  }

  const now = input.now ?? Date.now();
  const state = getAgentStepTelemetryState(input.taskId);
  const finalized: FinalizedAgentStepTelemetry[] = [];

  switch (input.event.type) {
    case "agent_thought_chunk":
      markPromptFirstToken(prompt, now);
      if (!state.reasoningStep) {
        closeGenerationStep(
          prompt,
          state,
          now,
          "success",
          finalized,
          undefined,
          "reasoning",
          input.clientMode,
        );
        state.reasoningStep = createAgentStep(state, "reasoning", now);
      }
      return finalized;

    case "agent_message_chunk":
      if (input.event.zcodeTimeline) {
        return finalized;
      }
      if (input.event.parentToolUseId) {
        // 修复原因：带 parentToolUseId 的 chunk 是工具/子 agent 输出，UI 会挂到工具卡片；
        // 不能把它当主 assistant 正文创建 generation step 或刷新正文尾包时间。
        return finalized;
      }
      markPromptFirstToken(prompt, now);
      closeReasoningStep(prompt, state, now, finalized);
      if (!state.generationStep) {
        state.generationStep = createAgentStep(state, "generation", now);
      }
      state.generationStep.lastMessageChunkAt = now;
      return finalized;

    case "tool_call": {
      markPromptFirstToken(prompt, now);
      closeReasoningStep(prompt, state, now, finalized);
      closeGenerationStep(
        prompt,
        state,
        now,
        "success",
        finalized,
        undefined,
        "tool_call",
        input.clientMode,
      );
      materializePendingModelUsageBeforeTool({
        prompt,
        state,
        now,
        finalized,
        clientMode: input.clientMode,
      });
      const toolStep = createAgentStep(state, "tool_call", now, {
        toolId: input.event.toolId,
        toolName: input.event.toolName ?? input.event.kind,
      });
      applyAgentStepToolAttribution(toolStep, input.toolAttribution);
      if (input.event.pluginMetadata) toolStep.pluginMetadata = input.event.pluginMetadata;
      applyAgentStepSkillMetadata(toolStep, input.skillMetadata ?? input.event.skillMetadata);
      applySettledPermissionWaitAttribution(state, toolStep);
      state.toolStepsById.set(input.event.toolId, toolStep);
      return finalized;
    }

    case "tool_call_update": {
      markPromptFirstToken(prompt, now);
      if (input.event.status === "pending" || input.event.status === "in_progress") {
        if (!state.toolStepsById.has(input.event.toolId)) {
          closeReasoningStep(prompt, state, now, finalized);
          closeGenerationStep(
            prompt,
            state,
            now,
            "success",
            finalized,
            undefined,
            "tool_call",
            input.clientMode,
          );
          materializePendingModelUsageBeforeTool({
            prompt,
            state,
            now,
            finalized,
            clientMode: input.clientMode,
          });
          const toolStep = createAgentStep(state, "tool_call", now, {
            toolId: input.event.toolId,
            toolName: input.event.toolName ?? input.event.kind,
          });
          applyAgentStepToolAttribution(toolStep, input.toolAttribution);
          if (input.event.pluginMetadata) toolStep.pluginMetadata = input.event.pluginMetadata;
          applyAgentStepSkillMetadata(toolStep, input.skillMetadata ?? input.event.skillMetadata);
          applySettledPermissionWaitAttribution(state, toolStep);
          state.toolStepsById.set(input.event.toolId, toolStep);
        }
        return finalized;
      }

      let existing = state.toolStepsById.get(input.event.toolId);
      if (!existing) {
        materializePendingModelUsageBeforeTool({
          prompt,
          state,
          now,
          finalized,
          clientMode: input.clientMode,
        });
        existing = createAgentStep(
          state,
          "tool_call",
          findEarliestPermissionRequestedAt(prompt, state, input.event.toolId) ?? now,
          {
            toolId: input.event.toolId,
            toolName: input.event.toolName ?? input.event.kind,
          },
        );
      }
      if (input.event.pluginMetadata) existing.pluginMetadata = input.event.pluginMetadata;
      applyAgentStepSkillMetadata(existing, input.skillMetadata ?? input.event.skillMetadata);
      applyAgentStepToolAttribution(existing, input.toolAttribution);
      // 修复原因：恢复/乱序链路可能先看到 permission_request，随后直接收到工具终态，
      // 没有前置 tool_call。先回填已收口等待，再把兜底 step 放回索引消费仍开放的等待，
      // 最后校正 startedAt，保证工具墙钟耗时始终覆盖 waiting_ms。
      applySettledPermissionWaitAttribution(state, existing);
      state.toolStepsById.set(input.event.toolId, existing);
      settlePermissionWaitsForTool(prompt, state, input.event.toolId, now);
      existing.startedAt = Math.min(existing.startedAt, now - existing.waitingMs);
      state.toolStepsById.delete(input.event.toolId);
      finalized.push(
        finalizeAgentStep({
          prompt,
          step: {
            ...existing,
            toolName: input.event.toolName ?? input.event.kind ?? existing.toolName,
          },
          finishedAt: now,
          status: input.event.status,
          errorType: input.event.status === "failed" ? "TOOL_EXEC_ERROR" : undefined,
          errorMsg: input.event.error,
          // Bug 原因：兼容流过去只把工具名和状态交给 agent_step，CronCreate
          // 返回的新任务 ID 留在 content 中，导致运营无法关联创建步骤与任务。
          automationId:
            input.event.status === "completed" &&
            (input.event.toolName ?? input.event.kind ?? existing.toolName) === "CronCreate"
              ? cronCreateAutomationId(input.event.content)
              : undefined,
        }),
      );
      return finalized;
    }

    case "task_complete":
      settleAllPermissionWaits(prompt, state, now);
      closeReasoningStep(prompt, state, now, finalized);
      closeGenerationStep(
        prompt,
        state,
        now,
        "success",
        finalized,
        undefined,
        "task_complete",
        input.clientMode,
      );
      closeToolSteps(prompt, state, now, "success", finalized);
      agentStepTelemetryByTask.delete(input.taskId);
      return finalized;

    case "task_error":
      settleAllPermissionWaits(prompt, state, now);
      closeReasoningStep(prompt, state, now, finalized);
      closeGenerationStep(
        prompt,
        state,
        now,
        "fail",
        finalized,
        {
          type: input.event.code ?? "UNKNOWN",
          msg: input.event.error,
        },
        "task_error",
        input.clientMode,
      );
      closeToolSteps(prompt, state, now, "fail", finalized, {
        type: input.event.code ?? "UNKNOWN",
        msg: input.event.error,
      });
      agentStepTelemetryByTask.delete(input.taskId);
      return finalized;

    default:
      return finalized;
  }
}
