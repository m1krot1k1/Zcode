import {
  applyConversationDeltas,
  type ConversationDelta,
  type ConversationRow,
  type ConversationSnapshot,
  type ConversationTopicFrame,
  type SessionModelTransition,
  type TopicFrameDeliveryKind,
} from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import { ConversationProjectionConnection } from "./connection.js";
import {
  logSubagentProjectionTransition,
  monotonicNow,
  roundedDuration,
  shouldInvalidatePlanDirectory,
  shouldInvalidateTurnNavigatorDirectory,
} from "./guards.js";

/**
 * 帧应用层：把订阅推送（snapshot/delta）落到唯一的 projection state 上。
 * 不持有独立状态，只读写 Connection 层的 `state` 与恢复状态机。
 */
export abstract class ConversationProjectionFrames extends ConversationProjectionConnection {
  /** live-only 增量（插件资源通知）的旁路监听；只在 delta 帧应用后触发，快照帧不触发。 */
  private readonly liveDeltaListeners = new Set<(deltas: readonly ConversationDelta[]) => void>();
  protected readonly modelTransitionListeners = new Set<
    (transition: SessionModelTransition) => void
  >();
  private observedModelTransitionEventId: string | null = null;

  /**
   * 订阅每一帧应用后的增量列表。用途是 live-only 的 `pluginUi.*` 增量（它们不改行、不进快照），
   * 常规行状态仍以 subscribe + getState 为准。
   */
  onLiveDeltas(listener: (deltas: readonly ConversationDelta[]) => void): () => void {
    this.liveDeltaListeners.add(listener);
    return () => this.liveDeltaListeners.delete(listener);
  }

  onOnlineModelTransition(listener: (transition: SessionModelTransition) => void): () => void {
    this.modelTransitionListeners.add(listener);
    return () => this.modelTransitionListeners.delete(listener);
  }

  /** optimistic overlay 与投影对齐；由 store 层实现，帧应用只负责按顺序调用。 */
  protected abstract reconcileOptimistic(snapshot: ConversationSnapshot): void;
  protected abstract reconcileAcceptedInputProjection(snapshot: ConversationSnapshot): void;

  /** SessionDataLayer 帧路由入口。 */
  handleFrame(
    frame: ConversationTopicFrame,
    delivery?: { deliveryKind: TopicFrameDeliveryKind },
  ): void {
    if (this.closed) return;
    // 代际防护：旧订阅的迟到帧直接丢弃。
    if (frame.subscriptionId !== this.state.subscriptionId) return;
    const awaitingInitial =
      this.awaitingInitial?.subscriptionId === frame.subscriptionId ? this.awaitingInitial : null;
    const deliveryKind = delivery?.deliveryKind ?? "online";
    const frameReceivedAt = monotonicNow();
    // RPC 时序无法证明帧用途。只有 publisher 标记的 initial 才消费
    // awaitingInitial；recovery 必须优先清除此状态，避免 recovery gap 被误判为
    // original subscribe gap 而换新 subId。迟到 online duplicate 不得消费任何闸门。
    const initial = deliveryKind === "initial" ? awaitingInitial : null;
    if (initial || (deliveryKind === "recovery" && awaitingInitial)) {
      this.awaitingInitial = null;
    }
    if (deliveryKind === "online" && this.recovery && frame.payload.kind === "snapshot") {
      // online overflow snapshot 本身是完整权威状态，可建立 applied base；但它不冒充
      // recovery delivery，flight 仍等待自己的 recovery frame/ACK 收口。
      this.applyFrame(frame, { subscribeMode: null, recovery: false, online: true });
      return;
    }
    if (deliveryKind === "online" && this.recovery) {
      // recovery reservation 之后的 online 可能与 ACK 同 read 到达；在 recovery
      // logical frame 已 apply 后看到非重复 online，ACK 收口时必须再开 successor flight。
      if (frame.toSeq > (this.state.snapshot?.seq ?? 0)) {
        this.recovery.postRecoveryGapPending ||= this.recovery.validFrameSeen;
      }
      return;
    }
    if (frame.payload.kind === "deltas" && !this.subscriptionHasAppliedBase) {
      // ACK(snapshot) 不构成 applied base；initial 丢失后即便数值 fromSeq 恰好
      // 对上旧 projection，也不能把新 epoch delta 拼到旧状态。
      this.requestRecovery(deliveryKind === "recovery");
      return;
    }
    this.applyFrame(frame, {
      subscribeMode: initial?.mode ?? null,
      recovery: deliveryKind === "recovery",
      online: deliveryKind === "online",
      frameReceivedAt,
    });
  }

