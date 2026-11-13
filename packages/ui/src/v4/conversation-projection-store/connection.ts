// Per-session projection store（只读 projection store）。
// 唯一写入方是订阅推送；UI 只读。客户端遵守三条规则：
//   1. snapshot → 整体替换，绝不 merge；
//   2. delta 帧仅在区间衔接（frame.fromSeq === snapshot.seq）时 apply，断档不猜、不缓存补偿；
//   3. base 与状态同生共死——断档时状态未被污染，携当前水位重订阅，由服务端裁决 resume/snapshot。
// 除 optimistic overlay（pending 命令展示）外，本 store 不产生任何 conversation 事实。
//
// 分层说明：这里的类按职责拆分方法（连接/恢复、帧应用、命令与历史查询），
// 但状态字段只存在于 ConversationProjectionConnection 实例上，所有层共享同一个
// state 与相同的更新顺序；分层不复制状态、不新增写入路径。
import {
  isDeterministicContentFault,
  PROTOCOL_V4_LIMITS,
  SUBSCRIPTION_CONTENT_REJECTED,
  type TopicFrameDeliveryKind,
} from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import type { ConversationTransport } from "@/v4/transport.js";
import { ConversationRowPool } from "@/v4/conversationRowSharing.js";
import { trackProjectionStore } from "./diagnostics.js";
import {
  isRuntimeRecycleError,
  monotonicNow,
  roundedDuration,
  RUNTIME_RECYCLE_RETRY_DELAYS_MS,
  RUNTIME_RECYCLED_ERROR,
} from "./guards.js";
import {
  INITIAL_STATE,
  type ConversationStoreState,
  type RecoveryFlight,
  type SessionOpenRendererTiming,
} from "./types.js";

/**
 * 外部 store（useSyncExternalStore 兼容：subscribe + getState 返回稳定引用）。
 * 生命周期由 SessionDataLayer 管（引用计数 + keep-warm），组件不直接 new。
 *
 * 本层持有全部状态与连接/恢复状态机；帧应用与命令查询由子类按职责扩展。
 */
export abstract class ConversationProjectionConnection {
  protected state: ConversationStoreState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  // 订阅代际：并发 connect 只认最新一代，过期结果立即退订防服务端悬挂。
  protected generation = 0;
  // 首次订阅尚未拿到 ACK 时，runtime available 只是当前启动流程的正常完成信号；
  // 记录在途数量，避免生命周期通知再次启动 connect，制造同 topic 的订阅替换竞态。
  private connectInFlight = 0;
  /**
   * subscribe ACK mode 持久到该代首个 logical frame；不能只依赖同步 activate 栈，
   * 因为 notification 可在 ACK Promise resolve 后异步到达。
   */
  protected awaitingInitial: { subscriptionId: string; mode: "snapshot" | "resume" } | null = null;
  /** 当前 subscription 是否已由旧 applied base 或本代 logical frame 证明水位有效。 */
  protected subscriptionHasAppliedBase = false;
  protected recovery: RecoveryFlight | null = null;
  protected readonly offAssemblyFault: () => void;
  protected readonly offRuntimeRestart: (() => void) | null = null;
  protected readonly offRuntimeLifecycle: (() => void) | null = null;
  private runtimeRecycleRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private runtimeRecycleRetryAttempt = 0;
  protected sessionOpenRendererTiming: SessionOpenRendererTiming = {};
  protected initialSubscribeAckAt: number | null = null;
  protected closed = false;

