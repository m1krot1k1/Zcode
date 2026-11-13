// ProductProjection 的显式上下文字面：域模块只依赖本接口，不依赖实现类，
// 因此 类型基座 ← 上下文 ← 域模块 ← ProductProjection 的依赖方向始终单向。
// 字段与签名由实现类 `implements` 校验，避免与实现漂移。

import type {
  HookRunLifecyclePayload,
  PermissionRequestedPayload,
  SessionEvent,
  TargetCompletionVerificationPayload,
} from "@zcode/contracts";
import { extractPlanStepsFromToolInput } from "@zcode/shared";
import type {
  ApiRetryState,
  ConversationDelta,
  ConversationRow,
  ConversationRowTarget,
  ConversationSnapshot,
  CuaAppIdentity,
  GoalState,
  HookExecutionProjection,
  HookInvocationRow,
  MutableConversationSnapshotAccumulator,
  PendingInteraction,
  SessionControl,
  StatePatch,
  SubagentRow,
  ToolCallRow,
  TurnHeaderRow,
  TurnWorkSegment,
} from "@zcode/shared/zcode-protocol-v4";
import {
  type CanonicalAssistantSegmentFact,
  type CanonicalConversationFact,
  type CanonicalModelStream,
  type CanonicalOpenSegmentIdentity,
  type CanonicalUserIntentFact,
  type ConversationNormalizationDiagnostic,
} from "./event-normalizer.js";
import { type AvailabilityContext } from "./projection-state.js";
import {
  type FileToolInputPreviewState,
  type PendingSessionHookInvocation,
  type ConversationEditTarget,
  type HighspeedToolInterval,
  type ContextWindowProjectionState,
  type TurnModelBaseline,
  type SessionConfigSeed,
  type SessionUsageSeed,
  type SessionSubagentsSeed,
  type ConversationRowTargetAction,
  type ConversationRowTargetResolution,
  type StableForkCandidateResolution,
} from "./product-projection-types.js";

export interface ProductProjectionContext {
  snapshot: ConversationSnapshot;
  rowIndexById: Map<number, number>;
  hydrationAccumulator: MutableConversationSnapshotAccumulator | null;
  nextRowId: number;
  streamingTextRowId: number | null;
  streamingReasoningRowId: number | null;
  outputContinuationTextRowId: number | null;
  toolRowIdByCallId: Map<string, number>;
  latestListAppsSnapshot: Map<number, CuaAppIdentity>;
  openForegroundToolCallIds: Set<string>;
  fileToolInputPreviewByCallId: Map<string, FileToolInputPreviewState>;
  subagentRowIdByAgentId: Map<string, number>;
  hookRowIdByInvocationId: Map<string, number>;
  pendingSessionHookInvocations: Map<string, PendingSessionHookInvocation>;
  rewoundHookInvocationIds: Set<string>;
  invalidSubagentChildSessionIds: Set<string>;
  messageIdByRowId: Map<number, string>;
  outputContinuationRowIdByMessageId: Map<string, number>;
  entityIdByRowId: Map<number, string>;
  editTargetByEntityId: Map<string, ConversationEditTarget>;
  currentEditableEntityId: string | null;
  stableCompactCoverageBoundaryRowId: number | null;
  turnHeaderRowIdByTurnId: Map<string, number>;
  compactMarkerRowIdByOperationId: Map<string, number>;
  goalVerifyMarkerRowIdByLifecycleKey: Map<string, number>;
  productTurnIdByRuntimeTurnId: Map<string, string>;
  runtimeTurnIdByProductTurnId: Map<string, string>;
  productTurnSplitOrdinalByRuntimeTurnId: Map<string, number>;
  currentProductTurnStartedAtMs: number | null;
  highspeedModelDurationByTurnId: Map<string, number>;
  highspeedToolIntervalsByTurnId: Map<string, Map<string, HighspeedToolInterval>>;
  deliveryByPendingInputId: Map<string, "guide" | "queue">;
  currentTurnId: string | null;
  currentTurnStartedModelOnly: boolean;
  contextWindowState: ContextWindowProjectionState;
  lastTurnModel: TurnModelBaseline;
  configModelTouchedByEvent: boolean;
  configThoughtLevelsTouchedByEvent: boolean;
  configModeTouchedByEvent: boolean;
  droppedContentStreamEventCount: number;
  normalizationDiagnostics: ConversationNormalizationDiagnostic[];

