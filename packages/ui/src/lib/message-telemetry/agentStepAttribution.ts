import type { ZCodeUsage } from "@zcode/shared";
import { sanitizeTelemetrySkillName } from "@zcode/shared";

import { agentStepTelemetryByTask } from "./state.js";
import { mergePromptUsage } from "./usage.js";
import type {
  ActiveAgentStep,
  AgentStepRole,
  AgentStepSkillMetadata,
  AgentStepTelemetryState,
  AgentStepToolAttribution,
  AgentStepUsageAttribution,
} from "./types.js";

export function findModelOutputStepForRequest(
  state: AgentStepTelemetryState,
  requestId: string,
): ActiveAgentStep | undefined {
  const candidates = [state.generationStep, state.reasoningStep];
  return candidates.find((step) => step?.model?.requestId === requestId) ?? undefined;
}

export function assignUsageToStep(
  step: ActiveAgentStep,
  attribution: AgentStepUsageAttribution,
): void {
  step.usage = step.usage
    ? {
        requestIds: [...new Set([...step.usage.requestIds, ...attribution.requestIds])],
        requestCount: step.usage.requestCount + attribution.requestCount,
        scope:
          step.usage.scope === "subagent_requests" || attribution.scope === "subagent_requests"
            ? "subagent_requests"
            : "model_request",
        usage: mergePromptUsage(step.usage.usage, attribution.usage),
      }
    : attribution;
}

/**
 * 将 Subagent 的真实模型与累计 usage 写入其 Agent step。
 * foreground 使用父 task state，background 使用 detached child state。
 */
export function recordSubagentToolAttribution(input: {
  taskId: string;
  toolCallId: string;
  requestIds: string[];
  requestCount: number;
  modelName: string;
  modelProvider: string;
  providerName: string;
  agentId: string;
  agentRole?: AgentStepRole;
  usage?: ZCodeUsage;
}): void {
  const state = agentStepTelemetryByTask.get(input.taskId);
  const step = state?.toolStepsById.get(input.toolCallId);
  if (!step) return;

  step.agentId = input.agentId;
  step.agentRole = input.agentRole ?? "foreground subagent";
  if (input.modelName || input.modelProvider || input.providerName) {
    step.model = {
      modelName: input.modelName,
      modelProvider: input.modelProvider,
      providerName: input.providerName,
    };
  }
  if (input.usage) {
    // Bug 根因：取消/失败时父 Agent 工具终态可能早于 SubagentStopped。若只在 stopped
    // 时首次归因，工具 step 已从活动索引删除，只能错误回退主模型且 token 为 0。
    // child fact 每次携带的是当前生命周期累计值，这里覆盖而不是叠加，避免增量同步重复计数。
    step.usage = {
      requestIds: [...input.requestIds],
      requestCount: input.requestCount,
      scope: "subagent_requests",
      usage: { ...input.usage },
    };
  }
}

export function applyAgentStepToolAttribution(
  step: ActiveAgentStep,
  attribution: AgentStepToolAttribution | undefined,
): void {
  if (!attribution) return;
  if (attribution.agentId) {
    step.agentId = attribution.agentId;
    step.agentRole = attribution.agentRole ?? "foreground subagent";
  }
  if (attribution.modelName || attribution.modelProvider || attribution.providerName) {
    step.model = {
      modelName: attribution.modelName ?? "",
      modelProvider: attribution.modelProvider ?? "",
      providerName: attribution.providerName ?? "",
    };
  }
}

export function applyAgentStepSkillMetadata(
  step: ActiveAgentStep,
  metadata: AgentStepSkillMetadata | undefined,
): void {
  if (!metadata || step.toolName !== "Skill") return;
  // 只接收已解析 metadata；绝不能用 input.skill/name 补齐失败调用的名称。
  const name =
    metadata.source && metadata.name !== undefined
      ? sanitizeTelemetrySkillName(metadata.name)
      : undefined;
  step.skillMetadata = {
    ...step.skillMetadata,
    ...(name ? { name } : {}),
    ...(metadata.qualifiedName ? { qualifiedName: metadata.qualifiedName } : {}),
    ...(metadata.pluginId ? { pluginId: metadata.pluginId } : {}),
    ...(metadata.source ? { source: metadata.source } : {}),
  };
}