  constructor(
    readonly topic: string,
    protected readonly transport: ConversationTransport,
    // 行结构共享池（docs/performance/conversation-row-structural-sharing.md）；
    // SessionDataLayer 注入跨 store 共享的池，独立构造时退化为 store 内共享。
    protected readonly rowPool: ConversationRowPool = new ConversationRowPool(),
  ) {
    trackProjectionStore(this);
    this.offAssemblyFault = transport.onAssemblyFault((fault) => {
      if (fault.topic === this.topic) {
        this.handleAssemblyFault(fault.subscriptionId, fault.deliveryKind, fault.reasonCode);
      }
    });
    // runtime 换代（CLI 进程换代）按 sessionsIndexStore 的约定优先走 lifecycle：dispose
    // 当场只有 unavailable 可观测，onRuntimeRestart 要等新进程 spawn——懒启动下可能永不到达。
    if (transport.onRuntimeLifecycle) {
      this.offRuntimeLifecycle = transport.onRuntimeLifecycle((state) => {
        if (state === "available") this.handleRuntimeAvailable();
        else this.handleRuntimeUnavailable();
      });
      // proxy handoff 不是 runtime 换代，只有 restart 通道携带该语义——
      // ReplaceableConversationTransport.replace() 只广播 runtimeRestartListeners，不发任何
      // lifecycle 事件。若这里因"二选一"完全放弃 restart 通道，远程 workspace 的 proxy 换代
      // 就无人接收：replace() 已 best-effort 退订旧 proxy 的订阅，store 却停在 live + 旧
      // subscriptionId，帧流静默中断且不自愈。
      // 只认 transportReplaced 即可两不重叠：底层 runtime restart 经 bindRuntimeRestartListener
      // 转发时调的是 listener()（reason 为 undefined），已由 lifecycle 的 available 接管。
      this.offRuntimeRestart = transport.onRuntimeRestart((reason) => {
        if (reason !== "transportReplaced") return;
        this.handleRuntimeRestart(reason);
      });
    } else {
      this.offRuntimeRestart = transport.onRuntimeRestart((reason) =>
        this.handleRuntimeRestart(reason),
      );
    }
  }

  /** 内存诊断：当前 rows.window 行数；只读。 */
  abstract countProjectionRows(): number;

  getState(): ConversationStoreState {
    return this.state;
  }