  private applyFrame(
    frame: ConversationTopicFrame,
    context: {
      subscribeMode: "snapshot" | "resume" | null;
      recovery: boolean;
      online: boolean;
      frameReceivedAt?: number;
    },
  ): void {
    if (frame.payload.kind === "snapshot") {
      const hadAppliedBase = this.subscriptionHasAppliedBase;
      const snapshot = this.shareSnapshotRows(frame.payload.snapshot);
      logSubagentProjectionTransition(this.topic, this.state.snapshot, snapshot, "snapshot");
      // 规则 1：整体替换，扔掉手里的一切换新的（行对象按值复用旧引用，语义仍是整体替换）。
      this.setState({
        snapshot,
        planDirectoryRevision: this.state.planDirectoryRevision + 1,
        // snapshot 整体替换后 real-user query 集合可能已变，终态缓存必须失效。
        turnNavigatorDirectoryRevision: this.state.turnNavigatorDirectoryRevision + 1,
      });
      this.subscriptionHasAppliedBase = true;
      this.reconcileOptimistic(snapshot);
      this.reconcileAcceptedInputProjection(snapshot);
      // Bug 原因：initial 丢失时，publisher 允许完整 online snapshot 建立首个
      // applied base；其中的持久 transition 可能早于本次订阅，不能冒充实时新事件。
      // 首帧只播种观察基线，后续 online 跃迁才通知 pane。
      this.observeModelTransition(snapshot, context.online && hadAppliedBase);
      if (context.subscribeMode !== null && context.frameReceivedAt !== undefined) {
        const snapshotAppliedAt = monotonicNow();
        this.sessionOpenRendererTiming = {
          ...this.sessionOpenRendererTiming,
          ...(this.initialSubscribeAckAt === null
            ? {}
            : {
                initialFrameTransportMs: roundedDuration(
                  this.initialSubscribeAckAt,
                  context.frameReceivedAt,
                ),
              }),
          rendererSnapshotApplyMs: roundedDuration(context.frameReceivedAt, snapshotAppliedAt),
          snapshotAppliedAt,
        };
        this.setState({ rendererTiming: this.sessionOpenRendererTiming });
      }
      if (context.recovery) this.markRecoveryFrameSeen();
      return;
    }
    const current = this.state.snapshot;
    // 规则 2a：迟到/重复 logical frame 永远静默丢弃。若它是 ACK 后的 aligned
    // recovery `(N,N]`，则只收口 flight，不重复 apply。
    if (current && frame.toSeq <= current.seq) {
      if (context.recovery) this.markRecoveryFrameSeen();
      return;
    }
    if (!current || frame.fromSeq !== current.seq) {
      // 规则 2：断档不猜。状态本身仍是 seq=current.seq 时刻的一致投影（这帧没碰它），
      // 所以 base 仍合法——重订阅让服务端裁决续传或全量；若断档发生在 subscribe 的
      // resume 续传帧上（服务端已裁决过一次仍不衔接），丢 base 强制 snapshot 防循环。
      logger.warn(
        `[v4-store] ${this.topic} 帧断档 fromSeq=${frame.fromSeq} local=${current?.seq ?? "none"}，重订阅`,
      );
      if (context.subscribeMode !== null) {
        // fresh subscribe 的 resume initial 仍断档，换代订阅强制 snapshot；active
        // subscription 的 online/recovery gap 则保持 same-sub。
        void this.connect({ forceSnapshot: true });
      } else {
        this.requestRecovery(context.recovery);
      }
      return;
    }
    const applied = applyConversationDeltas(current, frame.payload.deltas);
    // seq 是快照对齐水位（R-03），delta 帧应用完推进到帧右端点。
    const next = this.shareDeltaRows({ ...applied, seq: frame.toSeq }, frame.payload.deltas);
    logSubagentProjectionTransition(this.topic, current, next, "deltas");
    const removedFromRowId = frame.payload.deltas.reduce<number | null>(
      (earliest, delta) =>
        delta.op === "row.removed"
          ? Math.min(earliest ?? delta.fromRowId, delta.fromRowId)
          : earliest,
      null,
    );
    this.setState({
      snapshot: next,
      // row.removed 已给出权威裁剪边界，可以同步删掉缓存目录中的旧分支计划；
      // 完整 query 继续负责补回 wire tail 之外、但仍属于当前分支的早期计划。
      ...(removedFromRowId === null
        ? {}
        : {
            sessionPlans: this.state.sessionPlans.filter((row) => row.rowId < removedFromRowId),
          }),
      ...(shouldInvalidatePlanDirectory(frame)
        ? { planDirectoryRevision: this.state.planDirectoryRevision + 1 }
        : {}),
      // real-user query 增删（row.appended/row.upserted 命中 realUser userInput，
      // 或 row.removed 截断分支）递增导航目录 revision，使终态缓存失效允许重新探测。
      ...(shouldInvalidateTurnNavigatorDirectory(frame)
        ? {
            turnNavigatorDirectoryRevision: this.state.turnNavigatorDirectoryRevision + 1,
          }
        : {}),
    });
    this.subscriptionHasAppliedBase = true;
    this.reconcileOptimistic(next);
    this.reconcileAcceptedInputProjection(next);
    this.observeModelTransition(next, context.online);
    if (context.recovery) this.markRecoveryFrameSeen();
    for (const listener of this.liveDeltaListeners) listener(frame.payload.deltas);
  }