  getSnapshot(): ConversationSnapshot;
  setRuntimeInitialization(
    state: NonNullable<ConversationSnapshot["runtimeInitialization"]>,
    minimumSeq?: number,
    minimumRevision?: number,
  ): void;
  getDroppedContentStreamEventCount(): number;
  getNormalizationDiagnostics(): readonly ConversationNormalizationDiagnostic[];
  establishedStreamingAppend(event: SessionEvent): string | null;
  seedConfig(seed: SessionConfigSeed): void;
  seedSharedContextImport(
    source: ConversationSnapshot["sharedContextImport"] | null | undefined,
  ): void;
  seedUsage(seed: SessionUsageSeed): void;
  seedSubagents(seed: SessionSubagentsSeed): void;
  getMessageIdForRow(rowId: number): string | null;
  getEntityIdForRow(rowId: number): string | null;
  resolveEditTarget(rowId: number): ConversationEditTarget | null;
  resolveEditTargetByEntityId(entityId: string): ConversationEditTarget | null;
  resolveRowActionTarget(
    target: ConversationRowTarget,
    action: ConversationRowTargetAction,
  ): ConversationRowTargetResolution;
  getMessageIdsForTurnRow(rowId: number): string[];
  isLatestAssistantSegmentRow(rowId: number): boolean;
  resolveStableForkCandidate(rowId: number): StableForkCandidateResolution;
  isLatestRetryAssistantRow(rowId: number): boolean;
  isLatestEditableUserRow(rowId: number): boolean;
  getTurnIdForRow(rowId: number): string | null;
  applyEvent(event: SessionEvent): ConversationDelta[];
  beginHydrationReplay(): void;
  applyHydrationEvent(event: SessionEvent): ConversationDelta[];
  completeHydrationReplay(): ConversationDelta[];
  applyEventInternal(event: SessionEvent, materializeActions: boolean): ConversationDelta[];
  cloneProjection(): ProductProjectionContext;
  adoptProjection(candidate: ProductProjectionContext): void;
  materializeCommandRowActions(reduced: ConversationDelta[]): ConversationDelta[];
  attachRevision(deltas: ConversationDelta[]): ConversationDelta[];
  reduce(fact: CanonicalConversationFact): ConversationDelta[];
  onSessionResumed(event: SessionEvent): ConversationDelta[];
  onHookRunLifecycle(event: SessionEvent): ConversationDelta[];
  hookBlockErrorDelta(
    event: SessionEvent,
    payload: HookRunLifecyclePayload,
    didExecute: boolean,
    blockReason: string | undefined,
  ): ConversationDelta | null;
  flushPendingSessionHookInvocations(turnId: string): ConversationDelta[];
  hookExecutionState(eventType: SessionEvent["type"]): HookExecutionProjection["state"];
  hookExecutionOutcome(
    eventType: SessionEvent["type"],
    outcome: HookRunLifecyclePayload["outcome"],
  ): HookExecutionProjection["outcome"];
  hookInvocationState(
    executions: readonly HookExecutionProjection[],
    hookCount: number,
  ): HookInvocationRow["state"];
  hookInvocationLane(
    eventName: HookRunLifecyclePayload["hookEventName"],
  ): HookInvocationRow["lane"];
  onRewindTriggered(event: SessionEvent): ConversationDelta[];
  rowIdForMessageId(messageId: string): number | null;
  getTurnRewindAnchor(rowId: number): string | null;
  rewindAnchorForRows(rows: readonly ConversationRow[], rowId: number): string | null;
  registerCanonicalUserRowTarget(
    rowId: number,
    entityId: string,
    editTarget?: ConversationEditTarget,
  ): void;
  onSessionCreated(event: SessionEvent): ConversationDelta[];
  onSessionTitleUpdated(event: SessionEvent): ConversationDelta[];
  onTurnStarted(fact: CanonicalUserIntentFact): ConversationDelta[];
  applyBackgroundTaskNotification(fact: CanonicalUserIntentFact): ConversationDelta[];
  onTurnComplete(event: SessionEvent): ConversationDelta[];
  leaveDraftAfterControlOnlyTurn(
    phase: Exclude<SessionControl["phase"], "draft" | "prewarming" | "running">,
  ): ConversationDelta[];
  onTurnError(event: SessionEvent): ConversationDelta[];
  onModelNetworkStatus(event: SessionEvent): ConversationDelta[];
  onStreamRecoveryStarted(event: SessionEvent): ConversationDelta[];
  onStreamRecoveryTailDiscarded(event: SessionEvent): ConversationDelta[];
  onStreamRecoveryRetryStarted(event: SessionEvent): ConversationDelta[];
  streamRecoveryApiRetry(
    retryNumber: number,
    maxRetriesValue: number,
    nextRetryAt: number,
    reasonCode: string,
  ): ApiRetryState;
  setApiRetry(apiRetry: ApiRetryState | null): ConversationDelta[];
  acceptsActiveModelEvent(event: SessionEvent): boolean;
  onModelStreaming(fact: CanonicalAssistantSegmentFact): ConversationDelta[];
  openTextRow(event: SessionEvent, fact: CanonicalAssistantSegmentFact): ConversationDelta[];
  closeTextRow(state: "complete" | "interrupted"): ConversationDelta[];
  onAssistantFeedbackUpdated(event: SessionEvent): ConversationDelta[];
  onHighspeedMetricsUpdated(event: SessionEvent): ConversationDelta[];
  onTurnExecutionModelFallback(event: SessionEvent): ConversationDelta[];
  openReasoningRow(event: SessionEvent, fact: CanonicalAssistantSegmentFact): ConversationDelta[];
  closeReasoningRow(state?: "complete" | "interrupted"): ConversationDelta[];
  closeStreamingRows(state: "complete" | "interrupted"): ConversationDelta[];
  closeOpenToolRows(
    event: SessionEvent,
    status: "cancelled" | "error",
    only?: (row: ToolCallRow) => boolean,
  ): ConversationDelta[];
  isOpenForegroundToolRow(row: ToolCallRow): boolean;
  updateToolIndexesAfterDeltas(deltas: readonly ConversationDelta[]): void;
  pruneRemovedSubagentIndexes(): void;
  openToolRow(
    event: SessionEvent,
    payload: CanonicalModelStream,
    entityId?: string,
  ): ConversationDelta[];
  appendStreamingToolInput(event: SessionEvent, payload: CanonicalModelStream): ConversationDelta[];
  flushStreamingToolInput(toolCallId: string): ConversationDelta[];
  takePendingStreamingToolInput(toolCallId: string): string;
  finalizeStreamingToolInput(
    event: SessionEvent,
    payload: CanonicalModelStream,
  ): ConversationDelta[];
  onStreamingToolIdentity(event: SessionEvent): ConversationDelta[];
  onToolCallScheduled(event: SessionEvent): ConversationDelta[];
  onToolCallActivity(event: SessionEvent): ConversationDelta[];
  onToolCallProgress(event: SessionEvent): ConversationDelta[];
  onToolCallResult(event: SessionEvent): ConversationDelta[];
  todoPlanDeltas(
    event: SessionEvent,
    steps: ReturnType<typeof extractPlanStepsFromToolInput>,
  ): ConversationDelta[];
  onToolCallError(event: SessionEvent): ConversationDelta[];
  onPermissionRequested(event: SessionEvent): ConversationDelta[];
  createPendingInteractionFromPermissionEvent(
    event: SessionEvent,
    payload: PermissionRequestedPayload,
    toolCallId: string,
    interactionId: string,
  ): PendingInteraction;
  onPermissionResolved(event: SessionEvent): ConversationDelta[];
  onPermissionDenied(event: SessionEvent): ConversationDelta[];
  onWorkspaceHookReviewRequested(event: SessionEvent): ConversationDelta[];
  onWorkspaceHookReviewSettled(event: SessionEvent): ConversationDelta[];
  onWorkspaceHookReviewSuperseded(event: SessionEvent): ConversationDelta[];
  removeWorkspaceHookReview(interactionId: string): ConversationDelta[];
  onWorkspaceHookAdmissionUpdated(event: SessionEvent): ConversationDelta[];
  onUserInputAutoResolutionUpdated(event: SessionEvent): ConversationDelta[];
  settlePermission(toolCallId: string, status: ToolCallRow["status"]): ConversationDelta[];
  onTurnSteerQueued(event: SessionEvent): ConversationDelta[];
  onTurnSteerDispatchChanged(event: SessionEvent): ConversationDelta[];
  onTurnSteerDeliveryChanged(event: SessionEvent): ConversationDelta[];
  onTurnSteerDrained(event: SessionEvent): ConversationDelta[];
  splitProductTurn(
    event: SessionEvent,
    runtimeTurnId: string,
    promotedUserMessageId?: string,
  ): ConversationDelta[];
  activeMsForCompletion(event: SessionEvent, runtimeDuration?: number): number | undefined;
  onTurnSteerDiscarded(event: SessionEvent): ConversationDelta[];
  onSessionInputPromoted(event: SessionEvent): ConversationDelta[];
  onTurnSteerReordered(event: SessionEvent): ConversationDelta[];
  onQueueAutoDrainChanged(event: SessionEvent): ConversationDelta[];
  onFollowupModeChanged(event: SessionEvent): ConversationDelta[];
  onSessionModeChanged(event: SessionEvent): ConversationDelta[];
  shouldMaterializeSubagentProjection(reduced: readonly ConversationDelta[]): boolean;
  materializeSubagentProjection(reduced: readonly ConversationDelta[]): ConversationDelta[];
  prospectiveSubagentRow(
    row: ConversationRow,
    reduced: readonly ConversationDelta[],
    startIndex: number,
  ): SubagentRow | null;
  onSubagentSpawned(event: SessionEvent): ConversationDelta[];
  resumedSubagentBackgroundWorkDelta(
    event: SessionEvent,
    payload: Record<string, unknown>,
    agentId: string,
    childSessionId: string | undefined,
  ): ConversationDelta | undefined;
  onSubagentMessage(event: SessionEvent): ConversationDelta[];
  onSubagentStopped(event: SessionEvent): ConversationDelta[];
  onOpenCodeAgentRunUpdated(event: SessionEvent): ConversationDelta[];
  onSwarmRunUpdated(event: SessionEvent): ConversationDelta[];
  onOpenCodeAgentPermissionUpdated(event: SessionEvent): ConversationDelta[];
  onBackgroundTaskLifecycle(event: SessionEvent): ConversationDelta[];
  onDynamicWorkflowRunProgress(event: SessionEvent): ConversationDelta[];
  removeQueueItems(ids: readonly string[]): ConversationDelta[];
  onModelSelected(event: SessionEvent): ConversationDelta[];
  onModelComplete(event: SessionEvent): ConversationDelta[];
  onCompactLifecycle(event: SessionEvent): ConversationDelta[];
  onTargetChanged(event: SessionEvent): ConversationDelta[];
  onTargetVerification(event: SessionEvent): ConversationDelta[];
  goalVerifyLifecycleKey(payload: TargetCompletionVerificationPayload, iteration: number): string;
  goalVerifyTurnId(payload: TargetCompletionVerificationPayload, event: SessionEvent): string;
  onSessionForked(event: SessionEvent): ConversationDelta[];
  controlPatch(
    control: Partial<SessionControl>,
    goal?: GoalState | null,
    queue?: ConversationSnapshot["queue"],
  ): StatePatch;
  goalPatch(goal: GoalState | null): StatePatch;
  queuePatch(queue: ConversationSnapshot["queue"]): StatePatch;
  deriveContext(overrides: {
    goal?: GoalState | null;
    queue?: ConversationSnapshot["queue"];
  }): AvailabilityContext;
  upsertTurnHeader(
    event: SessionEvent,
    state: "completedSuccess" | "completedInterrupted" | "failed",
    activeMs?: number,
    historyRoundCount?: number,
    highspeedTiming?: {
      modelDurationMs: number;
      toolDurationMs: number;
      otherDurationMs: number;
    },
  ): ConversationDelta[];
  recordHighspeedToolStarted(turnId: string, toolCallId: string, startedAt: number): void;
  recordHighspeedToolEnded(
    turnId: string,
    toolCallId: string,
    endedAt: number,
    durationMs?: number,
  ): void;
  highspeedTimingForTurn(
    turnId: string,
    activeMs?: number,
  ): { modelDurationMs: number; toolDurationMs: number; otherDurationMs: number } | undefined;
  openGuidedWorkSegment(event: SessionEvent, triggerEntityId: string): ConversationDelta[];
  completeWorkSegments(segments: readonly TurnWorkSegment[], endedAt: number): TurnWorkSegment[];
  turnHeaderForEvent(event: SessionEvent): TurnHeaderRow | undefined;
  markStableForkAssistant(event: SessionEvent): ConversationDelta[];
  isRunning(): boolean;
  isMirroredSubagentToolEvent(event: SessionEvent): boolean;
  openAssistantSegments(): Partial<Record<"text" | "reasoning", CanonicalOpenSegmentIdentity>>;
  openSegmentIdentity(rowId: number | null): CanonicalOpenSegmentIdentity | null;
  rowBase(
    event: SessionEvent,
    turnId: string,
    entityId?: string,
  ): {
    rowId: number;
    turnId: string;
    entityId: string;
    productTurnId: string;
    visibility: "visible";
    createdAt: number;
    createdAtSeq: number;
  };
  turnIdOf(event: SessionEvent): string;
  ms(event: SessionEvent): number;
  findRow(rowId: number): ConversationRow | undefined;
  updateRowIndexAfterImmutableApply(
    previousRowsLength: number,
    deltas: readonly ConversationDelta[],
  ): void;
  findToolRow(toolCallId: string): ToolCallRow | undefined;
  findSubagentRow(agentId: string): SubagentRow | undefined;
  findSubagentLifecycleRow(
    agentId: string,
    payload: Record<string, unknown>,
    event: SessionEvent,
  ): SubagentRow | undefined;
  subagentAgentId(payload: Record<string, unknown>, event: SessionEvent): string;
  stringPayload(payload: Record<string, unknown>, key: string): string | undefined;
  mapSubagentStatus(status: string | undefined): SubagentRow["status"];
}
