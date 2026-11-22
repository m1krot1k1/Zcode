import type { InputId, ZCodePersistedFileChange, ZCodeUsage } from "@zcode/shared";

export interface ComposerInputTimingState {
  inputStartTime: number;
  inputFirstCharTime: number;
}

export interface PromptTelemetryState {
  taskId: string;
  messageId: string;
  inputId?: InputId;
  baseEventExtraDetail: Record<string, string>;
  sendTime: number;
  inputStartTime: number;
  inputFirstCharTime: number;
  waitingMs: number;
  permissionWaitsByRequestId: Map<string, PermissionWaitState>;
  firstTokenAt: number | null;
  usage: ZCodeUsage | null;
  usageEventKeys: Set<string>;
  finalizedAgentStepCount: number;
  toolCallTotal: number;
  toolCallFailed: number;
  firstToolCallError: string;
}

export interface PermissionWaitState {
  requestedAt: number;
  toolCallId?: string;
}

export interface FinalizePromptTelemetryInput {
  taskId: string;
  status: string;
  finishedAt: number;
  fileChanges?: readonly ZCodePersistedFileChange[];
  usage?: ZCodeUsage;
  errorType?: string;
  errorMsg?: string;
  messageSource?: PromptMessageSource;
  agentComposition?: AgentComposition;
}

/** 独立 background wake 轮的来源：Agent 工具的后台子代理，或 dynamic-workflow run 的通知。 */
export type PromptMessageSource = "background_subagent" | "background_workflow";

/**
 * `message_completion.agent_composition`：本轮消费过哪些 Subagent 结果（fg = 前台、bg = 后台、
 * wf = 动态工作流 run）。八个值 = 三个布尔的组合。
 */
export type AgentComposition =
  | "main_only"
  | "main_plus_fg"
  | "main_plus_bg"
  | "main_plus_wf"
  | "main_plus_fg_bg"
  | "main_plus_fg_wf"
  | "main_plus_bg_wf"
  | "main_plus_fg_bg_wf";

export interface FinalizedPromptTelemetry {
  taskId: string;
  messageId: string;
  eventExtraDetail: Record<string, string>;
}

export type AgentStepType = "reasoning" | "tool_call" | "generation";
export type GenerationCloseReason = "reasoning" | "tool_call" | "task_complete" | "task_error";
export type AgentStepTelemetryClientMode = "desktop-continuous" | "web-remote-replayable";
export type AgentStepRole = "foreground subagent" | "background subagent" | "workflow subagent";

export interface ActiveAgentStep {
  stepId: string;
  stepType: AgentStepType;
  loopIndex: number;
  startedAt: number;
  waitingMs: number;
  model?: AgentStepModelIdentity;
  usage?: AgentStepUsageAttribution;
  lastMessageChunkAt?: number;
  toolId?: string;
  toolName?: string;
  agentId?: string;
  agentRole?: AgentStepRole;
  skillMetadata?: AgentStepSkillMetadata;
  pluginMetadata?: { pluginId: string; component: "mcp" };
}

export interface AgentStepSkillMetadata {
  name?: string;
  qualifiedName?: string;
  pluginId?: string;
  source?: "agents" | "cursor" | "zcode" | "bundled" | "plugin" | "remote";
}

export interface AgentStepModelIdentity {
  requestId?: string;
  modelName: string;
  modelProvider: string;
  providerName: string;
}

export interface AgentStepUsageAttribution {
  requestIds: string[];
  requestCount: number;
  scope: "model_request" | "subagent_requests";
  usage: ZCodeUsage;
}

export interface AgentStepToolAttribution {
  agentId?: string;
  agentRole?: AgentStepRole;
  modelName?: string;
  modelProvider?: string;
  providerName?: string;
}

export interface AgentStepTelemetryState {
  nextLoopIndex: number;
  currentModelRequest: AgentStepModelIdentity | null;
  pendingUsageByRequestId: Map<string, AgentStepUsageAttribution>;
  reasoningStep: ActiveAgentStep | null;
  generationStep: ActiveAgentStep | null;
  toolStepsById: Map<string, ActiveAgentStep>;
  settledPermissionWaitsByToolId: Map<string, SettledPermissionWaitAttribution>;
}

export interface SettledPermissionWaitAttribution {
  waitingMs: number;
  earliestRequestedAt: number;
}

export interface FinalizedAgentStepTelemetry {
  taskId: string;
  messageId: string;
  eventExtraDetail: Record<string, string>;
}