  /**
   * Bug 原因：整份 snapshot 的行全是新反序列化对象，历史 snapshot 被闭包链留住时每份各持
   * 一套大字符串（同一 inputText 上百份）。这里把值相等的行 / 子值换回池中旧引用。
   */
  /** rows/range 补拉的历史行与池中仍存活的旧行共享（冷打开后往上翻时常见）。 */
  protected shareRows(rows: readonly ConversationRow[]): ConversationRow[] {
    return rows.map((row) => this.rowPool.shareRow(this.topic, row));
  }

  private shareSnapshotRows(snapshot: ConversationSnapshot): ConversationSnapshot {
    const window = this.rowPool.shareWindow(
      this.topic,
      snapshot.rows.window,
      this.state.snapshot?.rows.window,
    );
    return window === snapshot.rows.window
      ? snapshot
      : { ...snapshot, rows: { ...snapshot.rows, window } };
  }

  /** row.upserted / row.appended 的新行做共享；row.delta 只登记，避免流式逐帧深比较。 */
  private shareDeltaRows(
    snapshot: ConversationSnapshot,
    deltas: readonly ConversationDelta[],
  ): ConversationSnapshot {
    const shareIds = new Set<number>();
    const rememberIds = new Set<number>();
    for (const delta of deltas) {
      if (delta.op === "row.upserted" || delta.op === "row.appended") shareIds.add(delta.row.rowId);
      else if (delta.op === "row.delta") rememberIds.add(delta.rowId);
    }
    if (shareIds.size === 0 && rememberIds.size === 0) return snapshot;
    let window: ConversationRow[] | null = null;
    snapshot.rows.window.forEach((row, index) => {
      if (shareIds.has(row.rowId)) {
        const shared = this.rowPool.shareRow(this.topic, row);
        if (shared !== row) {
          window ??= [...snapshot.rows.window];
          window[index] = shared;
        }
      } else if (rememberIds.has(row.rowId)) {
        this.rowPool.remember(this.topic, row);
      }
    });
    return window === null ? snapshot : { ...snapshot, rows: { ...snapshot.rows, window } };
  }

  private observeModelTransition(snapshot: ConversationSnapshot, online: boolean): void {
    const transition = snapshot.modelTransition;
    const eventId = transition?.eventId ?? null;
    if (eventId === this.observedModelTransitionEventId) return;
    // 持久 transition 会随 initial/recovery snapshot 重放；若只在 toast 时记 ID，
    // 后续普通 online snapshot 会把旧 fallback 误当新事件。所有合法帧都更新观察基线，
    // 只有首次实时 online 跃迁才通知当前客户端。
    this.observedModelTransitionEventId = eventId;
    if (!online || !transition) return;
    for (const listener of this.modelTransitionListeners) listener(transition);
  }
}
