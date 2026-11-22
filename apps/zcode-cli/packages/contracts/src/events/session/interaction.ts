import type {
  PermissionOptionsPolicy,
  PermissionUpdate,
} from "../../interfaces/permission.port.js";
import type { RiskLevel } from "../../interfaces/session.port.js";
import type { InteractionRequestOrigin, ToolCallId } from "../../interfaces/shared.js";
import type { SessionGoal } from "../../tools/target.js";
import type { ToolResultDisplayPayload } from "../../tools/tool-result-metadata.js";

// -----------------------------------------------
// Permission, plugin UI, workspace hook and target payloads
// -----------------------------------------------

export interface PermissionRequestedPayload {
  approvalMode?: "user-once";
  requestId?: string;
  toolCallId: ToolCallId;
  toolName: string;
  riskLevel: RiskLevel;
  reason: string;
  input: unknown;
  suggestedPermissionUpdates?: PermissionUpdate[];
  origin?: InteractionRequestOrigin;
  /**
   * 工具自报的确认预览，由 `prepareApproval` 钩子产出。复用结果通道的 display 投影，
   * 让 ask 与结果卡共享同一套有界形状，不新增无界字段。
   */
  display?: ToolResultDisplayPayload;
  fullAccessSupported?: boolean;
  optionsPolicy?: PermissionOptionsPolicy;
}

/** 订阅者以 (scopeId, generation) 标识沙箱实例；renderer 只投递给 generation 一致的实例。 */
export interface PluginUiResourceSubscriberRef {
  instance: import("@zcode/shared/mcp-apps").McpAppInstance;
  scopeId: string;
  generation: number;
}
export interface PluginUiResourceUpdatedPayload {
  pluginId: string;
  serverName: string;
  uri: string;
  subscribers: PluginUiResourceSubscriberRef[];
}
export interface PluginUiResourceListChangedPayload {
  pluginId: string;
  serverName: string;
  subscribers: PluginUiResourceSubscriberRef[];
}
/** App-Provided Tools：一次待执行的页面工具调用，投递给 subscribers 里唯一的实例。 */
export interface PluginUiAppToolCallRequestedPayload {
  activity?: boolean;
  cancelled?: boolean;
  pluginId: string;
  serverName: string;
  subscribers: PluginUiResourceSubscriberRef[];
  callId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface PermissionResolvedPayload {
  requestId?: string;
  toolCallId: ToolCallId;
  decision: PermissionDecision;
  reason?: string;
  modifiedInput?: unknown;
}

export interface PermissionDeniedPayload {
  toolCallId: ToolCallId;
  toolName: string;
  reason: string;
  inputSummary?: unknown;
}

export type UserInputAutoResolutionState =
  | {
      state: "hiddenGrace" | "visibleCountdown";
      startedAt: number;
      visibleAt: number;
      deadlineAt: number;
    }
  | {
      state: "snoozed";
      startedAt: number;
      snoozedAt: number;
    };

export interface UserInputAutoResolutionUpdatedPayload {
  interactionId: string;
  toolCallId: ToolCallId;
  autoResolution: UserInputAutoResolutionState;
}

export interface WorkspaceHookReviewRequestedPayload {
  request: unknown;
}

export interface WorkspaceHookReviewSettledPayload {
  interactionId: string;
  state: "resolved" | "timed_out" | "configuration_error";
  reasonCode?: string;
}

export interface WorkspaceHookReviewSupersededPayload {
  interactionId: string;
  supersededByInteractionId: string;
}

// 软门禁:准入层完成评估后上报 pending 状态。
// pendingCount = configuredEnabled && admissionClass === "pending" 的声明数;
// pendingCount === 0 → 投影层将 snapshot.workspaceHookAdmission 置 null(提示条消失)。
export interface WorkspaceHookAdmissionUpdatedPayload {
  pendingCount: number;
  bundleDigest: string;
  workspaceIdentity?: string;
}

export type PermissionDecision = "allow" | "deny" | "escalate" | "modify";

export type TargetChangedAction =
  | "set"
  | "status_updated"
  | "cleared"
  | "usage_accounted"
  | "run_started"
  | "run_finished"
  | "summary_updated";

export type TargetChangedSource = "command" | "tool" | "runtime";

export interface TargetChangedPayload {
  action: TargetChangedAction;
  source: TargetChangedSource;
  target: SessionGoal | null;
  previousTarget?: SessionGoal | null;
}
