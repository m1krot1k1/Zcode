// V4 conversation 网关（host 通道层 CLI 侧）。
// 职责：per-session ConversationTopicPublisher 注册表 + flushWindowMs 定时调度
// + v4/command → CommandInbox → 宿主 executor 的收口。
//
// 分层纪律：
// - 本类不做网络 IO：物理帧经 host.emitWireFrame 交给宿主（stdio notification / 测试收集器）。
// - 命令副作用不在本类实现：inbox 裁决通过后经 host.executeCommand 调宿主操作
//   未实现的命令通过结构化错误返回。
// - flush 定时器是唯一的时间源，publisher 本身保持纯推进（边界不变）。
// - 大块职责按领域拆到 v4-gateway-*.ts，本文件保留状态、构造与委托方法；
//   依赖方向单向：v4-gateway.ts → 领域模块 → v4-gateway-context.ts。
import type { MessageWithParts, SessionEvent } from "@zcode/contracts";
import type { ZCodeWorkspaceRef } from "@zcode/shared";
import {
  PROTOCOL_V4_LIMITS,
  localTtftFactsSchema,
  localTtftNow,
  type AttachmentRef,
  type BackgroundBashOutputResult,
  type CommandAck,
  type CommandEnvelope,
  type CommandsQueryResult,
  type ConversationRowTarget,
  type ConversationSnapshot,
  type ConversationTopicFrame,
  type QueueItem,
  type RoutedTopicFrame,
  type SessionSummary,
  type SessionsIndexReconcileResult,
  type SessionsIndexTopicFrame,
  type SubscribeAck,
  type V4AttachmentBeginResult,
  type V4AttachmentChunkResult,
  type V4AttachmentCommitResult,
  type V4AttachmentPreviewSourceResult,
  type V4AttachmentReadResult,
  type V4ConversationAttachmentReadResult,
  type V4ConversationAttachmentStatResult,
  type V4ConversationFileChangesResult,
  type V4ConversationFileRewindPreviewResult,
  type V4ConversationPlansResult,
  type V4ConversationRowsRangeResult,
  type V4ConversationWorkflowRunArtifactDataResult,
  type V4ConversationWorkflowRunArtifactReadResult,
  type V4ConversationWorkflowRunArtifactsResult,
  type V4ConversationWorkflowRunEventsResult,
  type V4ConversationWorkflowRunNodeResultResult,
  type V4ConversationWorkflowRunWorkspaceResult,
  type V4ConversationWorkflowRunsResult,
  type WorkspaceConfigState,
  type WorkspaceConfigTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import { AttachmentUploadRegistry } from "./attachment-upload-registry.js";
import { ColdSessionResumeCoordinator } from "./cold-session-resume.js";
import { CommandInbox } from "./command-inbox.js";
import { ConversationTelemetryFactNormalizer } from "./conversation-telemetry-facts.js";
import { ConversationTopicPublisher } from "./conversation-topic-publisher.js";
import { CuaPermissionObservationNormalizer } from "./cua-permission-observation.js";
import { LocalTtftRecorder } from "./local-ttft.js";
import type { ConversationRowTargetAction, SessionUsageSeed } from "./product-projection.js";
import { SessionsIndexFanoutThrottle } from "./sessions-index-fanout-throttle.js";
import { SessionsIndexPublisherRegistry } from "./sessions-index-publisher-registry.js";
import { SessionsIndexPublisher } from "./sessions-index-publisher.js";
import type { TopicFrameReservation } from "./topic-frame-reservation.js";
import {
  attachmentAbort,
  attachmentBegin,
  attachmentChunk,
  attachmentCommit,
  attachmentPreviewSource,
  attachmentRead,
  conversationAttachmentRead,
  conversationAttachmentStat,
  deleteBinaryReadCacheEntry,
  pruneBinaryReadCache,
  readAttachmentPayload,
  resolveReadableMediaAttachment,
} from "./v4-gateway-attachments.js";
import { handleCommand, queryCommands } from "./v4-gateway-commands.js";
import type {
  BinaryReadCacheEntry,
  FlushState,
  GatewayContext,
  HydrationBuffer,
  ProjectionEventCommitWaiter,
  RawSequenceState,
  V4SubscribeDispatchResult,
} from "./v4-gateway-context.js";
import { DETACHED_CHILD_PUBLISHER_GRACE_MS } from "./v4-gateway-errors.js";
import type { ConversationV4GatewayOptions, V4GatewayHost } from "./v4-gateway-host.js";
import {
  ensureColdReadyPublisher,
  ensureHistoryReadyPublisher,
  ensurePublisher,
  hydratePublisher,
  performHydration,
  seedPublisherConfig,
  seedPublisherUsage,
  setInitialization,
} from "./v4-gateway-hydration.js";
import {
  emitLiveTelemetryFact,
  getOrCreateRawSequenceState,
  hasLiveConversation,
  ingest,
  ingestNormalizedEvent,
  normalizeRuntimeEventSequence,
  rejectProjectionEventCommit,
  rejectProjectionEventWaiters,
  resolveProjectionEventCommit,
  waitForPermissionGrantCommit,
  waitForProjectionEventCommit,
} from "./v4-gateway-ingest.js";
import {
  assertSessionRuntimeDeactivatable,
  cleanupSessionRuntime,
  collectMemoryDiagnostics,
  deactivateSession,
  dispose,
  disposeSession,
  hasConversationSubscribers,
} from "./v4-gateway-lifecycle.js";
import {
  backgroundBashOutput,
  ensureHostRecordForJournalRead,
  fileChanges,
  fileRewindPreview,
  plans,
  readWorkflowArtifactPayload,
  resolveQueryRowTarget,
  rowsRange,
  workflowRunArtifactData,
  workflowRunArtifactRead,
  workflowRunArtifacts,
  workflowRunEvents,
  workflowRunNodeResult,
  workflowRunWorkspace,
  workflowRuns,
} from "./v4-gateway-queries.js";
import {
  ensureIndexPublisher,
  ensureIndexPublisherExclusive,
  fanOutToIndex,
  flushIndex,
  ingestDetachedLiveSession,
  pruneDetachedChildPublishers,
  publishCurrentSummaryToIndex,
  reconcileSessions,
  releaseDetachedChild,
  resolveIndexMeta,
  subscribeSessionsIndex,
  subscribeSessionsIndexReserved,
} from "./v4-gateway-sessions-index.js";
import {
  clearConnectionFlushTimers,
  emitReservation,
  flushConnection,
  flushNow,
  resyncReserved,
  scheduleFlush,
  setConnectionFlowState,
  subscribe,
  subscribeDispatch,
  subscribeReserved,
  unsubscribe,
  updateSharedContextImport,
} from "./v4-gateway-subscriptions.js";
import {
  ensureConfigPublisher,
  flushConfig,
  publishWorkspaceConfig,
  pullWorkspaceConfig,
  subscribeWorkspaceConfig,
  subscribeWorkspaceConfigReserved,
} from "./v4-gateway-workspace-config.js";
import { WorkspaceConfigPublisher } from "./workspace-config-publisher.js";

export { V4CommandNoopError, V4CommandNotImplementedError } from "./v4-gateway-errors.js";
export { emitReservedTopicFrame } from "./v4-gateway-frames.js";
export type {
  ConversationV4GatewayOptions,
  V4GatewayErrorContext,
  V4GatewayHost,
} from "./v4-gateway-host.js";

function rowTargetActionForCommand(
  type: CommandEnvelope["type"],
): ConversationRowTargetAction | null {
  switch (type) {
    case "forkAssistant":
    case "editUserQuery":
    case "retryTurn":
    case "applyFileRewind":
    case "setAssistantFeedback":
    case "setHighspeedMetrics":
      return type;
    default:
      return null;
  }
}

function defaultLogEpoch(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export class ConversationV4Gateway implements GatewayContext {
  readonly publishers = new Map<string, ConversationTopicPublisher>();

  /** sessions-index：workspaceId → 列表 publisher（与 conversation 并列，独立 seq/logEpoch）。 */
  readonly indexPublishers = new SessionsIndexPublisherRegistry();

  /** workspace-config：workspaceId → 配置目录 publisher（conflated 整体替换态）。 */
  readonly configPublishers = new Map<string, WorkspaceConfigPublisher>();

  /** 已完成首次 hydration 的 session（避免重复重建 / 双计，见 hydratePublisher）。 */
  readonly hydratedSessions = new Set<string>();

  /** 首次 hydration 按 session 单飞；并发 pane 共享同一份重建结果。 */
  readonly hydrationInFlight = new Map<string, Promise<ConversationTopicPublisher>>();

  /** cold activation 到 hydration 的 READY 水位；只阻塞本次恢复期间的 command/query。 */
  readonly historyOpenings = new Map<
    string,
    {
      history: Promise<ConversationTopicPublisher>;
      start: () => void;
      cancel: () => void;
    }
  >();

  readonly readyFlights = new Map<string, Promise<ConversationTopicPublisher>>();

  /** load await 窗口内的 raw accepted events；重建后按 cursor/eventId 补回。 */
  readonly hydrationBuffers = new Map<string, HydrationBuffer>();

  /** transcript 合成序列与 runtime raw 序列之间的 per-session 单调映射。 */
  readonly rawSequenceStates = new Map<string, RawSequenceState>();

  /** connection-independent；command admission 与 transport subscription 生命周期解耦。 */
  readonly projectionEventCommitWaiters = new Map<
    string,
    Map<string, Set<ProjectionEventCommitWaiter>>
  >();

  /** 没有独立 bootstrap record、但由父 runtime 持续转发 raw events 的 live child。 */
  readonly detachedLiveSessions = new Set<string>();

  /**
   * detached subagent child 的父 record 归属与终态时间。child 没有自己的 record，publisher 只能随父 record 释放，
   * 或在 turn 结束且无订阅者、超过 grace 后由低频 tick 释放；否则会驻留到进程退出。
   */
  readonly detachedChildParent = new Map<string, string>();

  readonly detachedChildrenByParent = new Map<string, Set<string>>();

  readonly detachedTerminalAt = new Map<string, number>();

  /** 冷恢复协调器（既有 activation 单飞 + 错误分型）。 */
  readonly coldResume: ColdSessionResumeCoordinator;

  /** 订阅 → flush 调度状态（publisher 内部不持有定时器，调度归网关）。 */
  readonly flushStates = new Map<string, FlushState>();

  /** ACK/outbox 尚未 admission 的 control reservation 禁止被 online flush 抢先发送。 */
  readonly controlReservations = new WeakSet<object>();

  /** transport high-water pause 只按 trusted connectionId 隔离，不改变 ingest/publisher 真值。 */
  readonly pausedConnections = new Set<string>();

  /** 一个越界周期只触发一次 runtime stop；终态事件到达后解除。 */
  readonly projectionFaultedSessions = new Set<string>();

  readonly inbox: CommandInbox;

  readonly attachmentUploads: AttachmentUploadRegistry;

  readonly binaryReadCache = new Map<string, BinaryReadCacheEntry>();

  binaryReadCacheBytes = 0;

  readonly localTtft = new LocalTtftRecorder(
    localTtftNow,
    () => {
      this.host.onError?.(
        "v4.localTtft.completedCapacity",
        new Error("TTFT completed record capacity exceeded"),
      );
    },
    (facts) => {
      const parsed = localTtftFactsSchema.safeParse(facts);
      if (parsed.success) this.host.emitLocalTtftFacts?.(parsed.data);
    },
  );

  /** 高频进度事件的 index fan-out 节流（14-sessions-index「事件 fan-out 节奏」）。 */
  readonly indexFanoutThrottle = new SessionsIndexFanoutThrottle({
    publish: (sessionId) => this.publishCurrentSummaryToIndex(sessionId),
  });

  readonly attachmentPruneTimer: ReturnType<typeof setInterval>;

  readonly now: () => number;

  readonly createLogEpoch: (sessionId: string) => string;

  readonly telemetryNormalizer = new ConversationTelemetryFactNormalizer();

  readonly cuaPermissionNormalizer = new CuaPermissionObservationNormalizer();

  readonly telemetryEventIds = new Set<string>();

  disposed = false;

  /** session entry 状态变更后的轻量 metadata 更新，不重放 conversation event。 */
  updateSharedContextImport(
    sessionId: string,
    source: ConversationSnapshot["sharedContextImport"],
  ): void {
    updateSharedContextImport(this, sessionId, source);
  }

  constructor(
    readonly host: V4GatewayHost,
    options: ConversationV4GatewayOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.createLogEpoch = options.createLogEpoch ?? defaultLogEpoch;
    this.coldResume = new ColdSessionResumeCoordinator(host);
    this.inbox = new CommandInbox({
      prepareDecision: async (envelope) => {
        if (
          envelope.sessionId &&
          (envelope.type === "renameSession" || envelope.type === "deleteSession") &&
          !this.host.sessionExists(envelope.sessionId)
        ) {
          // 历史行的重命名 / 删除仍由 CLI 原命令写持久事实；只在真实命令 admission 后冷恢复。
          await this.ensureColdReadyPublisher(envelope.sessionId);
        }
      },
      getRevision: (sessionId) => {
        if (
          !this.host.sessionExists(sessionId) &&
          !this.publishers.get(sessionId)?.getSnapshot().runtimeInitialization
        )
          return null;
        // 已知会话但尚无事件 → 投影未建，revision 视为 0（draft 起点）。
        return this.publishers.get(sessionId)?.getSnapshot().revision ?? 0;
      },
      getLogEpoch: (sessionId) => this.publishers.get(sessionId)?.getSnapshot().logEpoch ?? null,
      validateRowTarget: (envelope) => {
        const action = rowTargetActionForCommand(envelope.type);
        if (!action || envelope.sessionId === null) return { verdict: "allow" };
        const target = (envelope.payload as { target?: ConversationRowTarget }).target;
        if (!target) return { verdict: "reject", reasonCode: "proto.invalidPayload" };
        const resolution = this.publishers
          .get(envelope.sessionId)
          ?.resolveRowActionTarget(target, action);
        if (!resolution) return { verdict: "stale", reasonCode: "proto.staleTarget" };
        if (resolution.ok) return { verdict: "allow" };
        return resolution.status === "stale"
          ? { verdict: "stale", reasonCode: resolution.reasonCode }
          : { verdict: "reject", reasonCode: resolution.reasonCode };
      },
      // 在 inbox 去重之后拒绝新执行，不把未就绪输入接受进运行队列。
      guard: (envelope) => {
        const initialization =
          envelope.sessionId === null
            ? undefined
            : this.publishers.get(envelope.sessionId)?.getSnapshot().runtimeInitialization;
        return initialization && initialization.status !== "ready"
          ? {
              verdict: "reject",
              reasonCode:
                initialization.status === "failed"
                  ? "guard.runtimeInitializationFailed"
                  : "guard.runtimeInitializing",
            }
          : { verdict: "allow" };
      },
      lookupTranscriptCommand: (key) => this.host.lookupTranscriptCommand?.(key) ?? null,
      lookupTimelineCommand: (key) => this.host.lookupTimelineCommand?.(key) ?? null,
      lookupChildCommand: (key) => this.host.lookupChildCommand?.(key) ?? null,
      lookupDiscardedCommand: (key) => this.host.lookupDiscardedCommand?.(key) ?? null,
      now: this.now,
    });
    this.attachmentUploads = new AttachmentUploadRegistry({
      now: this.now,
      putSessionAttachment: async (sessionId, input) => {
        if (!this.host.putSessionAttachment) {
          throw new Error("fault.attachment.putUnsupported");
        }
        return this.host.putSessionAttachment(sessionId, input);
      },
    });
    this.attachmentPruneTimer = setInterval(
      () => this.attachmentUploads.pruneExpired(),
      Math.min(30_000, PROTOCOL_V4_LIMITS.attachmentUploadTtlMs),
    );
    (
      this.attachmentPruneTimer as ReturnType<typeof setInterval> & { unref?: () => void }
    ).unref?.();
  }

  setConnectionFlowState(rawParams: unknown): void {
    setConnectionFlowState(this, rawParams);
  }

  clearConnectionFlushTimers(connectionId: string): void {
    clearConnectionFlushTimers(this, connectionId);
  }

  flushConnection(connectionId: string): void {
    flushConnection(this, connectionId);
  }

  /** 权威事件入口：投影推进 + 各订阅者按 profile.flushWindowMs 调度打帧。 */
  ingest(sessionId: string, event: SessionEvent): void {
    ingest(this, sessionId, event);
  }

  emitLiveTelemetryFact(sessionId: string, event: SessionEvent): void {
    emitLiveTelemetryFact(this, sessionId, event);
  }

  /** 等待指定 raw event 真正完成 reorder drain + publisher projection apply。 */
  waitForProjectionEventCommit(
    sessionId: string,
    eventId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    return waitForProjectionEventCommit(this, sessionId, eventId, options);
  }

  /** 授权已经提交到任务事务，失败重试必须重放权威日志，不能再次提权或丢弃提交事实。 */
  async waitForPermissionGrantCommit(sessionId: string, eventId: string): Promise<void> {
    return waitForPermissionGrantCommit(this, sessionId, eventId);
  }

  ingestNormalizedEvent(sessionId: string, event: SessionEvent): void {
    ingestNormalizedEvent(this, sessionId, event);
  }

  /**
   * subagent child 使用父 record 的外部 sink，但保留独立 session topic。显式登记这类
   * detached live session，避免把任意偶然存在的 cold publisher 都误判为运行中 child。
   */
  ingestDetachedLiveSession(
    sessionId: string,
    event: SessionEvent,
    parentSessionId?: string,
  ): void {
    ingestDetachedLiveSession(this, sessionId, event, parentSessionId);
  }

  /**
   * 低频 tick 兜底：释放已终态、无订阅者、且没有自己 record 的 detached child publisher。
   * 释放后再被订阅走既有 cold resume（child 作为 subagent_child 持久化在 session store）。返回释放数。
   */
  pruneDetachedChildPublishers(
    nowMs: number = Date.now(),
    graceMs: number = DETACHED_CHILD_PUBLISHER_GRACE_MS,
  ): number {
    return pruneDetachedChildPublishers(this, nowMs, graceMs);
  }

  releaseDetachedChild(childId: string): void {
    releaseDetachedChild(this, childId);
  }

  /**
   * 把某会话的最新摘要推进到其 workspace 的 sessions-index publisher，并 flush 给列表订阅者。
   * projection 必须在无列表订阅者时也继续推进，保证下一次 snapshot 读取权威当前态；
   * 高频流式增量（ModelStreaming）不触发列表重算，避免抖动（预览在 turn 收口/其他事件时更新）。
   * 旧宿主无 getSessionWorkspaceId → 整体 no-op。
   */
  fanOutToIndex(sessionId: string, event: SessionEvent): void {
    fanOutToIndex(this, sessionId, event);
  }

  /**
   * 把当前完整 projection 发布到 sessions-index。
   *
   * fork child 的 resume 会先用少量 live event 建出暂态 draft publisher，
   * 随后的 synthesized hydration 才补齐继承历史。只在 ingest(event) 时 fan-out 的话，
   * hydration 完成后若没有下一条 runtime event，child 就永远停在 draft 基线，
   * task-index syncer 无法观察到 draft→visible，也就不会创建侧栏 task row。
   */
  publishCurrentSummaryToIndex(sessionId: string): void {
    publishCurrentSummaryToIndex(this, sessionId);
  }

  /** 会话列表元信息（宿主 hook 缺省时的兜底：createdAt=0，lastActivityAt=now）。 */
  resolveIndexMeta(sessionId: string): {
    createdAt: number;
    lastActivityAt: number;
    lastOutcome?: SessionSummary["lastOutcome"];
    parentSessionId?: string;
  } {
    return resolveIndexMeta(this, sessionId);
  }

  /** 把某 workspace index publisher 的未发增量帧推给所有列表订阅者。 */
  flushIndex(workspaceId: string, onlyConnectionId?: string): void {
    flushIndex(this, workspaceId, onlyConnectionId);
  }

  /**
   * sessions-index 订阅：订阅某 workspace 的会话列表（与 conversation subscribe 并列，
   * 同一 RPC 方法按 topic 前缀分派）。冷启动：store 摘要种子 + 已加载会话 live 投影覆盖。
   */
  async subscribeSessionsIndex(
    rawParams: unknown,
  ): Promise<V4SubscribeDispatchResult<SessionsIndexTopicFrame>> {
    return subscribeSessionsIndex(this, rawParams);
  }

  async reconcileSessions(rawParams: unknown): Promise<SessionsIndexReconcileResult> {
    return reconcileSessions(this, rawParams);
  }

  async subscribeSessionsIndexReserved(
    rawParams: unknown,
  ): Promise<V4SubscribeDispatchResult<SessionsIndexTopicFrame>> {
    return subscribeSessionsIndexReserved(this, rawParams);
  }

  /** 建/取某 workspace 的 index publisher；建时 store 摘要种子 + live 投影覆盖。 */
  async ensureIndexPublisher(
    workspaceId: string,
    legacyTaskIds?: readonly string[],
  ): Promise<SessionsIndexPublisher> {
    return ensureIndexPublisher(this, workspaceId, legacyTaskIds);
  }

  /** 同 workspace 串行区：可重试 claim/重读与 publisher 构造必须观察同一份最终快照。 */
  async ensureIndexPublisherExclusive(
    workspaceId: string,
    legacyTaskIds?: readonly string[],
  ): Promise<SessionsIndexPublisher> {
    return ensureIndexPublisherExclusive(this, workspaceId, legacyTaskIds);
  }

  /**
   * workspace-config 订阅：订阅某 workspace 的配置目录（与 conversation subscribe 并列，
   * 同一 RPC 方法按 topic 前缀分派）。订阅时经宿主钩子拉取当前配置作种子。
   */
  async subscribeWorkspaceConfig(
    rawParams: unknown,
  ): Promise<V4SubscribeDispatchResult<WorkspaceConfigTopicFrame>> {
    return subscribeWorkspaceConfig(this, rawParams);
  }

  async subscribeWorkspaceConfigReserved(
    rawParams: unknown,
  ): Promise<V4SubscribeDispatchResult<WorkspaceConfigTopicFrame>> {
    return subscribeWorkspaceConfigReserved(this, rawParams);
  }

  /**
   * 配置目录发布入口（宿主在 provider registry 应用 / workspace 默认项变更后调用，
   * 直接携带已构建好的目录，不回头重拉宿主，避免重复 buildWorkspaceState 的临时 app 成本）。
   * conflation 在 publisher 内完成（未变化不产帧）；无 publisher 时同步建一个空种子的
   * publisher 存住最新态，后续订阅者据此拿到完整 snapshot。
   */
  publishWorkspaceConfig(workspaceId: string, state: WorkspaceConfigState): void {
    publishWorkspaceConfig(this, workspaceId, state);
  }

  async pullWorkspaceConfig(workspaceId: string): Promise<WorkspaceConfigState | null> {
    return pullWorkspaceConfig(this, workspaceId);
  }

  /** 建/取某 workspace 的 config publisher；建时经宿主钩子拉取当前目录作种子。 */
  async ensureConfigPublisher(workspaceId: string): Promise<WorkspaceConfigPublisher> {
    return ensureConfigPublisher(this, workspaceId);
  }

  /** 把某 workspace config publisher 的未发增量帧推给所有订阅者。 */
  flushConfig(workspaceId: string, onlyConnectionId?: string): void {
    flushConfig(this, workspaceId, onlyConnectionId);
  }

  /** v4/conversation/subscribe：裁决 + server 内部 initial frame，公共响应由 server 只取 ACK。 */
  async subscribe(rawParams: unknown): Promise<V4SubscribeDispatchResult<ConversationTopicFrame>> {
    return subscribe(this, rawParams);
  }

  async subscribeReserved(
    rawParams: unknown,
  ): Promise<V4SubscribeDispatchResult<ConversationTopicFrame>> {
    return subscribeReserved(this, rawParams);
  }

  /**
   * v4/conversation/resync：按 owned topic/connection 精确命中现有 subscription，
   * 保持 subId/profile 不变，从客户端 base 重新裁决 resume/snapshot。
   */
  resyncReserved(rawParams: unknown): V4SubscribeDispatchResult<RoutedTopicFrame> {
    return resyncReserved(this, rawParams);
  }

  /**
   * v4/conversation/rowsRange：按 beforeRowId 游标向上取一窗
   * 历史行。只读 query，不建订阅；数据源 = 该会话投影全量行——冷会话（重启后直开
   * 历史）复用与 subscribe 相同的冷恢复 + hydration 管线先把投影建起来。
   */
  async rowsRange(rawParams: unknown): Promise<V4ConversationRowsRangeResult> {
    return rowsRange(this, rawParams);
  }

  /** 完整有效 projection 的终态计划目录；冷会话复用订阅 hydration。 */
  async plans(rawParams: unknown): Promise<V4ConversationPlansResult> {
    return plans(this, rawParams);
  }

  /**
   * workflow run 事件日志的分页读取（cursor = journal sequence）。
   *
   * 与 rows/range、plans 同族：只读、无状态、超时重发安全。刻意**不是** v4 command——
   * command 的 ACK 结果是那个封闭的「变更结果」判别联合，一页只读事件不属于那个词汇表。
   *
   * 一页的条数与字节两道界在这里定（docs/execution-engine.md「Reading the journal」）：条数取
   * 调用方的 limit，缺省为协议上限；字节恒为协议上限，renderer 不能放宽。`hasMore` 由存储层
   * 判定——页可能因字节提前收尾，「取满 limit」已经不是判据。
   */
  async workflowRunEvents(rawParams: unknown): Promise<V4ConversationWorkflowRunEventsResult> {
    return workflowRunEvents(this, rawParams);
  }

  /**
   * dwf run 的枚举 query。与
   * workflowRunEvents 同族：只读、无状态、超时重发安全。limit 的缺省与钳制在 CLI 侧
   * （run service），这里只透传；`resumable` 由 CLI 按 resume 门的同一个谓词算好。
   */
  async workflowRuns(rawParams: unknown): Promise<V4ConversationWorkflowRunsResult> {
    return workflowRuns(this, rawParams);
  }

  /**
   * workflow run 的**用户面产物**清单。
   * 与 workflowRunEvents 同族：只读、无状态、超时重发安全。
   *
   * ⚠ 术语：这里的 artifact 是脚本经 `artifact.*` 发布给用户看的产出，不是 run 的顶层
   * 返回值（引擎内部对后者的同名叫法）。
   *
   * 未知 runId 回空清单而不是错误：一个已被淘汰 / 从未存在的 run 没有产物，这是一个
   * 事实而不是故障——同一姿态见事件日志对越界 cursor 的处理。
   */
  async workflowRunArtifacts(
    rawParams: unknown,
  ): Promise<V4ConversationWorkflowRunArtifactsResult> {
    return workflowRunArtifacts(this, rawParams);
  }

  /**
   * 预置看板的取数面：喂给某个产物的 `report` 条目分页。
   *
   * 条数的**缺省与钳制**、以及字节上界都在这里定（存储层精确兑现、绝不自造页大小也绝不再钳）。`fields` 原样下传：看板只要 spec 点名的字段，由 SQLite 取出；`hasMore` 由存储层判定——页可能因字节提前收尾，所以判据绝不能是
   * 「这页正好满」，也不再是网关多取一条。
   */
  async workflowRunArtifactData(
    rawParams: unknown,
  ): Promise<V4ConversationWorkflowRunArtifactDataResult> {
    return workflowRunArtifactData(this, rawParams);
  }

  /**
   * 内容产物的字节，**逐字照 attachmentRead**：一次一块、≤ 512 KiB（schema 已钉住 limit 的
   * 上界），`nextOffset` 为 null 即读到尾。
   *
   * **授权全在宿主侧**（端口实现）：该 run 必须属于 `sessionId` 这个会话 ∧ journal 里有
   * `(artifactId, version)` 的 completed 行，然后才拿**行上的** uri 去 store 读。网关只做
   * 参数校验与分块——它没有 journal，也不该有第二份授权判据（两处各判一次，同一个 id
   * 迟早会在两层上得到不同的解释）。宿主回 `undefined` = 无此版本 / 不是你的 run /
   * 这是块看板（没有字节），三者对调用方是同一个业务事实，这里归一成结构化的 not found。
   *
   * `offset` 越界不是错误：返回空块 + `nextOffset: null`，与读到尾同一形态。
   */
  async workflowRunArtifactRead(
    rawParams: unknown,
  ): Promise<V4ConversationWorkflowRunArtifactReadResult> {
    return workflowRunArtifactRead(this, rawParams);
  }

  /**
   * 工作区 transcript 的清单：一个 run 的
   * `files.*` / `git.*` / `world.run` 行，不带正文。
   *
   * 宿主回 `undefined`（未知 run / 不是你的 run）得到空清单而不是错误：与产物清单同一姿态，
   * 也是授权链「不告诉越权者猜对了哪一半」的要求。清单超过 maxNodes 截尾并置 `truncated`——
   * 一个循环里跑了三千次 `world.run` 的 run 不该把侧板撑爆。
   */
  async workflowRunWorkspace(
    rawParams: unknown,
  ): Promise<V4ConversationWorkflowRunWorkspaceResult> {
    return workflowRunWorkspace(this, rawParams);
  }

  /**
   * 一个工作区节点的正文，按 `maxBytes` 保形有界化（缺省与上限都是 resultMaxBytes，钳在这里）。
   * 授权全在宿主侧；宿主回 `undefined` = 无此节点 / 不是你的 run / 不是 world 行，归一成
   * 结构化的 not found。
   */
  async workflowRunNodeResult(
    rawParams: unknown,
  ): Promise<V4ConversationWorkflowRunNodeResultResult> {
    return workflowRunNodeResult(this, rawParams);
  }

  /**
   * 一个产物版本的**整份**字节，带缓存。
   *
   * 端口的 `readArtifact` 返回的是整份字节，而
   * `workflowRunArtifactRead` 是**分块**查询——不缓存的话，一个 20 MiB 的 PDF 按 512 KiB
   * 分 40 块取，就会把整份文件从 store 读 40 遍（800 MiB 的 I/O），而且每一块都要重走一遍
   * journal 授权链。`attachmentRead` 早就有这张表，这里复用它（见 {@link BinaryReadCacheEntry}
   * 关于两个家族共用一张表的论证）。
   *
   * 缓存的是 **promise 而不是结果**，且在发起前就写进表里：并发抓取的多个分块因此共享
   * 同一次读，而不是各自发起一次再各自写一遍缓存。
   *
   * 授权不因缓存被绕过：键里带着 `sessionId`，而 `sessionId` 正是端口那条授权链
   * （run 的 parentSessionId 必须等于它）的比对对象——换一个会话就是另一个键，必然重新
   * 走一次端口。会话销毁时按 `sessionId` 整片清掉，与附件同一条规则。
   *
   * 宿主回 `undefined`（不是你的 run / 无此版本 / 是块看板）在这里**抛错**而不是被缓存：
   * 走既有的 catch 分支把条目删掉，于是一个"发布刚落库、读稍微早了一步"的竞态不会被
   * 负缓存钉死 30 秒。
   */
  readWorkflowArtifactPayload(params: {
    sessionId: string;
    runId: string;
    artifactId: string;
    version: number;
  }): Promise<{ bytes: Uint8Array; mediaType: string }> {
    return readWorkflowArtifactPayload(this, params);
  }

  /**
   * dwf 两个 journal 读面的宿主 record 前置。
   *
   * 这两个 query 都经 app 能力读 journal，而宿主按 sessionId 找 record——历史
   * 会话的 record 只由**订阅**路径激活。renderer 里发现查询的 effect 声明在 lease/订阅
   * effect 之前，而 CLI 严格串行派发请求（`zcode-protocol/transport.ts`，只有 session/stop
   * 越队），于是「重启后打开历史会话」时它必然先于订阅被处理、必然拿到 sessionNotFound：
   * 工具卡的 join 回退整块消失，卡片退回编译态，被打断的 run 连入口都没有。
   *
   * 只拉 record，**不**建 READY publisher：journal 与 conversation log 无关，读一页 run
   * 不需要投影（同一判断见这两个 query 刻意不带 atSeq/atLogEpoch）。习语与 attachmentBegin
   * 逐字相同；`ensureResumed` 自带按会话单飞，与并发订阅共享同一次 activation。
   *
   * 活性判定必须与 subscribe 同一条
   * `hasLiveConversation`，不能只看 `sessionExists`。dwf actor transcript 是 detached live
   * 会话——真 runtime 活在 run service 里、宿主刻意没有 record；嵌套 SessionPane 的发现
   * 查询带着 actor id 打到这里，旧判定就对一条**正在运行**的会话物化出第二个（幽灵）
   * runtime：它向同一份事件日志追加 SessionResumed、丢弃 pending steer、重放 resume hooks，
   * 双写把序列账搞乱，transcript 从此定格（症状是直播冻结在「已工作 xx 秒」）。
   */
  async ensureHostRecordForJournalRead(sessionId: string): Promise<void> {
    return ensureHostRecordForJournalRead(this, sessionId);
  }

  async fileChanges(rawParams: unknown): Promise<V4ConversationFileChangesResult> {
    return fileChanges(this, rawParams);
  }

  async backgroundBashOutput(rawParams: unknown): Promise<BackgroundBashOutputResult> {
    return backgroundBashOutput(this, rawParams);
  }

  async fileRewindPreview(rawParams: unknown): Promise<V4ConversationFileRewindPreviewResult> {
    return fileRewindPreview(this, rawParams);
  }

  resolveQueryRowTarget(
    publisher: ConversationTopicPublisher,
    params: {
      target: ConversationRowTarget;
      baseRevision: number;
      baseLogEpoch: string;
    },
    action: "fileChanges" | "fileRewindPreview",
  ): Extract<ReturnType<ConversationTopicPublisher["resolveRowActionTarget"]>, { ok: true }> {
    return resolveQueryRowTarget(this, publisher, params, action);
  }

  /** begin 只 admission metadata，不解码/暂存 full payload。 */
  async attachmentBegin(rawParams: unknown): Promise<V4AttachmentBeginResult> {
    return attachmentBegin(this, rawParams);
  }

  async attachmentChunk(rawParams: unknown): Promise<V4AttachmentChunkResult> {
    return attachmentChunk(this, rawParams);
  }

  attachmentCommit(rawParams: unknown): Promise<V4AttachmentCommitResult> {
    return attachmentCommit(this, rawParams);
  }

  async attachmentAbort(rawParams: unknown): Promise<void> {
    return attachmentAbort(this, rawParams);
  }

  async attachmentRead(rawParams: unknown): Promise<V4AttachmentReadResult> {
    return attachmentRead(this, rawParams);
  }

  async conversationAttachmentRead(
    rawParams: unknown,
  ): Promise<V4ConversationAttachmentReadResult> {
    return conversationAttachmentRead(this, rawParams);
  }

  async conversationAttachmentStat(
    rawParams: unknown,
  ): Promise<V4ConversationAttachmentStatResult> {
    return conversationAttachmentStat(this, rawParams);
  }

  async attachmentPreviewSource(rawParams: unknown): Promise<V4AttachmentPreviewSourceResult> {
    return attachmentPreviewSource(this, rawParams);
  }

  resolveReadableMediaAttachment(
    publisher: ConversationTopicPublisher,
    sessionId: string,
    ref: string,
    target?: { rowId: number; entityId: string },
    attachmentIndex?: number,
  ): { attachment: AttachmentRef; messageId?: string; attachmentIndex?: number } | null {
    return resolveReadableMediaAttachment(this, publisher, sessionId, ref, target, attachmentIndex);
  }

  /**
   * 读取附件全部字节（带 TTL/容量缓存）。
   *
   * 注意语义：conversationAttachmentRead 的 offset/limit 是**切片**，不是流式读取——
   * 每个首次请求都会把整个附件物化进内存再切片，后续 chunk 命中同一份缓存。
   * 接入方不要把 chunk 协议当作「按需分段拉取」来规划超大文件；真正的 range 读取
   * 需要 host 侧 readBinaryFile 支持 offset（尚未实现）。
   */
  readAttachmentPayload(
    sessionId: string,
    ref: string,
    mime: string,
    messageId?: string,
    attachmentIndex?: number,
    allowGeneric = false,
  ): Promise<{ bytes: Uint8Array; mediaType: string }> {
    return readAttachmentPayload(
      this,
      sessionId,
      ref,
      mime,
      messageId,
      attachmentIndex,
      allowGeneric,
    );
  }

  pruneBinaryReadCache(now = this.now()): void {
    pruneBinaryReadCache(this, now);
  }

  deleteBinaryReadCacheEntry(key: string): void {
    deleteBinaryReadCacheEntry(this, key);
  }

  /** v4/conversation/unsubscribe。 */
  unsubscribe(rawParams: unknown): void {
    unsubscribe(this, rawParams);
  }

  /**
   * v4/command：inbox 六态裁决；accepted 时执行副作用并把终态随响应返回。
   *
   * 这里曾经"立即回初始 ACK、后台 settle"，
   * 导致 createSession/forkAssistant 的调用方拿不到 result.sessionId（settle 只回填
   * 幂等表，只有同 commandId 重试才能读到）——违反
   * 「accepted 即时带 result」。命令副作用本身是快返回的（sendPrompt 后台起 turn），
   * await 不会把 RPC 挂到整个 turn 结束，所以同步等待终态。
   * settle 仍然固化结果供 duplicate 重放。
   */
  async handleCommand(rawParams: unknown): Promise<CommandAck> {
    return handleCommand(this, rawParams);
  }

  /** v4/commands/query：同 key 与 handleCommand 共用 CommandInbox gate。 */
  async queryCommands(rawParams: unknown): Promise<CommandsQueryResult> {
    return queryCommands(this, rawParams);
  }

  getQueueItem(sessionId: string, queueItemId: string): QueueItem | null {
    const snapshot = this.publishers.get(sessionId)?.getSnapshot();
    const item = snapshot?.queue.items.find((candidate) => candidate.queueItemId === queueItemId);
    return item ?? null;
  }

  hasQueueItemKind(sessionId: string, kind: QueueItem["kind"]): boolean {
    return Boolean(
      this.publishers
        .get(sessionId)
        ?.getSnapshot()
        .queue.items.some((candidate) => candidate.kind === kind),
    );
  }

  hasQueuedDelivery(sessionId: string, delivery: "guide" | "queue"): boolean {
    return Boolean(
      this.publishers
        .get(sessionId)
        ?.getSnapshot()
        .queue.items.some((candidate) => candidate.delivery.admitted === delivery),
    );
  }

  getQueueLength(sessionId: string): number {
    return this.publishers.get(sessionId)?.getSnapshot().queue.items.length ?? 0;
  }

  /** Resident 回收保护：publisher queue 与 CommandInbox pinned facts 任一存在都不可关闭。 */
  hasResidencyBlockingCommands(sessionId: string): boolean {
    return this.getQueueLength(sessionId) > 0 || this.inbox.hasPinnedSessionState(sessionId);
  }

  getQueueHead(sessionId: string): {
    autoDrain: boolean;
    dispatchState: QueueItem["dispatch"]["state"];
    kind: QueueItem["kind"];
    queueItemId: string;
    text: string;
  } | null {
    const snapshot = this.publishers.get(sessionId)?.getSnapshot();
    const item = snapshot?.queue.items[0];
    if (!snapshot || !item) return null;
    return {
      autoDrain: snapshot.queue.autoDrain,
      dispatchState: item.dispatch.state,
      kind: item.kind,
      queueItemId: item.queueItemId,
      text: item.text,
    };
  }

  /**
   * 当前输入路由模式（v4 原生能力，供命令层 host.getInputRoutingMode 使用）：
   * held choice 裁决（heldQueueInputRequiresChoice）读投影 inputRouting.mode。
   */
  getInputRoutingMode(
    sessionId: string,
  ): "startNow" | "enqueue" | "guide" | "reject" | "choice" | null {
    return this.publishers.get(sessionId)?.getSnapshot().inputRouting.mode ?? null;
  }

  getSessionFollowupMode(sessionId: string): "queue" | "guide" | null {
    return this.publishers.get(sessionId)?.getSnapshot().config.followupMode ?? null;
  }

  /**
   * rowId → 权威 messageId（v4 原生能力，供 forkAssistant/retryTurn 定位 assistant 行）。
   * 会话无 publisher / 行不存在 / 非 assistant 行 → null（命令层据此 reject，不静默兜底）。
   */
  getMessageIdForRow(sessionId: string, rowId: number): string | null {
    return this.publishers.get(sessionId)?.getMessageIdForRow(rowId) ?? null;
  }

  resolveRowActionTarget(
    sessionId: string,
    target: ConversationRowTarget,
    action: ConversationRowTargetAction,
  ) {
    return this.publishers.get(sessionId)?.resolveRowActionTarget(target, action) ?? null;
  }

  /** rowId → 所属 product turn 内所有 transcript messageId（文件摘要撤销 / diff 查询）。 */
  getMessageIdsForTurnRow(sessionId: string, rowId: number): string[] {
    return this.publishers.get(sessionId)?.getMessageIdsForTurnRow(rowId) ?? [];
  }

  /** fork 目标必须是所属轮最后一段 assistantText（无投影 → null，按未知处理）。 */
  isLatestAssistantSegmentRow(sessionId: string, rowId: number): boolean | null {
    return this.publishers.get(sessionId)?.isLatestAssistantSegmentRow(rowId) ?? null;
  }

  resolveStableForkCandidate(sessionId: string, rowId: number) {
    return this.publishers.get(sessionId)?.resolveStableForkCandidate(rowId) ?? null;
  }

  /** latestAssistantRetryOnly：retry 目标必须是全时间线最新且有 realUser cause 的 assistantText。 */
  isLatestRetryAssistantRow(sessionId: string, rowId: number): boolean | null {
    return this.publishers.get(sessionId)?.isLatestRetryAssistantRow(rowId) ?? null;
  }

  /** latestQueryEditOnly：edit 目标必须是当前投影里的最后一条 realUser userInput row。 */
  isLatestEditableUserRow(sessionId: string, rowId: number): boolean | null {
    return this.publishers.get(sessionId)?.isLatestEditableUserRow(rowId) ?? null;
  }

  /** rowId → product turnId（editUserQuery 无 assistant anchor 时回查 user messageId）。 */
  getTurnIdForRow(sessionId: string, rowId: number): string | null {
    return this.publishers.get(sessionId)?.getTurnIdForRow(rowId) ?? null;
  }

  /**
   * rowId → 所属 turn 的 rewind 锚点 messageId（供 editUserQuery：user 行无 messageId，
   * 用同 turn 内 assistant 行的 messageId 作 `/rewind` 目标）。
   */
  getTurnRewindAnchor(sessionId: string, rowId: number): string | null {
    return this.publishers.get(sessionId)?.getTurnRewindAnchor(rowId) ?? null;
  }

  /** 关闭只释放运行态；只有 CLI 已持久化软删除时才向列表发 session.removed。
   * 修复原因：Host 将 removed 视为删除事实，普通 tab 关闭不能删除持久化会话。 */
  disposeSession(sessionId: string, options: { deleted?: boolean } = {}): void {
    disposeSession(this, sessionId, options);
  }

  /**
   * Resident 容量去激活：与 disposeSession 相同的内存运行态清理，但**不**从 sessions-index
   * 移除会话（不发 session.removed）——去激活是纯内存优化，侧边栏列表项必须原样
   * 保留，再次订阅经冷恢复透明重建。
   */
  deactivateSession(sessionId: string): void {
    deactivateSession(this, sessionId);
  }

  /**
   * Resident 回收纯预检：调用方可在拆 runtime event subscription 前拒绝不安全回收。
   * deactivateSession 内仍复用同一校验，防止未来新增调用方绕过执行面 preflight。
   */
  assertSessionRuntimeDeactivatable(sessionId: string): void {
    assertSessionRuntimeDeactivatable(this, sessionId);
  }

  /** Resident 回收判定：该会话是否还有 conversation 订阅者（桌面 tab / 手机 remote）。 */
  hasConversationSubscribers(sessionId: string): boolean {
    return hasConversationSubscribers(this, sessionId);
  }

  /**
   * 内存诊断计数器。只读 size，不触碰状态。
   * detachedLive 用于观察子 session publisher 是否随父 session 释放。
   */
  collectMemoryDiagnostics(): Record<string, number> {
    return collectMemoryDiagnostics(this);
  }

  cleanupSessionRuntime(
    sessionId: string,
    options: { clearCommandInbox: boolean; notifyIndexRemoved: boolean },
  ): void {
    cleanupSessionRuntime(this, sessionId, options);
  }

  dispose(): void {
    dispose(this);
  }

  /** 测试探针：立即排空某订阅（绕过定时器）。 */
  flushNow(subscriptionId: string): ConversationTopicFrame | null {
    return flushNow(this, subscriptionId);
  }

  ensurePublisher(sessionId: string): ConversationTopicPublisher {
    return ensurePublisher(this, sessionId);
  }

  /**
   * config 种子注入（防御式：种子失败不打断 conversation 主路径）。
   * 幂等且事件优先（seedConfig 跳过事件触碰过的字段），故在 publisher 创建与
   * hydration 收尾两处都调用——创建时机可能早于 record 完全就位（createSessionRecord
   * 事件接线期间），hydration 处补一次兜住该窗口。
   */
  seedPublisherConfig(sessionId: string, publisher: ConversationTopicPublisher): void {
    seedPublisherConfig(this, sessionId, publisher);
  }

  /** 首帧先落 transport queue，再启动会同步扫描插件的 runtime；重连不重跑失败 hook。 */
  ensureHistoryReadyPublisher(
    sessionId: string,
    thought?: string,
    workspace?: ZCodeWorkspaceRef,
    additionalDirectories?: string[],
    retryAttempt?: string,
  ): Promise<ConversationTopicPublisher> {
    return ensureHistoryReadyPublisher(
      this,
      sessionId,
      thought,
      workspace,
      additionalDirectories,
      retryAttempt,
    );
  }

  setInitialization(
    sessionId: string,
    publisher: ConversationTopicPublisher,
    state: NonNullable<ConversationSnapshot["runtimeInitialization"]>,
  ): void {
    setInitialization(this, sessionId, publisher, state);
  }

  /**
   * 冷恢复 READY 只在明确需要 activation 的入口创建；hydratePublisher 保持 projection-only。
   * 注册 promise 早于 activation，避免 record 提前入册后并发 command/query 越过恢复水位。
   */
  ensureColdReadyPublisher(
    sessionId: string,
    resumeThoughtLevel?: string,
    workspace?: ZCodeWorkspaceRef,
    additionalDirectories?: string[],
  ): Promise<ConversationTopicPublisher> {
    return ensureColdReadyPublisher(
      this,
      sessionId,
      resumeThoughtLevel,
      workspace,
      additionalDirectories,
    );
  }

  /**
   * 首次订阅时的投影重建（hydration）。语义见 subscribe 注释；
   * synthesized 事件按 sequenceNumber 去重（publisher 已 ingest 过的 live 事件不重放）。
   */
  hydratePublisher(
    sessionId: string,
    persistedMessages?: MessageWithParts[],
    forceRebuild = false,
  ): Promise<ConversationTopicPublisher> {
    return hydratePublisher(this, sessionId, persistedMessages, forceRebuild);
  }

  async performHydration(
    sessionId: string,
    buffer: HydrationBuffer,
    persistedMessages?: MessageWithParts[],
    forceRebuild = false,
  ): Promise<ConversationTopicPublisher> {
    return performHydration(this, sessionId, buffer, persistedMessages, forceRebuild);
  }

  /**
   * cold 合成会把事件重新编号为 1..N，而 runtime 仍沿用 eventStore raw seq。这里用
   * source cursor 建立 N-C 偏移；raw seq=0（live-only child）则顺延，并同步校正后续偏移。
   * eventId 兜住 snapshot/buffer 同时看见同一事件的竞态，cursor 兜住已入 snapshot 的事件。
   */
  normalizeRuntimeEventSequence(sessionId: string, event: SessionEvent): SessionEvent[] {
    return normalizeRuntimeEventSequence(this, sessionId, event);
  }

  getOrCreateRawSequenceState(sessionId: string): RawSequenceState {
    return getOrCreateRawSequenceState(this, sessionId);
  }

  resolveProjectionEventCommit(sessionId: string, eventId: string): void {
    resolveProjectionEventCommit(this, sessionId, eventId);
  }

  rejectProjectionEventCommit(sessionId: string, eventId: string, error: Error): void {
    rejectProjectionEventCommit(this, sessionId, eventId, error);
  }

  rejectProjectionEventWaiters(sessionId: string, error: Error): void {
    rejectProjectionEventWaiters(this, sessionId, error);
  }

  /**
   * 运行中 subagent 没有独立 bootstrap record，但 raw child events 会先建立 publisher。
   * publisher 已存在就代表 conversation live 可订阅，不能再把同一 child cold resume 成
   * 第二个 runtime；真正的历史 session 仍由 host record / persisted resume 负责。
   */
  hasLiveConversation(sessionId: string): boolean {
    return hasLiveConversation(this, sessionId);
  }

  async seedPublisherUsage(
    sessionId: string,
    publisher: ConversationTopicPublisher,
    persistedMessages?: MessageWithParts[],
    loadedSeed?: SessionUsageSeed | null,
  ): Promise<void> {
    return seedPublisherUsage(this, sessionId, publisher, persistedMessages, loadedSeed);
  }

  scheduleFlush(routeKey: string, state: FlushState, publisher: ConversationTopicPublisher): void {
    scheduleFlush(this, routeKey, state, publisher);
  }

  emitReservation<F extends RoutedTopicFrame>(reservation: TopicFrameReservation<F>): boolean {
    return emitReservation(this, reservation);
  }

  subscribeDispatch<F extends RoutedTopicFrame>(
    ack: SubscribeAck,
    reservation: TopicFrameReservation<F> | null,
    afterCommit?: () => void,
  ): V4SubscribeDispatchResult<F> {
    return subscribeDispatch(this, ack, reservation, afterCommit);
  }
}
