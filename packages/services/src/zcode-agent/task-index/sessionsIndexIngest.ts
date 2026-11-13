/**
 * task-index/sessionsIndexIngest.ts: Применение sessions-index кадров — baseline seed,
 * diff по summary, терминальные переходы, заголовки и факты удаления.
 */
import { repairSubagentTaskIndex } from "#src/task-facts/repairSubagentTaskIndex.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { resolveWorkspaceKey } from "@zcode/shared";
import type { SessionsIndexTopicFrame, SessionSummary } from "@zcode/shared/zcode-protocol-v4";
import {
  INITIAL_BASELINE_SEED_BATCH_SIZE,
  isTerminalPhase,
  resolveTerminalUnreadSignal,
  type SessionsIndexIngestHelpers,
  type TaskIndexRuntime,
  type TopicDeliveryKind,
  type WorkspaceIngestState,
} from "./contracts.js";
import type { ZCodeAgentSessionTarget } from "../zcodeAgent.js";

const logger = createServiceLogger("zcode-task-index-syncer");

export function createSessionsIndexIngestHelpers(
  ctx: Pick<
    TaskIndexRuntime,
    | "agentService"
    | "taskIndexRepo"
    | "runtimeState"
    | "taskFacts"
    | "mirrorSummary"
    | "resyncTaskIndexRowFromAgent"
    | "reconcileSnapshotOmissions"
    | "emitWorkspaceTaskListChanged"
    | "emitTerminalAndReady"
    | "sessionTargetFrom"
    | "broadcastTargetFrom"
    | "completeIndexRecoveryFrame"
    | "handleIndexGap"
    | "isLiveState"
  >,
): SessionsIndexIngestHelpers {
  const { agentService, taskIndexRepo, runtimeState, mirrorSummary, isLiveState } = ctx;

  /** phase 终态迁移 → sqlite status 收敛 + 广播 + 回源正文索引。 */
  function applyTerminalTransition(
    target: ZCodeAgentSessionTarget,
    summary: SessionSummary,
    _options?: { captureRepoSnapshot?: boolean },
  ): void {
    ctx.emitTerminalAndReady(target, summary);
    const failed = summary.phase === "error";
    const unreadSignal = resolveTerminalUnreadSignal(summary);
    logger.debug(undefined, "task 终态未读裁决", {
      goalStatus: summary.goalStatus ?? null,
      phase: summary.phase,
      taskId: target.sessionId,
      unreadSignal: unreadSignal ?? null,
    });
    // 活动时间和终态来自 CLI；Host 收帧时间不能把历史任务重新排到顶部。
    void mirrorSummary(target, summary)
      .then((meta) => {
        if (meta) {
          // 之前只更新 sqlite 不广播，UI 监听 workspace_task_list_changed 收不到通知，
          // 导致 spinner 不消失、updatedAt 排序不刷新。补一次广播让列表收敛。
          // 终态收敛是 status 变更，必须用 task_status_changed；
          // 之前落缺省 task_meta_changed，每次 turn 完成都会全局 bump membership
          // 版本号，所有列表实例重拉归属，表现为"任务结束左侧列表闪一下"。
          ctx.emitWorkspaceTaskListChanged(
            ctx.broadcastTargetFrom(target),
            meta,
            "task_status_changed",
            unreadSignal ? { unreadSignal } : undefined,
          );
        }
        // 终态读取完整 snapshot：v4 命令路径（createSession/sendText 走 v4/command）
        // 不经过 zcodeSessionService 的 op 驱动 snapshot 同步，行缺失/正文搜索/lastError
        // 全靠这里收敛；readSession(existing-only) 只读现有 runtime，不重新恢复 session。
        void ctx.resyncTaskIndexRowFromAgent(
          target,
          failed ? "phase.error" : "phase.completed",
          meta || !unreadSignal ? {} : { unreadSignal },
        );
      })
      .catch((error) => {
        logger.warn(
          undefined,
          `同步 v4 phase 终态到 task index 失败 taskId=${target.sessionId}`,
          error,
        );
      });
  }

  /** 标题变化 → sqlite title patch；行缺失回源完整 snapshot（对齐旧 first_input 语义）。 */
  function applyTitleChange(target: ZCodeAgentSessionTarget, summary: SessionSummary): void {
    void mirrorSummary(target, summary)
      .then((meta) => {
        if (meta) {
          // 标题变更（首条消息/自动标题生成）与归属无关且每个任务必发，
          // 用专属 reason，避免每次首发/收口标题落盘都触发全局 membership 重拉。
          ctx.emitWorkspaceTaskListChanged(
            ctx.broadcastTargetFrom(target),
            meta,
            "task_title_changed",
          );
        } else {
          // draft session 不预写占位行；首个标题（旧 first_input）先于任何
          // snapshot upsert 到达时按完整 snapshot 回源，避免依赖空 session 占位行。
          // Bugfix: v4 createSession 不经过 zcodeSessionService.createSession；首个标题到达且
          // task index 尚无行，说明这是新会话首次落库，必须回源写入完整 task 行。
          void ctx.resyncTaskIndexRowFromAgent(target, "meta.titleUpdated", {});
        }
      })
      .catch((error) => {
        logger.warn(
          undefined,
          `同步 v4 标题变更到 task index 失败 taskId=${target.sessionId}`,
          error,
        );
      });
  }

  /** 单条持久化 summary 对基线 diff；terminal 迁移/标题变化各自收敛。 */
  function processSummary(
    state: WorkspaceIngestState,
    previous: SessionSummary | undefined,
    next: SessionSummary,
    _deliveryKind: TopicDeliveryKind,
  ): void {
    state.summaries.set(next.sessionId, next);
    // Bug 根因：CLI 已按 persistence 过滤未提交草稿；已接受输入在初始化期间 phase
    // 仍为 draft。Host 再按执行 phase 过滤，会把新任务推迟到 Hook/TurnStarted 之后。
    const target = ctx.sessionTargetFrom(state.target, next.sessionId);
    const becameVisibleTask = previous === undefined;
    // 终态迁移 = 基线里真实观察到非终态 → 终态。无基线的会话（冷恢复 hydration、
    // 断档降级后新出现的历史会话）不回放终态；活跃会话必先以 running/prewarming
    // 进入基线（gateway 每个事件都 fan-out），不会漏掉真实收口。
    const becameTerminal =
      previous !== undefined && !isTerminalPhase(previous.phase) && isTerminalPhase(next.phase);
    if (becameTerminal) {
      applyTerminalTransition(target, next, {
        // Bug 根因：deliveryKind 只描述传输方式，不能证明完成副作用已经执行。state.summaries
        // 已提供 workspace 生命周期幂等边界；running -> terminal 的 recovery 必须补投。
        captureRepoSnapshot: true,
      });
      return;
    }
    if (becameVisibleTask) {
      // 摘要已足以创建真实行；等待完整正文回源会再次依赖 TurnStarted，且误发 status
      // 无法表达行集合新增。先提交同一 facts 镜像，再广播既有 task_created。
      void mirrorSummary(target, next)
        .then((meta) => {
          if (meta)
            ctx.emitWorkspaceTaskListChanged(ctx.broadcastTargetFrom(target), meta, "task_created");
        })
        .catch((error) => logger.warn(undefined, "同步新会话事实失败", error));
      return;
    }
    const title = next.title.trim();
    if (title && (previous === undefined || previous.title !== next.title)) {
      applyTitleChange(target, next);
    } else {
      void mirrorSummary(target, next).catch((error) =>
        logger.warn(undefined, "同步 CLI 会话事实失败", error),
      );
    }
  }

  async function seedMissingRowsFromInitialSnapshot(
    state: WorkspaceIngestState,
    summaries: Iterable<SessionSummary>,
  ): Promise<void> {
    const candidates = [...summaries];
    if (candidates.length === 0) return;
    // Bugfix：纯 V4 UI 不经过 zcodeSessionService.initializeWorkspace，旧实现又把首帧
    // 当成“已有 sqlite 存量”的静默基线，导致远端新库永远是 0 行。每次基线刷新 CLI
    // 事实，不广播、不回放历史终态，也不覆盖已有产品壳状态；后续打开/
    // 收口时再由完整 snapshot 补 model、正文搜索等权威字段。
    // 防灾保护：历史会话可能很多，不能一次创建等量 Promise 挤占 host 事件循环。
    // 固定小批次写入；失败只汇总一条生产日志，避免逐会话错误再次制造日志风暴。
    let failedCount = 0;
    let firstError: unknown;
    for (let offset = 0; offset < candidates.length; offset += INITIAL_BASELINE_SEED_BATCH_SIZE) {
      const batch = candidates.slice(offset, offset + INITIAL_BASELINE_SEED_BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((summary) => mirrorSummary(state.target, summary)),
      );
      for (const result of results) {
        if (result.status === "rejected") {
          failedCount += 1;
          firstError ??= result.reason;
        }
      }
    }
    if (failedCount > 0) {
      logger.warn(
        undefined,
        `首次 sessions-index 基线补齐 task index 失败 workspace=${resolveWorkspaceKey(state.target)} failed=${failedCount} total=${candidates.length}`,
        firstError,
      );
    }
  }

  function applySessionsIndexFrame(
    state: WorkspaceIngestState,
    frame: SessionsIndexTopicFrame,
    deliveryKind: TopicDeliveryKind,
  ): void {
    if (runtimeState.disposed) return;
    if (deliveryKind === "online" && state.indexRecovery && frame.payload.kind === "deltas") {
      if (state.indexRecovery.frameApplied && frame.toSeq > state.indexSeq) {
        state.indexRecovery.postRecoveryGapPending = true;
      }
      return;
    }
    if (frame.payload.kind === "snapshot") {
      if (deliveryKind === "online" && state.indexHasAppliedBase && frame.toSeq <= state.indexSeq) {
        return;
      }
      state.indexLogEpoch = frame.payload.snapshot.logEpoch;
      state.indexSeq = frame.toSeq;
      state.indexHasAppliedBase = true;
      const nextSummaries = new Map<string, SessionSummary>();
      for (const summary of frame.payload.snapshot.sessions) {
        nextSummaries.set(summary.sessionId, summary);
      }
      if (!state.seeded) {
        // 首帧 = 静默基线：不回放历史终态、不发列表广播；仅原子补齐缺失行，
        // 防止远端/新安装的空 sqlite 因纯 V4 路径永远没有存量。
        state.summaries = nextSummaries;
        state.seeded = true;
        void seedMissingRowsFromInitialSnapshot(state, nextSummaries.values()).then(() =>
          ctx.reconcileSnapshotOmissions(state, frame.toSeq),
        );
        const generation = state.indexSubscriptionGeneration;
        void repairSubagentTaskIndex({
          target: state.target,
          visibleSessionIds: new Set(nextSummaries.keys()),
          agentService,
          taskIndexRepo,
          isCurrent: () => isLiveState(state) && state.indexSubscriptionGeneration === generation,
          onRemoved: () =>
            ctx.emitWorkspaceTaskListChanged(state.target, undefined, "task_meta_changed"),
        }).catch((error) => {
          logger.warn(
            undefined,
            `子代理历史列表索引修复失败 workspace=${resolveWorkspaceKey(state.target)}`,
            error,
          );
        });
        ctx.completeIndexRecoveryFrame(state, deliveryKind);
        return;
      }
      // 断档降级 snapshot：对基线 diff 后处理，等价于补投丢失的 deltas（conflated 语义）。
      const previousSummaries = state.summaries;
      state.summaries = new Map();
      for (const summary of nextSummaries.values()) {
        processSummary(state, previousSummaries.get(summary.sessionId), summary, deliveryKind);
      }
      void ctx.reconcileSnapshotOmissions(state, frame.toSeq);
      ctx.completeIndexRecoveryFrame(state, deliveryKind);
      return;
    }
    if (!state.indexHasAppliedBase) {
      // fresh task-index subscribe 从不携带 base；initial 整批丢失后任何 delta 都不能
      // 建立 cold baseline。只有 owned snapshot 可证明完整状态。
      ctx.handleIndexGap(state, deliveryKind === "recovery" ? "recovery" : "online");
      return;
    }
    if (frame.toSeq <= state.indexSeq) {
      // 任一完整校验的 recovery 若已被更晚权威 snapshot/online 覆盖，都可确认
      // delivery 成功；普通重复帧仍静默丢弃。
      if (deliveryKind === "recovery" && state.indexHasAppliedBase) {
        ctx.completeIndexRecoveryFrame(state, deliveryKind);
      }
      return;
    }
    if (frame.fromSeq !== state.indexSeq) {
      ctx.handleIndexGap(state, deliveryKind);
      return;
    }
    for (const delta of frame.payload.deltas) {
      if (delta.op === "session.upserted") {
        processSummary(
          state,
          state.summaries.get(delta.session.sessionId),
          delta.session,
          deliveryKind,
        );
        continue;
      }
      // 只有 CLI 明确删除事件才写删除事实；snapshot 缺席不能据此删除任务。
      state.summaries.delete(delta.sessionId);
      const target = ctx.sessionTargetFrom(state.target, delta.sessionId);
      void ctx.taskFacts
        .removed({
          workspacePath: target.workspacePath,
          workspaceIdentity: target.workspaceIdentity,
          taskId: delta.sessionId,
        })
        .catch((error) => logger.warn(undefined, "同步 CLI 删除事实失败", error));
    }
    state.indexSeq = frame.toSeq;
    state.indexHasAppliedBase = true;
    ctx.completeIndexRecoveryFrame(state, deliveryKind);
  }

  return {
    applySessionsIndexFrame,
    processSummary,
    applyTerminalTransition,
    applyTitleChange,
    seedMissingRowsFromInitialSnapshot,
  };
}
