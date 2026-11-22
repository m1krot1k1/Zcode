// V4 conversation gateway 的共享上下文（从 v4-gateway 拆出）。
// 领域模块只依赖本模块的类型，不反向依赖 v4-gateway.ts；
// 依赖方向：v4-gateway.ts → v4-gateway-*.ts → v4-gateway-context.ts。

import type { MessageWithParts, SessionEvent } from "@zcode/contracts";
import type { ZCodeWorkspaceRef } from "@zcode/shared";
import type {
  AttachmentRef,
  BackgroundBashOutputResult,
  CommandAck,
  CommandsQueryResult,
  ConversationOpenTiming,
  ConversationRowTarget,
  ConversationSnapshot,
  ConversationTopicFrame,
  RoutedTopicFrame,
  RoutedTopicWireFrame,
  SessionSummary,
  SessionsIndexReconcileResult,
  SessionsIndexTopicFrame,
  SubscribeAck,
  V4AttachmentBeginResult,
  V4AttachmentChunkResult,
  V4AttachmentCommitResult,
  V4AttachmentPreviewSourceResult,
  V4AttachmentReadResult,
  V4ConversationAttachmentReadResult,
  V4ConversationAttachmentStatResult,
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewResult,
  V4ConversationPlansResult,
  V4ConversationRowsRangeResult,
  V4ConversationWorkflowRunArtifactDataResult,
  V4ConversationWorkflowRunArtifactReadResult,
  V4ConversationWorkflowRunArtifactsResult,
  V4ConversationWorkflowRunEventsResult,
  V4ConversationWorkflowRunNodeResultResult,
  V4ConversationWorkflowRunWorkspaceResult,
  V4ConversationWorkflowRunsResult,
  WorkspaceConfigState,
  WorkspaceConfigTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import { AttachmentUploadRegistry } from "./attachment-upload-registry.js";
import { ColdSessionResumeCoordinator } from "./cold-session-resume.js";
import { CommandInbox } from "./command-inbox.js";
import { ConversationTelemetryFactNormalizer } from "./conversation-telemetry-facts.js";
import { ConversationTopicPublisher } from "./conversation-topic-publisher.js";
import { CuaPermissionObservationNormalizer } from "./cua-permission-observation.js";
import { LocalTtftRecorder } from "./local-ttft.js";
import type { SessionUsageSeed } from "./product-projection.js";
import { SessionsIndexFanoutThrottle } from "./sessions-index-fanout-throttle.js";
import { SessionsIndexPublisherRegistry } from "./sessions-index-publisher-registry.js";
import { SessionsIndexPublisher } from "./sessions-index-publisher.js";
import type { TopicFrameReservation } from "./topic-frame-reservation.js";
import type { V4GatewayHost } from "./v4-gateway-host.js";
import { WorkspaceConfigPublisher } from "./workspace-config-publisher.js";

export interface FlushState {
  sessionId: string;
  topic: string;
  subscriptionId: string;
  connectionId: string;
  deliveryProfile: "continuous" | "replayable";
  flushWindowMs: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface HydrationBuffer {
  cancelled: boolean;
  eventIds: Set<string>;
  rawEvents: SessionEvent[];
}

export interface RawSequenceState {
  /** 已经由 cold snapshot 或 live replay 消费的 runtime raw cursor。 */
  sourceEventSeq: number;
  /** transportSeq = rawSeq + offset；遇到 sequence=0 时会向前校正。 */
  offset: number;
  lastTransportSeq: number;
  seenEventIds: Set<string>;
  /** publisher 已成功 apply 的 event；runtime sink 已看见但仍在 gap buffer 的不在此集合。 */
  appliedEventIds: Set<string>;
  /** publisher apply 失败事实；临时 sink 迟到注册 waiter 时也必须立即 reject。 */
  failedEventById: Map<string, Error>;
  /** notify sink 可乱序；只有从 sourceEventSeq+1 连续时才可向投影 drain。 */
  pendingByRawSeq: Map<number, SessionEvent>;
  /** synthesized hydration 重建投影时，补回持久读取边界之后已经到达的 raw 事实。 */
  recentRawEventsById: Map<string, SessionEvent>;
}

export interface ProjectionEventCommitWaiter {
  resolve(): void;
  reject(error: Error): void;
}

/**
 * server 内部分派结果：initial frame 只供 request-scoped post-response outbox
 * 消费，公共 JSON-RPC result schema 始终严格为 `{ ack }`。
 */
export interface V4SubscribeDispatchResult<TFrame> {
  ack: SubscribeAck & { openTiming?: ConversationOpenTiming };
  initialFrame: TFrame | null;
  initialWires: RoutedTopicWireFrame[];
  commit(): boolean;
}

/**
 * 一条已读回的**整份字节**，供分块读取复用。
 *
 * 两个家族共用这张表：已发送附件的预览（`attachmentRead`）与 dwf 用户面产物的字节
 * （`workflowRunArtifactRead`）。共用是有意的——两者的失效规则逐字相同（TTL、字节预算、
 * 最旧先逐、会话销毁时按 `sessionId` 清），而分成两张表会得到两份**各自**的字节预算，
 * 于是"最多缓存多少字节"这条约束就再也说不清了。
 *
 * 键空间靠**首段标签**区分（`att` / `dwfart`），不靠字段个数或内容——两个家族的键都是
 * NUL 分隔的四五段，段数相同、内容也可能撞（一个叫 "1" 的产物 id 与一个 attachmentIndex
 * 1 会长得一样），只有一个不可能相等的首段才是可证明的隔离。
 *
 * `bytes` 为 null 表示读还在飞：此时它不计入预算，也不会被按预算逐出（逐出一个正在被
 * await 的条目只会让下一块重新读一遍整份文件，正是这张表要消灭的事）。
 */
export interface BinaryReadCacheEntry {
  sessionId: string;
  accessedAt: number;
  bytes: number | null;
  payload: Promise<{ bytes: Uint8Array; mediaType: string }>;
}

export function subscriptionRouteKey(
  topic: string,
  subscriptionId: string,
  connectionId: string,
): string {
  return `${topic}\0${subscriptionId}\0${connectionId}`;
}

/**
 * 网关共享状态。领域模块不持有状态，一律经此结构读写；只有真实会变化的
 * 计数与生命周期位不是 readonly。
 */
export interface GatewayContext extends GatewayState, GatewayOperations {}

export interface GatewayState {
  readonly host: V4GatewayHost;
  readonly publishers: Map<string, ConversationTopicPublisher>;
  readonly indexPublishers: SessionsIndexPublisherRegistry;
  readonly configPublishers: Map<string, WorkspaceConfigPublisher>;
  readonly hydratedSessions: Set<string>;
  readonly hydrationInFlight: Map<string, Promise<ConversationTopicPublisher>>;
  readonly historyOpenings: Map<
    string,
    {
      history: Promise<ConversationTopicPublisher>;
      start: () => void;
      cancel: () => void;
    }
  >;
  readonly readyFlights: Map<string, Promise<ConversationTopicPublisher>>;
  readonly hydrationBuffers: Map<string, HydrationBuffer>;
  readonly rawSequenceStates: Map<string, RawSequenceState>;
  readonly projectionEventCommitWaiters: Map<string, Map<string, Set<ProjectionEventCommitWaiter>>>;
  readonly detachedLiveSessions: Set<string>;
  readonly detachedChildParent: Map<string, string>;
  readonly detachedChildrenByParent: Map<string, Set<string>>;
  readonly detachedTerminalAt: Map<string, number>;
  readonly coldResume: ColdSessionResumeCoordinator;
  readonly flushStates: Map<string, FlushState>;
  readonly controlReservations: WeakSet<object>;
  readonly pausedConnections: Set<string>;
  readonly projectionFaultedSessions: Set<string>;
  readonly inbox: CommandInbox;
  readonly attachmentUploads: AttachmentUploadRegistry;
  readonly binaryReadCache: Map<string, BinaryReadCacheEntry>;
  binaryReadCacheBytes: number;
  readonly localTtft: LocalTtftRecorder;
  readonly indexFanoutThrottle: SessionsIndexFanoutThrottle;
  readonly attachmentPruneTimer: ReturnType<typeof setInterval>;
  readonly now: () => number;
  readonly createLogEpoch: (sessionId: string) => string;
  readonly telemetryNormalizer: ConversationTelemetryFactNormalizer;
  readonly cuaPermissionNormalizer: CuaPermissionObservationNormalizer;
  readonly telemetryEventIds: Set<string>;
  disposed: boolean;
}

/** 领域模块可调用的网关方法（实现仍在 ConversationV4Gateway）。 */
export interface GatewayOperations {
  updateSharedContextImport(
    sessionId: string,
    source: ConversationSnapshot["sharedContextImport"],
  ): void;
  setConnectionFlowState(rawParams: unknown): void;
  clearConnectionFlushTimers(connectionId: string): void;
  flushConnection(connectionId: string): void;
  ingest(sessionId: string, event: SessionEvent): void;
  emitLiveTelemetryFact(sessionId: string, event: SessionEvent): void;
  waitForProjectionEventCommit(
    sessionId: string,
    eventId: string,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  waitForPermissionGrantCommit(sessionId: string, eventId: string): Promise<void>;
  ingestNormalizedEvent(sessionId: string, event: SessionEvent): void;
  ingestDetachedLiveSession(sessionId: string, event: SessionEvent, parentSessionId?: string): void;
  pruneDetachedChildPublishers(nowMs?: number, graceMs?: number): number;
  releaseDetachedChild(childId: string): void;
  fanOutToIndex(sessionId: string, event: SessionEvent): void;
  publishCurrentSummaryToIndex(sessionId: string): void;
  resolveIndexMeta(sessionId: string): {
    createdAt: number;
    lastActivityAt: number;
    lastOutcome?: SessionSummary["lastOutcome"];
    parentSessionId?: string;
  };
  flushIndex(workspaceId: string, onlyConnectionId?: string): void;
  subscribeSessionsIndex(
    rawParams: unknown,
  ): Promise<V4SubscribeDispatchResult<SessionsIndexTopicFrame>>;
  reconcileSessions(rawParams: unknown): Promise<SessionsIndexReconcileResult>;
  subscribeSessionsIndexReserved(
    rawParams: unknown,
  ): Promise<V4SubscribeDispatchResult<SessionsIndexTopicFrame>>;
  ensureIndexPublisher(
    workspaceId: string,
    legacyTaskIds?: readonly string[],
  ): Promise<SessionsIndexPublisher>;
  ensureIndexPublisherExclusive(
    workspaceId: string,
    legacyTaskIds?: readonly string[],
  ): Promise<SessionsIndexPublisher>;
  subscribeWorkspaceConfig(
    rawParams: unknown,
  ): Promise<V4SubscribeDispatchResult<WorkspaceConfigTopicFrame>>;
  subscribeWorkspaceConfigReserved(
    rawParams: unknown,
  ): Promise<V4SubscribeDispatchResult<WorkspaceConfigTopicFrame>>;
  publishWorkspaceConfig(workspaceId: string, state: WorkspaceConfigState): void;
  pullWorkspaceConfig(workspaceId: string): Promise<WorkspaceConfigState | null>;
  ensureConfigPublisher(workspaceId: string): Promise<WorkspaceConfigPublisher>;
  flushConfig(workspaceId: string, onlyConnectionId?: string): void;
  subscribe(rawParams: unknown): Promise<V4SubscribeDispatchResult<ConversationTopicFrame>>;
  subscribeReserved(rawParams: unknown): Promise<V4SubscribeDispatchResult<ConversationTopicFrame>>;
  resyncReserved(rawParams: unknown): V4SubscribeDispatchResult<RoutedTopicFrame>;
  rowsRange(rawParams: unknown): Promise<V4ConversationRowsRangeResult>;
  plans(rawParams: unknown): Promise<V4ConversationPlansResult>;
  workflowRunEvents(rawParams: unknown): Promise<V4ConversationWorkflowRunEventsResult>;
  workflowRuns(rawParams: unknown): Promise<V4ConversationWorkflowRunsResult>;
  workflowRunArtifacts(rawParams: unknown): Promise<V4ConversationWorkflowRunArtifactsResult>;
  workflowRunArtifactData(rawParams: unknown): Promise<V4ConversationWorkflowRunArtifactDataResult>;
  workflowRunArtifactRead(rawParams: unknown): Promise<V4ConversationWorkflowRunArtifactReadResult>;
  workflowRunWorkspace(rawParams: unknown): Promise<V4ConversationWorkflowRunWorkspaceResult>;
  workflowRunNodeResult(rawParams: unknown): Promise<V4ConversationWorkflowRunNodeResultResult>;
  readWorkflowArtifactPayload(params: {
    sessionId: string;
    runId: string;
    artifactId: string;
    version: number;
  }): Promise<{ bytes: Uint8Array; mediaType: string }>;
  ensureHostRecordForJournalRead(sessionId: string): Promise<void>;
  fileChanges(rawParams: unknown): Promise<V4ConversationFileChangesResult>;
  backgroundBashOutput(rawParams: unknown): Promise<BackgroundBashOutputResult>;
  fileRewindPreview(rawParams: unknown): Promise<V4ConversationFileRewindPreviewResult>;
  resolveQueryRowTarget(
    publisher: ConversationTopicPublisher,
    params: {
      target: ConversationRowTarget;
      baseRevision: number;
      baseLogEpoch: string;
    },
    action: "fileChanges" | "fileRewindPreview",
  ): Extract<ReturnType<ConversationTopicPublisher["resolveRowActionTarget"]>, { ok: true }>;
  attachmentBegin(rawParams: unknown): Promise<V4AttachmentBeginResult>;
  attachmentChunk(rawParams: unknown): Promise<V4AttachmentChunkResult>;
  attachmentCommit(rawParams: unknown): Promise<V4AttachmentCommitResult>;
  attachmentAbort(rawParams: unknown): Promise<void>;
  attachmentRead(rawParams: unknown): Promise<V4AttachmentReadResult>;
  conversationAttachmentRead(rawParams: unknown): Promise<V4ConversationAttachmentReadResult>;
  conversationAttachmentStat(rawParams: unknown): Promise<V4ConversationAttachmentStatResult>;
  attachmentPreviewSource(rawParams: unknown): Promise<V4AttachmentPreviewSourceResult>;
  resolveReadableMediaAttachment(
    publisher: ConversationTopicPublisher,
    sessionId: string,
    ref: string,
    target?: { rowId: number; entityId: string },
    attachmentIndex?: number,
  ): { attachment: AttachmentRef; messageId?: string; attachmentIndex?: number } | null;
  readAttachmentPayload(
    sessionId: string,
    ref: string,
    mime: string,
    messageId?: string,
    attachmentIndex?: number,
    allowGeneric?: boolean,
  ): Promise<{ bytes: Uint8Array; mediaType: string }>;
  pruneBinaryReadCache(now?: number): void;
  deleteBinaryReadCacheEntry(key: string): void;
  unsubscribe(rawParams: unknown): void;
  handleCommand(rawParams: unknown): Promise<CommandAck>;
  queryCommands(rawParams: unknown): Promise<CommandsQueryResult>;
  disposeSession(sessionId: string, options?: { deleted?: boolean }): void;
  deactivateSession(sessionId: string): void;
  assertSessionRuntimeDeactivatable(sessionId: string): void;
  hasConversationSubscribers(sessionId: string): boolean;
  collectMemoryDiagnostics(): Record<string, number>;
  cleanupSessionRuntime(
    sessionId: string,
    options: { clearCommandInbox: boolean; notifyIndexRemoved: boolean },
  ): void;
  dispose(): void;
  flushNow(subscriptionId: string): ConversationTopicFrame | null;
  ensurePublisher(sessionId: string): ConversationTopicPublisher;
  seedPublisherConfig(sessionId: string, publisher: ConversationTopicPublisher): void;
  ensureHistoryReadyPublisher(
    sessionId: string,
    thought?: string,
    workspace?: ZCodeWorkspaceRef,
    additionalDirectories?: string[],
    retryAttempt?: string,
  ): Promise<ConversationTopicPublisher>;
  setInitialization(
    sessionId: string,
    publisher: ConversationTopicPublisher,
    state: NonNullable<ConversationSnapshot["runtimeInitialization"]>,
  ): void;
  ensureColdReadyPublisher(
    sessionId: string,
    resumeThoughtLevel?: string,
    workspace?: ZCodeWorkspaceRef,
    additionalDirectories?: string[],
  ): Promise<ConversationTopicPublisher>;
  hydratePublisher(
    sessionId: string,
    persistedMessages?: MessageWithParts[],
    forceRebuild?: boolean,
  ): Promise<ConversationTopicPublisher>;
  performHydration(
    sessionId: string,
    buffer: HydrationBuffer,
    persistedMessages?: MessageWithParts[],
    forceRebuild?: boolean,
  ): Promise<ConversationTopicPublisher>;
  normalizeRuntimeEventSequence(sessionId: string, event: SessionEvent): SessionEvent[];
  getOrCreateRawSequenceState(sessionId: string): RawSequenceState;
  resolveProjectionEventCommit(sessionId: string, eventId: string): void;
  rejectProjectionEventCommit(sessionId: string, eventId: string, error: Error): void;
  rejectProjectionEventWaiters(sessionId: string, error: Error): void;
  hasLiveConversation(sessionId: string): boolean;
  seedPublisherUsage(
    sessionId: string,
    publisher: ConversationTopicPublisher,
    persistedMessages?: MessageWithParts[],
    loadedSeed?: SessionUsageSeed | null,
  ): Promise<void>;
  scheduleFlush(routeKey: string, state: FlushState, publisher: ConversationTopicPublisher): void;
  emitReservation<F extends RoutedTopicFrame>(reservation: TopicFrameReservation<F>): boolean;
  subscribeDispatch<F extends RoutedTopicFrame>(
    ack: SubscribeAck,
    reservation: TopicFrameReservation<F> | null,
    afterCommit?: () => void,
  ): V4SubscribeDispatchResult<F>;
}
