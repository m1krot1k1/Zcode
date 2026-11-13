/**
 * task-index/contracts.ts: Публичный контракт syncer'а task index и общий контракт
 * внутренних групп (`TaskIndexRuntime`).
 *
 * Файл содержит только типы: группы реализации импортируют контракт и не образуют
 * циклов импорта. Единственный владелец состояния — фабрика `createTaskIndexSyncer`:
 * она собирает общий контекст, а группы получают его как late-bound `ctx`, поэтому
 * взаимные вызовы (subscribe ↔ recovery ↔ ingest) не зависят от порядка создания.
 */
import type { Emitter, Event, IDisposable } from "@zcode/rpc";
import type {
  ZCodeSessionStateSnapshot,
  ZCodeTaskMeta,
  ZCodeWorkspaceEvent,
  ZCodeWorkspaceTaskListChanged,
} from "@zcode/shared";
import type {
  SessionPhase,
  SessionSummary,
  SessionsIndexTopicFrame,
  SessionsIndexTopicWireCandidate,
  TopicWireFrameAssembler,
  V4SessionsIndexSubscribeResult,
  V4WorkspaceConfigSubscribeResult,
  WorkspaceConfigTopicFrame,
  WorkspaceConfigTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import type { TaskFactsContract, TaskFactMutation } from "#src/task-facts/contract.js";
import type { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import type { ZCodeWorkspaceEventSubscriptionParams } from "#src/session/zcodeTaskListTypes.js";
import type {
  IZCodeAgentService,
  ZCodeAgentSessionTarget,
  ZCodeAgentWorkspaceTarget,
} from "../zcodeAgent.js";

/** v4 订阅 connectionId 作用域：与 renderer 侧栏共 topic 不同代际（重订阅替换）。 */
export const TASK_INDEX_SUBSCRIBER_SCOPE = "task-index";
export const MAX_PENDING_TOPIC_FRAMES = 1_024;
export const MAX_PENDING_TOPIC_BYTES = 32 * 1024 * 1024;
export const INITIAL_BASELINE_SEED_BATCH_SIZE = 64;
export const PROVIDER_NOT_READY_RETRY_MS = 5_000;
export const TOPIC_SUBSCRIBE_WARN_INTERVAL_MS = 60_000;

export type TopicSubscribeReason =
  | "initial"
  | "runtime-restart"
  | "snapshot-recovery-gap"
  | "recovery-frame-timeout"
  | "resync-ack-mismatch"
  | "resync-failed"
  | "force-recovery-gap"
  | "pre-ack-overflow"
  | "provider-not-ready-wait"
  | "retry";
export type TopicRetryKind = "provider-not-ready" | "transient";
export type TaskIndexTopicKind = "sessions-index" | "workspace-config";
export type TopicDeliveryKind = "initial" | "online" | "recovery";

export type WorkspaceEventInput = string | ZCodeWorkspaceEventSubscriptionParams;

export interface WorkspaceBroadcastTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId?: string;
}

export interface ZCodeTaskIndexTerminalEvent {
  target: ZCodeAgentSessionTarget;
  /** v4 phase 终态映射：completedSuccess/completedInterrupted → turn.completed；error → turn.failed。 */
  kind: "turn.completed" | "turn.failed";
}

export interface ZCodeTaskIndexReadyEvent {
  target: ZCodeAgentSessionTarget;
  /** v4 phase 终态映射：agent 收口后可接受下一条输入的 ready 边界。 */
  reason: "prompt_completed" | "prompt_failed";
}

export interface ZCodeTaskIndexSyncer {
  mutateSessionFacts(
    target: ZCodeAgentSessionTarget,
    intent: TaskFactMutation,
  ): Promise<ZCodeTaskMeta | null>;

  /**
   * 幂等地为指定 workspace 建立 v4 后台摄入订阅（sessions-index + workspace-config），
   * 把 CLI 权威投影的会话终态/标题/配置目录落到 task index sqlite 与 workspace 广播。
   * 同一 workspace 多次调用只会建立一次。
   */
  ensureWorkspaceSubscription(target: ZCodeAgentWorkspaceTarget): void;
  /** session 维度的激活信号统一收敛为 workspace 级 v4 订阅；初始 snapshot 只静默补缺失行。 */
  ensureSessionSubscription(target: ZCodeAgentSessionTarget): void;
  /**
   * 把一份 session snapshot 同步到 sqlite，并广播 workspace_task_list_changed。
   * desktop-continuous 路径上，zcodeSessionService 在 createSession/resumeSession/setModel
   * 之后调用本方法（send/steer/fork/compact/rewind 旧写路径已删，写路径统一走
   * v4 命令 + sessions-index/workspace 事件），让 sqlite 拿到最新 title/updatedAt 并触发 UI 列表刷新。
   */
  syncSnapshotAndBroadcast(
    snapshot: ZCodeSessionStateSnapshot,
    _options: {
      modelOverride?: string;
      thoughtLevelOverride?: string;
      unreadSignal?: ZCodeWorkspaceTaskListChanged["unreadSignal"];
      /**
       * 设计修正：必填。切模型（task_model_changed）/快照收敛（task_status_changed）
       * 这类变更不得落到 task_meta_changed——后者会被 UI 当成归属相关变更
       * 触发全局 membership 重拉和列表整刷。
       */
      broadcastReason: ZCodeWorkspaceTaskListChanged["reason"] | null;
    },
  ): Promise<ZCodeTaskMeta>;
  /**
   * 只更新 task index 中的模型记录，不广播历史 snapshot。
   * 发送前 resume 会关闭 snapshot 广播，避免旧终态覆盖本地 streaming UI，
   * 但仍需要把 sqlite 的 model 从已删除历史模型更新到本次实际使用的可用模型。
   */
  syncTaskModel(target: ZCodeAgentSessionTarget, model: string): Promise<ZCodeTaskMeta | null>;
  /**
   * 主动触发一次 workspace_task_list_changed 广播。
   * 给 adapter 用：archive / rename / pin / delete 等 task 元数据变更后仍要广播。
   * 设计修正：reason 必填。曾经的缺省值（task_meta_changed）让所有不表态的发射点
   * 静默落入 UI 最重的刷新语义（全局 membership 重拉），是"输入框操作/任务收口
   * 引发左侧列表整刷"的根因；发射点必须显式声明变更类别。
   */
  emitWorkspaceTaskListChanged(
    target: WorkspaceBroadcastTarget,
    meta: ZCodeTaskMeta | undefined,
    reason: ZCodeWorkspaceTaskListChanged["reason"],
    options?: Pick<ZCodeWorkspaceTaskListChanged, "unreadSignal">,
  ): void;
  /**
   * 获取共享的 workspace emitter，给 adapter 用来 fire 非 task_list_changed 类事件
   * （如 workspace_config_options_update）。这样 adapter 和 syncer 共用同一 emitter，
   * 订阅者只需要订阅一次即可收到全部事件。
   */
  getWorkspaceEmitter(workspace: WorkspaceEventInput): Emitter<ZCodeWorkspaceEvent>;
  /** 订阅 workspace 维度事件流。adapter.onDynamicWorkspaceEvent 直接转发到这里。 */
  onDynamicWorkspaceEvent(workspace: WorkspaceEventInput): Event<ZCodeWorkspaceEvent>;
  /**
   * 订阅 v4 sessions-index 观察到的会话 phase 终态迁移。
   * 这不是 UI stream，只给 host runtime command queue 等 services 内部状态收口使用。
   */
  onSessionTerminalEvent: Event<ZCodeTaskIndexTerminalEvent>;
  /**
   * 订阅会话收口后的 prompt ready 状态（phase 进入 completedSuccess/completedInterrupted/error）。
   * 手机 host command queue 只能以这个事件作为继续发送下一条的边界。
   */
  onSessionReadyEvent: Event<ZCodeTaskIndexReadyEvent>;
  /** 仅观察已经存在的订阅，不为自动归档创建 runtime 或第二份 phase 状态。 */
  activeTaskRefs(): Array<{ workspacePath: string; workspaceIdentity?: string; taskId: string }>;
  /** 释放所有 v4 订阅和 workspace emitter；不关闭注入的 taskIndexRepo。 */
  disposeAll(): void;
}

export interface CreateZCodeTaskIndexSyncerOptions {
  agentService: IZCodeAgentService;
  taskIndexRepo: TaskIndexRepo;
}

export interface TopicRecoveryState {
  generation: number;
  subscriptionId: string;
  forceSnapshot: boolean;
  ackReceived: boolean;
  frameApplied: boolean;
  upgradeToSnapshot: boolean;
  postRecoveryGapPending: boolean;
  frameDeadline: ReturnType<typeof setTimeout> | null;
}

export interface PendingTopicFrames<TFrame> {
  generation: number;
  frames: TFrame[];
  stagedBytes: number;
  recoveryNeeded: boolean;
}

export interface WorkspaceIngestState {
  target: ZCodeAgentWorkspaceTarget;
  /** 当前已 attach 的 Agent runtime generation；null = dormant。 */
  runtimeGeneration: number | null;
  /** sessions-index 订阅代际（帧过滤闸门；null = 订阅建立中）。 */
  indexSubscriptionId: string | null;
  /** workspace-config 订阅代际。 */
  configSubscriptionId: string | null;
  /** 两个 topic 各自换代；单一 topic 恢复不得让 sibling 的迟到 ACK 失效。 */
  indexSubscriptionGeneration: number;
  configSubscriptionGeneration: number;
  indexPending: PendingTopicFrames<SessionsIndexTopicWireCandidate> | null;
  configPending: PendingTopicFrames<WorkspaceConfigTopicWireCandidate> | null;
  /** 每个 topic 独立记账的已确认水位，不能共用一个 seq/epoch。 */
  indexLogEpoch: string | null;
  indexSeq: number;
  configLogEpoch: string | null;
  configSeq: number;
  /** ACK 只证明 admission；首个 logical frame 原子 apply 后才允许把 epoch/seq 当 resume base。 */
  indexHasAppliedBase: boolean;
  configHasAppliedBase: boolean;
  indexRecovery: TopicRecoveryState | null;
  configRecovery: TopicRecoveryState | null;
  indexRecoveryGeneration: number;
  configRecoveryGeneration: number;
  /** runtime 重启/恢复 RPC 暂态失败后的 topic-local 退避，sibling 继续活着。 */
  indexRetryTimer: ReturnType<typeof setTimeout> | null;
  configRetryTimer: ReturnType<typeof setTimeout> | null;
  indexRetryAttempt: number;
  configRetryAttempt: number;
  /** 持续故障的 production warn 限频；成功订阅后清空，让下一次新故障立即可见。 */
  indexLastWarnAt: number | null;
  configLastWarnAt: number | null;
  /** 会话摘要基线（terminal 迁移/标题变化的 diff 依据）。 */
  summaries: Map<string, SessionSummary>;
  /** 首帧（snapshot）静默补缺失行，但不回放历史终态事件或列表广播。 */
  seeded: boolean;
  /** workspace 级 frame emitter 跨 runtime generation 保持稳定，只允许安装一组 listener。 */
  frameListenersInstalled: boolean;
  disposables: IDisposable[];
  indexAssembler: TopicWireFrameAssembler<SessionsIndexTopicFrame>;
  configAssembler: TopicWireFrameAssembler<WorkspaceConfigTopicFrame>;
  assemblyTimer: ReturnType<typeof setTimeout> | null;
}

/** phase 终态集合（sessions-index 的 conflated 最新态里判定迁移用）。 */
export function isTerminalPhase(phase: SessionPhase): boolean {
  return phase === "completedSuccess" || phase === "completedInterrupted" || phase === "error";
}

export function resolveTerminalUnreadSignal(
  summary: Pick<SessionSummary, "phase" | "goalStatus">,
): ZCodeWorkspaceTaskListChanged["unreadSignal"] {
  if (summary.phase === "error") {
    return "background_terminal";
  }
  if (
    (summary.phase === "completedSuccess" || summary.phase === "completedInterrupted") &&
    (summary.goalStatus === undefined || summary.goalStatus === "verified")
  ) {
    return "background_terminal";
  }
  return undefined;
}

/** Владелец общего состояния: создаётся один раз на инстанс syncer'а. */
export interface TaskIndexCoreState {
  agentService: IZCodeAgentService;
  taskIndexRepo: TaskIndexRepo;
  // task index 的事件摄入从旧协议 shadow 订阅（session/subscribe + session/event +
  // state.updated）整体迁到 v4 帧——sessions-index topic 提供 status(phase)/title/
  // lastActivity 的 workspace 级 conflated 最新态，workspace-config topic 提供配置目录
  // 热更新；正文搜索索引在 phase 终态迁移时回源完整 snapshot 收敛。
  workspaceIngests: Map<string, WorkspaceIngestState>;
  // 之前 workspaceEmitters 私有在 adapter 里，syncer 写完 sqlite 没有广播渠道，
  // UI 永远收不到 workspace_task_list_changed。把 emitter 上提到 syncer，adapter 改为转发，
  // 让 adapter 路径和 desktop-continuous 路径共用同一份订阅，事件不再分裂。
  workspaceEmitters: Map<string, Emitter<ZCodeWorkspaceEvent>>;
  terminalEventEmitter: Emitter<ZCodeTaskIndexTerminalEvent>;
  readyEventEmitter: Emitter<ZCodeTaskIndexReadyEvent>;
  availableRuntimeGenerationByWorkspaceKey: Map<string, number>;
  /** disposed 是可变的生命周期门闩；все группы читают его через один объект. */
  runtimeState: { disposed: boolean };
  hasRuntimeLifecycle: boolean;
  /** Живое состояние: syncer не закрыт и карта всё ещё владеет этим экземпляром. */
  isLiveState(state: WorkspaceIngestState): boolean;
}

export interface EmittersHelpers {
  getWorkspaceEmitter(workspace: WorkspaceEventInput): Emitter<ZCodeWorkspaceEvent>;
  emitWorkspaceTaskListChanged(
    target: WorkspaceBroadcastTarget,
    taskMeta: ZCodeTaskMeta | undefined,
    reason: ZCodeWorkspaceTaskListChanged["reason"],
    options?: Pick<ZCodeWorkspaceTaskListChanged, "unreadSignal">,
  ): void;
  emitTerminalAndReady(target: ZCodeAgentSessionTarget, summary: SessionSummary): void;
}

export interface TargetHelpers {
  sessionTargetFrom(
    workspace: ZCodeAgentWorkspaceTarget,
    sessionId: string,
  ): ZCodeAgentSessionTarget;
  broadcastTargetFrom(target: ZCodeAgentSessionTarget): WorkspaceBroadcastTarget;
}

export interface TopicFramesHelpers {
  isProviderNotReadyError(error: unknown): boolean;
  isRuntimeUnavailableError(error: unknown): boolean;
  indexTopicFor(state: WorkspaceIngestState): string;
  configTopicFor(state: WorkspaceIngestState): string;
  logTopicSubscribeFailure(
    state: WorkspaceIngestState,
    topic: TaskIndexTopicKind,
    reason: TopicSubscribeReason,
    error: unknown,
    retryKind: TopicRetryKind,
  ): void;
  createPendingFrames<TFrame>(generation: number): PendingTopicFrames<TFrame>;
  discardPendingFrames<TFrame>(pending: PendingTopicFrames<TFrame> | null): void;
  stagePendingFrame<
    TFrame extends SessionsIndexTopicWireCandidate | WorkspaceConfigTopicWireCandidate,
  >(
    state: WorkspaceIngestState,
    kind: "sessions-index" | "workspace-config",
    pending: PendingTopicFrames<TFrame>,
    frame: TFrame,
  ): void;
  clearIndexPendingState(state: WorkspaceIngestState): void;
  clearConfigPendingState(state: WorkspaceIngestState): void;
  clearPendingState(state: WorkspaceIngestState): void;
  unsubscribeIndex(state: WorkspaceIngestState, subscriptionId: string): Promise<void>;
  unsubscribeConfig(state: WorkspaceIngestState, subscriptionId: string): Promise<void>;
  clearActiveSubscriptions(state: WorkspaceIngestState): void;
}

export interface TopicRecoveryHelpers {
  clearRecoveryDeadline(recovery: TopicRecoveryState | null): void;
  discardIndexRecovery(state: WorkspaceIngestState): void;
  discardConfigRecovery(state: WorkspaceIngestState): void;
  settleIndexRecovery(state: WorkspaceIngestState, recovery: TopicRecoveryState): void;
  settleConfigRecovery(state: WorkspaceIngestState, recovery: TopicRecoveryState): void;
  completeIndexRecoveryFrame(state: WorkspaceIngestState, deliveryKind: TopicDeliveryKind): void;
  completeConfigRecoveryFrame(state: WorkspaceIngestState, deliveryKind: TopicDeliveryKind): void;
  requestIndexRecovery(state: WorkspaceIngestState, forceSnapshot?: boolean): void;
  requestConfigRecovery(state: WorkspaceIngestState, forceSnapshot?: boolean): void;
  handleIndexGap(state: WorkspaceIngestState, deliveryKind: TopicDeliveryKind): void;
  handleConfigGap(state: WorkspaceIngestState, deliveryKind: TopicDeliveryKind): void;
}

export interface TopicSubscribeHelpers {
  subscribeIndexTopic(
    state: WorkspaceIngestState,
    reason: TopicSubscribeReason,
    unsubscribeActive: boolean,
  ): Promise<void>;
  subscribeConfigTopic(
    state: WorkspaceIngestState,
    reason: TopicSubscribeReason,
    unsubscribeActive: boolean,
  ): Promise<void>;
  activateIndexSubscribe(
    state: WorkspaceIngestState,
    generation: number,
    pending: PendingTopicFrames<SessionsIndexTopicWireCandidate>,
    result: V4SessionsIndexSubscribeResult,
  ): Promise<void>;
  activateConfigSubscribe(
    state: WorkspaceIngestState,
    generation: number,
    pending: PendingTopicFrames<WorkspaceConfigTopicWireCandidate>,
    result: V4WorkspaceConfigSubscribeResult,
  ): Promise<void>;
  scheduleIndexRetry(state: WorkspaceIngestState, retryKind: TopicRetryKind): void;
  scheduleConfigRetry(state: WorkspaceIngestState, retryKind: TopicRetryKind): void;
}

export interface TopicIngestHelpers {
  markAssemblyFault(
    state: WorkspaceIngestState,
    kind: "sessions-index" | "workspace-config",
    reasonCode: string,
    deliveryKind: TopicDeliveryKind | undefined,
  ): void;
  scheduleAssemblyExpiry(state: WorkspaceIngestState): void;
  handleSessionsIndexWire(state: WorkspaceIngestState, wire: SessionsIndexTopicWireCandidate): void;
  handleWorkspaceConfigWire(
    state: WorkspaceIngestState,
    wire: WorkspaceConfigTopicWireCandidate,
  ): void;
}

export interface SessionsIndexIngestHelpers {
  applySessionsIndexFrame(
    state: WorkspaceIngestState,
    frame: SessionsIndexTopicFrame,
    deliveryKind: TopicDeliveryKind,
  ): void;
  processSummary(
    state: WorkspaceIngestState,
    previous: SessionSummary | undefined,
    next: SessionSummary,
    deliveryKind: TopicDeliveryKind,
  ): void;
  applyTerminalTransition(
    target: ZCodeAgentSessionTarget,
    summary: SessionSummary,
    options?: { captureRepoSnapshot?: boolean },
  ): void;
  applyTitleChange(target: ZCodeAgentSessionTarget, summary: SessionSummary): void;
  seedMissingRowsFromInitialSnapshot(
    state: WorkspaceIngestState,
    summaries: Iterable<SessionSummary>,
  ): Promise<void>;
}

export interface ConfigIngestHelpers {
  applyWorkspaceConfigFrame(
    state: WorkspaceIngestState,
    frame: WorkspaceConfigTopicFrame,
    deliveryKind: TopicDeliveryKind,
  ): void;
}

export interface TaskFactsHelpers {
  taskFacts: TaskFactsContract;
  mirrorSummary: TaskFactsContract["ingest"];
  refreshSessionFacts(target: ZCodeAgentSessionTarget): Promise<ZCodeTaskMeta | null>;
  mutateSessionFacts(
    target: ZCodeAgentSessionTarget,
    intent: TaskFactMutation,
  ): Promise<ZCodeTaskMeta | null>;
  reconcileSnapshotOmissions(state: WorkspaceIngestState, snapshotSeq: number): Promise<void>;
  resyncTaskIndexRowFromAgent(
    target: ZCodeAgentSessionTarget,
    reason: string,
    options?: { unreadSignal?: ZCodeWorkspaceTaskListChanged["unreadSignal"] },
  ): Promise<void>;
}

export interface SnapshotSyncHelpers {
  syncSnapshotAndBroadcast(
    snapshot: ZCodeSessionStateSnapshot,
    options: {
      modelOverride?: string;
      thoughtLevelOverride?: string;
      unreadSignal?: ZCodeWorkspaceTaskListChanged["unreadSignal"];
      broadcastReason: ZCodeWorkspaceTaskListChanged["reason"] | null;
    },
  ): Promise<ZCodeTaskMeta>;
  syncTaskModel(target: ZCodeAgentSessionTarget, model: string): Promise<ZCodeTaskMeta | null>;
}

export interface WorkspaceLifecycleHelpers {
  ensureWorkspaceFrameListeners(state: WorkspaceIngestState): void;
  establishWorkspaceSubscriptions(state: WorkspaceIngestState): Promise<void>;
  resubscribeWorkspaceAfterRuntimeRestart(workspaceKey: string): void;
  suspendWorkspaceAfterRuntimeUnavailable(workspaceKey: string, generation: number): void;
  ensureWorkspaceSubscription(target: ZCodeAgentWorkspaceTarget): void;
  installRuntimeLifecycle(): IDisposable[];
}

/** Late-bound контекст: каждая группа получает один и тот же объект и вызывает соседей через него. */
export type TaskIndexRuntime = TaskIndexCoreState &
  EmittersHelpers &
  TargetHelpers &
  TopicFramesHelpers &
  TopicRecoveryHelpers &
  TopicSubscribeHelpers &
  TopicIngestHelpers &
  SessionsIndexIngestHelpers &
  ConfigIngestHelpers &
  TaskFactsHelpers &
  SnapshotSyncHelpers &
  WorkspaceLifecycleHelpers;