  getSessionOpenRendererTiming(): SessionOpenRendererTiming {
    return { ...this.sessionOpenRendererTiming };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  protected setState(patch: Partial<ConversationStoreState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /**
   * 发起/重发订阅。base 取自当前 snapshot 水位（水位不变量：仅当真持有该时刻
   * 一致状态才携带）；forceSnapshot 用于 resume 续传帧仍断档的兜底，丢 base 要全量。
   */
  async connect(
    options: {
      forceSnapshot?: boolean;
      retryInitialization?: string;
      initialOverflowRetry?: boolean;
      rendererPrepareStartedAt?: number;
    } = {},
  ): Promise<void> {
    if (this.closed) return;
    const generation = ++this.generation;
    this.discardRecovery();
    const snapshot = options.forceSnapshot ? null : this.state.snapshot;
    const connectStartedAt = options.rendererPrepareStartedAt ?? monotonicNow();
    const subscribeStartedAt = monotonicNow();
    logger.lifecycle.info("v4 conversation store connect started", {
      event: "v4.conversation.store.connect.started",
      generation,
      hasBase: Boolean(snapshot),
      module: "ui.v4.conversation_projection_store",
      status: "started",
      topic: this.topic,
    });
    this.sessionOpenRendererTiming = {
      rendererPrepareMs: roundedDuration(connectStartedAt, subscribeStartedAt),
    };
    this.initialSubscribeAckAt = null;
    this.connectInFlight += 1;
    this.setState({ status: "connecting", rendererTiming: this.sessionOpenRendererTiming });
    try {
      const result = await this.transport.subscribe({
        topic: this.topic,
        base: snapshot ? { logEpoch: snapshot.logEpoch, seq: snapshot.seq } : undefined,
        ...(options.retryInitialization
          ? { retryInitialization: options.retryInitialization }
          : {}),
      });
      if (generation !== this.generation || this.closed) {
        // 过期代际：这份订阅已无人消费，立即退订。
        logger.lifecycle.warn("v4 conversation store connect ACK became stale", {
          event: "v4.conversation.store.connect.stale_ack",
          generation,
          currentGeneration: this.generation,
          module: "ui.v4.conversation_projection_store",
          status: "failed",
          subscriptionId: result.ack.subscriptionId,
          topic: this.topic,
        });
        void this.transport.unsubscribe(result.ack.subscriptionId);
        return;
      }
      // 线上 fault.subscription.notOwned 卡死的根因：connect() 只在发起时
      // discardRecovery，subscribe ACK 的 await 窗口内旧订阅仍可能创建 same-sub recovery；
      // 而 host scope 在新 ACK remember() 时已按 ownershipKey 静默驱逐旧订阅，该 recovery
      // 的在途 resync 注定被 notOwned 拒绝。换代成功即丢弃旧 recovery——新订阅的 initial
      // 会原子替换整个投影，旧恢复流已无意义；否则其迟到失败会把 live 的新订阅打成 error。
      this.discardRecovery();
      this.runtimeRecycleRetryAttempt = 0;
      this.initialSubscribeAckAt = monotonicNow();
      this.setState({
        status: "live",
        subscriptionId: result.ack.subscriptionId,
        lastError: null,
        openTiming: result.ack.openTiming,
      });
      this.subscriptionHasAppliedBase = Boolean(
        snapshot && result.ack.mode === "resume" && result.ack.logEpoch === snapshot.logEpoch,
      );
      // 公共 result 已是 ACK-only；initial 与 online 统一走 notification。
      // subscriptionId 必须先入 store，activate 才能同步释放同一 read 中暂存的 own initial。
      this.awaitingInitial = {
        subscriptionId: result.ack.subscriptionId,
        mode: result.ack.mode,
      };
      this.transport.activate(result.ack.subscriptionId);
      logger.lifecycle.info("v4 conversation store connect completed", {
        durationMs: roundedDuration(subscribeStartedAt, monotonicNow()),
        event: "v4.conversation.store.connect.completed",
        generation,
        logEpoch: result.ack.logEpoch,
        mode: result.ack.mode,
        module: "ui.v4.conversation_projection_store",
        status: "completed",
        subscriptionId: result.ack.subscriptionId,
        topic: this.topic,
      });
    } catch (error) {
      if (generation !== this.generation || this.closed) return;
      const message = error instanceof Error ? error.message : String(error);
      this.awaitingInitial = null;
      this.subscriptionHasAppliedBase = false;
      if (
        message.includes("fault.subscription.initialFrameStagingOverflow") &&
        !options.initialOverflowRetry
      ) {
        // ACK 前 physical batch 已残缺，active same-sub 尚不存在；只能 fresh
        // subscribe 强制 snapshot。最多自动一次，避免异常 peer 造成重试风暴。
        await this.connect({ forceSnapshot: true, initialOverflowRetry: true });
        return;
      }
      if (this.scheduleRuntimeRecycleRetry(error, generation)) {
        logger.lifecycle.warn("v4 conversation store connect retry scheduled", {
          durationMs: roundedDuration(subscribeStartedAt, monotonicNow()),
          errorMessage: message,
          event: "v4.conversation.store.connect.retry_scheduled",
          generation,
          module: "ui.v4.conversation_projection_store",
          status: "retrying",
          topic: this.topic,
        });
        logger.warn(`[v4-store] subscribe ${this.topic} 被 runtime 换代打断，退避重连: ${message}`);
        return;
      }
      logger.lifecycle.warn("v4 conversation store connect failed", {
        durationMs: roundedDuration(subscribeStartedAt, monotonicNow()),
        errorMessage: message,
        event: "v4.conversation.store.connect.failed",
        generation,
        module: "ui.v4.conversation_projection_store",
        status: "failed",
        topic: this.topic,
      });
      logger.warn(`[v4-store] subscribe ${this.topic} 失败: ${message}`);
      this.setState({ status: "error", lastError: message });
    } finally {
      this.connectInFlight -= 1;
    }
  }

  protected clearRuntimeRecycleRetry(): void {
    if (this.runtimeRecycleRetryTimer === null) return;
    clearTimeout(this.runtimeRecycleRetryTimer);
    this.runtimeRecycleRetryTimer = null;
  }

  /**
   * runtime 换代导致的 subscribe 失败：保持 connecting 并有界退避重连。
   * 返回 true 表示已接管本次失败，调用方不应再落 error。
   */
  private scheduleRuntimeRecycleRetry(error: unknown, generation: number): boolean {
    if (!isRuntimeRecycleError(error)) return false;
    return this.scheduleRuntimeRecycleReconnect(generation);
  }

  /**
   * 有界退避重连。重订阅走 start-if-needed（zcodeAgentService.subscribeConversationV4），
   * 自身即可把懒启动的 runtime 拉起来——这是 available 永不到达时唯一的自愈路径。
   * 返回 true 表示已接管，调用方不应再落 error。
   */
  private scheduleRuntimeRecycleReconnect(generation: number): boolean {
    if (this.closed) return false;
    const delayMs = RUNTIME_RECYCLE_RETRY_DELAYS_MS[this.runtimeRecycleRetryAttempt];
    if (delayMs === undefined) return false;
    this.runtimeRecycleRetryAttempt += 1;
    this.clearRuntimeRecycleRetry();
    // 保留旧 snapshot：换代期间投影未被污染，重连成功会原子替换。
    this.setState({ status: "connecting" });
    this.runtimeRecycleRetryTimer = setTimeout(() => {
      this.runtimeRecycleRetryTimer = null;
      if (this.closed || generation !== this.generation) return;
      void this.connect();
    }, delayMs);
    return true;
  }

  /** workspace-dispose 当场：旧 runtime 已死，新的尚不存在，不可重订阅。 */
  private handleRuntimeUnavailable(): void {
    if (this.closed) return;
    this.clearRuntimeRecycleRetry();
    this.discardRecovery();
    this.awaitingInitial = null;
    this.subscriptionHasAppliedBase = false;
    this.generation += 1;
    // 旧 subscriptionId 属于已死 runtime，不得再 unsubscribe（host 侧 owner 已失效）。
    this.setState({ status: "connecting", subscriptionId: null });
    // 不能只 dormant 等 available：agent 懒启动，dispose 后无人拉起时该信号永不到达，
    // 面板会永久转圈。退避重连自身会拉起 runtime；available 先到则复位计数并即时重连。
    if (this.scheduleRuntimeRecycleReconnect(this.generation)) return;
    // 退避额度耗尽（runtime 反复回收）：必须落 error 暴露「重新连接」入口，
    // 否则 connecting 无 timer 就是永久转圈，连手动重试都没有。
    this.setState({ status: "error", lastError: RUNTIME_RECYCLED_ERROR });
  }

  /** 新 runtime 就绪：与 onRuntimeRestart 同义，携原水位重订阅。 */
  private handleRuntimeAvailable(): void {
    if (this.closed) return;
    this.clearRuntimeRecycleRetry();
    this.runtimeRecycleRetryAttempt = 0;
    if (this.connectInFlight > 0) {
      // 冷启动 spawn 会在首次 subscribe ACK
      // 返回前广播 available。若这里立即再 connect，服务端会按同一 connection/topic
      // 替换旧订阅；旧 ACK 随即被本地代际防护退订，首帧交接存在竞态，面板可能永久无快照。
      // 当前在途 connect 已经负责完成这次启动，不需要重复重订阅。
      return;
    }
    this.handleRuntimeRestart("runtimeRestart");
  }

  /** 订阅失败后的手动重试入口（pane 层「重新连接」按钮落点）。 */
  retry(): Promise<void> {
    this.clearRuntimeRecycleRetry();
    this.runtimeRecycleRetryAttempt = 0;
    const initialization = this.state.snapshot?.runtimeInitialization;
    return this.connect(
      initialization?.status === "failed" ? { retryInitialization: initialization.attemptId } : {},
    );
  }

  /** row command/query 的 epoch/entity authority 失效，复用 same-sub recovery 收敛。 */
  recoverFromStaleAuthority(): void {
    this.requestRecovery();
  }

  /** physical assembly fault：旧 projection 保持可见，active sub 上 single-flight 恢复。 */
  handleAssemblyFault(
    subscriptionId: string,
    deliveryKind?: TopicFrameDeliveryKind,
    reasonCode?: string,
  ): void {
    if (this.closed || subscriptionId !== this.state.subscriptionId) return;
    if (
      this.awaitingInitial?.subscriptionId === subscriptionId &&
      (deliveryKind === "initial" || deliveryKind === "recovery" || deliveryKind === undefined)
    ) {
      this.awaitingInitial = null;
    }
    // 内容确定性失败不进瞬态阶梯（04-sync 封闭规则 11）：resume 只会把同一批 delta 再投一遍，
    // 必然再被拒；deliveryKind 也不改变结论——本端读不懂这份内容。唯一可能产出不同字节的是
    // 强制 snapshot，所以直接跳到它，它再被内容拒绝就停手，不把订阅烧在必然失败的重试上。
    if (isDeterministicContentFault(reasonCode)) {
      this.requestRecovery(true, { contentFault: true });
      return;
    }
    // 缺失/伪 deliveryKind 会以 undefined typed fault 到达；若 recovery 已在途，
    // 必须 fail closed/升级，不能把坏 recovery 当普通 burst 后永远等待。
    const recoveryFault =
      deliveryKind === "recovery" || (deliveryKind === undefined && this.recovery !== null);
    if (deliveryKind === "online" && this.recovery) {
      this.recovery.postRecoveryGapPending ||= this.recovery.validFrameSeen;
      return;
    }
    this.requestRecovery(recoveryFault);
  }

  protected requestRecovery(recoveryEvent = false, options: { contentFault?: boolean } = {}): void {
    if (this.closed) return;
    const subscriptionId = this.state.subscriptionId;
    if (!subscriptionId) {
      void this.connect({ forceSnapshot: true });
      return;
    }
    const contentFault = options.contentFault === true;
    const existing = this.recovery;
    if (existing) {
      // 一旦本次 flight 里出现过内容失败，终态就归内容失败：后续瞬态 fault 不该把它洗白。
      if (contentFault) existing.contentFault = true;
      if (!recoveryEvent) return;
      if (existing.forceSnapshot) {
        this.failRecovery("fault.subscription.recoveryFailed");
        return;
      }
      // recovery logical/fault 可早于 ACK Promise continuation；记住升级意图，
      // ACK=resume 后立即 force snapshot。普通 burst gap 不设置此标记。
      if (existing.requestInFlight || !existing.ackReceived) {
        existing.upgradePending = true;
        return;
      }
      if (existing.ackMode === "resume") this.issueRecovery(existing, true);
      else this.failRecovery("fault.subscription.recoveryFailed");
      return;
    }
    const recovery = {
      subscriptionId,
      requestInFlight: false,
      ackReceived: false,
      validFrameSeen: false,
      upgradePending: false,
      ackMode: null,
      forceSnapshot: false,
      postRecoveryGapPending: false,
      frameDeadline: null,
      contentFault,
    };
    this.recovery = recovery;
    // 内容失败跳过 resume 档直接强制 snapshot；瞬态失败仍按原阶梯先试 resume。
    this.issueRecovery(recovery, contentFault);
  }

  private issueRecovery(recovery: RecoveryFlight, forceSnapshot: boolean): void {
    this.clearRecoveryDeadline(recovery);
    const snapshot = this.state.snapshot;
    const effectiveForceSnapshot = forceSnapshot || !this.subscriptionHasAppliedBase;
    recovery.requestInFlight = true;
    recovery.ackReceived = false;
    recovery.ackMode = null;
    recovery.upgradePending = false;
    recovery.validFrameSeen = false;
    recovery.forceSnapshot = effectiveForceSnapshot;
    recovery.postRecoveryGapPending = false;
    void this.transport
      .resync({
        subscriptionId: recovery.subscriptionId,
        base:
          this.subscriptionHasAppliedBase && snapshot
            ? { logEpoch: snapshot.logEpoch, seq: snapshot.seq }
            : null,
        ...(effectiveForceSnapshot ? { forceSnapshot: true } : {}),
      })
      .then((result) => {
        if (this.closed || this.recovery !== recovery) return;
        if (result.ack.subscriptionId !== recovery.subscriptionId) {
          throw new Error("fault.subscription.resyncGenerationMismatch");
        }
        recovery.requestInFlight = false;
        recovery.ackReceived = true;
        recovery.ackMode = result.ack.mode;
        this.settleRecovery(recovery);
      })
      .catch((error) => {
        if (this.closed || this.recovery !== recovery) return;
        this.clearRecoveryDeadline(recovery);
        this.recovery = null;
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`[v4-store] resync ${this.topic} 失败: ${message}`);
        if (message.includes("fault.subscription.notOwned")) {
          // 线上事件：notOwned 表示某一层已不认这份 subscription
          // ownership（scope 换代静默驱逐、错位 unsubscribe 等状态分歧），是确定性失效
          // 而非瞬态故障；停在 error 等手动重连会让会话永久卡死。本地 snapshot 仍是一致
          // 投影，携当前水位 fresh subscribe 由服务端裁决 resume/snapshot（04-sync 规则 3），
          // 完成自愈。仅对 notOwned 特判，避免瞬态错误引发重连风暴。
          void this.connect();
          return;
        }
        this.setState({ status: "error", lastError: message });
      });
  }

  protected markRecoveryFrameSeen(): void {
    const recovery = this.recovery;
    if (!recovery) return;
    recovery.validFrameSeen = true;
    this.settleRecovery(recovery);
  }

  private settleRecovery(recovery: RecoveryFlight): void {
    if (this.recovery !== recovery || !recovery.ackReceived || recovery.requestInFlight) return;
    if (recovery.upgradePending) {
      this.clearRecoveryDeadline(recovery);
      if (!recovery.forceSnapshot && recovery.ackMode === "resume") {
        this.issueRecovery(recovery, true);
      } else {
        this.failRecovery("fault.subscription.recoveryFailed");
      }
      return;
    }
    if (recovery.validFrameSeen) {
      this.clearRecoveryDeadline(recovery);
      if (recovery.postRecoveryGapPending) {
        this.issueRecovery(recovery, false);
      } else {
        this.recovery = null;
      }
      return;
    }
    if (recovery.frameDeadline) return;
    recovery.frameDeadline = setTimeout(() => {
      recovery.frameDeadline = null;
      if (this.closed || this.recovery !== recovery || recovery.validFrameSeen) return;
      if (!recovery.forceSnapshot) this.issueRecovery(recovery, true);
      else
        this.failRecovery("fault.subscription.recoveryFrameTimedOut", { contentEligible: false });
    }, PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs);
  }

  private clearRecoveryDeadline(recovery: RecoveryFlight): void {
    if (!recovery.frameDeadline) return;
    clearTimeout(recovery.frameDeadline);
    recovery.frameDeadline = null;
  }

  protected discardRecovery(): void {
    if (this.recovery) this.clearRecoveryDeadline(this.recovery);
    this.recovery = null;
  }

  /**
   * `contentEligible: false` 给**超时**终态用：deadline 没等到 recovery 帧是传输症状，即使本次
   * flight 起因是内容失败，也不该被重标成 contentRejected——那会连带取消一次仍然有意义的重试。
   */
  private failRecovery(reasonCode: string, options: { contentEligible?: boolean } = {}): void {
    if (!this.recovery) return;
    // 内容确定性失败与传输失败必须可区分：前者重连不会变好，遥测按 code 聚合时也不该把一次
    // 版本失配读成网络抖动（reasonCode 词表见 wire-fault.ts）。
    const contentFault = this.recovery.contentFault && options.contentEligible !== false;
    const code = contentFault ? SUBSCRIPTION_CONTENT_REJECTED : reasonCode;
    this.discardRecovery();
    logger.warn(`[v4-store] ${this.topic} recovery fail-closed: ${code}`);
    this.setState({ status: "error", lastError: code });
  }

  private handleRuntimeRestart(reason?: "runtimeRestart" | "transportReplaced"): void {
    if (this.closed) return;
    // transport 已先失效旧 ownership/assembler；旧 transport/runtime subId 不得再 unsubscribe，
    // 直接 fresh subscribe，保留旧 snapshot 直到新 snapshot 原子替换。
    this.generation += 1;
    this.discardRecovery();
    this.awaitingInitial = null;
    this.subscriptionHasAppliedBase = false;
    this.setState({ status: "connecting", subscriptionId: null });
    // proxy handoff 不等于 CLI runtime 重启；强制 snapshot 会把用户已加载的
    // older rows 替换回 tail window。handoff 保留一致 projection 水位，由服务端按
    // logEpoch/seq 裁决 resume 或 snapshot；真实 runtime restart 仍保持 full subscribe。
    if (reason === "transportReplaced") void this.connect();
    else void this.connect({ forceSnapshot: true });
  }
}
