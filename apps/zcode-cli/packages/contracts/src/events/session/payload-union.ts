import type { CompactBoundaryPayload } from "../../compact/index.js";
import type { HookRunLifecyclePayload } from "../../hooks/index.js";
import type { CheckpointCreatedPayload, RewindTriggeredPayload } from "../../rewind/index.js";
import type {
  OpenCodeAgentPermissionUpdatedPayload,
  OpenCodeAgentRunUpdatedPayload,
  SwarmRunUpdatedPayload,
} from "./external-runtime.js";
import type {
  PermissionDeniedPayload,
  PermissionRequestedPayload,
  PermissionResolvedPayload,
  PluginUiAppToolCallRequestedPayload,
  PluginUiResourceListChangedPayload,
  PluginUiResourceUpdatedPayload,
  UserInputAutoResolutionUpdatedPayload,
  WorkspaceHookAdmissionUpdatedPayload,
  WorkspaceHookReviewRequestedPayload,
  WorkspaceHookReviewSettledPayload,
  WorkspaceHookReviewSupersededPayload,
} from "./interaction.js";
import type {
  ModelAnomalyWarningPayload,
  ModelCompletePayload,
  ModelErrorPayload,
  ModelNetworkStatusPayload,
  ModelRequestPayload,
  ModelSelectedPayload,
  ModelStreamingPayload,
  NetworkRequestStatusPayload,
  TurnExecutionModelFallbackPayload,
} from "./model.js";
import type {
  StreamRecoveryAnchorPayload,
  StreamRecoveryAnchorSelectedPayload,
  StreamRecoveryBlockedPayload,
  StreamRecoveryRetryStartedPayload,
  StreamRecoveryStartedPayload,
  StreamRecoveryTailDiscardedPayload,
  StreamingToolLedgerPayload,
} from "../stream-recovery.events.js";
import type {
  BackgroundTaskCompletedPayload,
  BackgroundTaskStartedPayload,
  BackgroundTaskUpdatedPayload,
  PrismEvidenceReceiptObservedPayload,
  PrismTaskContractDeclaredPayload,
  SubagentExecutionTerminalPayload,
  ToolBatchCompletePayload,
  ToolCallErrorPayload,
  ToolCallProgressPayload,
  ToolCallResultPayload,
  ToolCallScheduledPayload,
  ToolCallStartedPayload,
} from "./tool.js";
import type {
  AssistantMessagePayload,
  CompactLifecyclePayload,
  FollowupModeChangedPayload,
  MicrocompactBoundaryEventPayload,
  QueueAutoDrainChangedPayload,
  SessionCompactedPayload,
  SessionCreatedPayload,
  SessionForkedPayload,
  SessionInputPromotedPayload,
  SessionModeChangedPayload,
  SessionResumedPayload,
  SessionTitleUpdatedPayload,
  SystemMessagePayload,
  TargetCompletionVerificationPayload,
  TurnCompletePayload,
  TurnErrorPayload,
  TurnInputReceivedPayload,
  TurnStartedPayload,
  TurnSteerDeliveryChangedPayload,
  TurnSteerDiscardedPayload,
  TurnSteerDispatchChangedPayload,
  TurnSteerDrainedPayload,
  TurnSteerQueuedPayload,
  TurnSteerRejectedPayload,
  TurnSteerReorderedPayload,
  UserMessagePayload,
} from "./turn.js";
import type { DynamicWorkflowRunProgressPayload } from "./workflow-meta.js";

// -----------------------------------------------
// Session event payload union
// -----------------------------------------------

export type SessionEventPayload =
  | SessionCreatedPayload
  | SessionResumedPayload
  | SessionForkedPayload
  | SessionCompactedPayload
  | SessionTitleUpdatedPayload
  | SessionModeChangedPayload
  | TurnStartedPayload
  | TurnInputReceivedPayload
  | TurnSteerQueuedPayload
  | TurnSteerDeliveryChangedPayload
  | TurnSteerDispatchChangedPayload
  | TurnSteerDrainedPayload
  | TurnSteerReorderedPayload
  | QueueAutoDrainChangedPayload
  | FollowupModeChangedPayload
  | TurnSteerRejectedPayload
  | TurnSteerDiscardedPayload
  | SessionInputPromotedPayload
  | TurnCompletePayload
  | TurnErrorPayload
  | UserMessagePayload
  | AssistantMessagePayload
  | SystemMessagePayload
  | ModelRequestPayload
  | ModelSelectedPayload
  | TurnExecutionModelFallbackPayload
  | ModelStreamingPayload
  | StreamingToolLedgerPayload
  | StreamRecoveryAnchorPayload
  | StreamRecoveryStartedPayload
  | StreamRecoveryAnchorSelectedPayload
  | StreamRecoveryTailDiscardedPayload
  | StreamRecoveryRetryStartedPayload
  | StreamRecoveryBlockedPayload
  | ModelNetworkStatusPayload
  | ModelAnomalyWarningPayload
  | NetworkRequestStatusPayload
  | ModelCompletePayload
  | TargetCompletionVerificationPayload
  | ModelErrorPayload
  | ToolCallScheduledPayload
  | ToolCallStartedPayload
  | ToolCallProgressPayload
  | ToolCallResultPayload
  | ToolCallErrorPayload
  | ToolBatchCompletePayload
  | BackgroundTaskStartedPayload
  | BackgroundTaskUpdatedPayload
  | BackgroundTaskCompletedPayload
  | SubagentExecutionTerminalPayload
  | OpenCodeAgentRunUpdatedPayload
  | SwarmRunUpdatedPayload
  | OpenCodeAgentPermissionUpdatedPayload
  | PrismTaskContractDeclaredPayload
  | PrismEvidenceReceiptObservedPayload
  | DynamicWorkflowRunProgressPayload
  | PermissionRequestedPayload
  | PermissionResolvedPayload
  | PermissionDeniedPayload
  | PluginUiResourceUpdatedPayload
  | PluginUiResourceListChangedPayload
  | PluginUiAppToolCallRequestedPayload
  | UserInputAutoResolutionUpdatedPayload
  | WorkspaceHookReviewRequestedPayload
  | WorkspaceHookReviewSettledPayload
  | WorkspaceHookReviewSupersededPayload
  | WorkspaceHookAdmissionUpdatedPayload
  | HookRunLifecyclePayload
  | CompactLifecyclePayload
  | MicrocompactBoundaryEventPayload
  | CheckpointCreatedPayload
  | RewindTriggeredPayload
  | CompactBoundaryPayload;
