// 队列自动放行域：队首 auto-drain 的 gate、busy 时退避重试，以及失败后的暂停。
// 只读取投影 queueItem 与 record 的 active 锁；不持有其它桥状态。
import type { GoalStatus } from "@zcode/contracts";
import { shouldAutoDrainV4QueueHead } from "../zcode-protocol-v4/queue-auto-drain.js";
import { V4QueuePromotionLeaseUnavailableError } from "../zcode-protocol-v4/commands/handlers/queue.js";
import type { ZCodeProtocolSessionRecord } from "./server-types.js";
import type { BridgeState } from "./v4-bridge-state.js";

export const autoDrainV4QueueIfReady = async (
  state: BridgeState,
  record: ZCodeProtocolSessionRecord,
): Promise<void> => {
  const { context } = state;
  const head = context.v4Gateway?.getQueueHead(record.app.sessionId);
  if (!head) {
    // 外层恢复 FIFO 已消费到空；guide 仍只由 core tool-batch 边界行内消费。
    record.app.completeExternalQueueDrain();
    return;
  }
  const coreForegroundBusy = record.app.runtime.getActiveForegroundExecutionId() !== undefined;
  if (
    head.autoDrain &&
    head.dispatchState === "queued" &&
    (record.activeAbortController !== undefined || coreForegroundBusy)
  ) {
    // Bootstrap controller 不覆盖 model-only notification；旧 auto-drain
    // 只看外层锁，因而把“空闲后消费”错误执行成抢占。busy 时不碰 reservation。
    scheduleAutoDrainRetry(state, record);
    return;
  }
  let targetStatus: GoalStatus | null = null;
  if (head.autoDrain && head.dispatchState === "queued" && !record.activeAbortController) {
    try {
      targetStatus = (await record.app.readTarget())?.status ?? null;
    } catch (error) {
      // target 读取失败时按“未知且未完成”处理；直接提升会让
      // goal verification 的持久终态尚未可证时普通 queue 偷跑。
      context.logger?.warn("v4 auto-drain held because target state could not be read", {
        error: error instanceof Error ? error.message : String(error),
        queueItemId: head.queueItemId,
        sessionId: record.app.sessionId,
      });
      return;
    }
  }
  if (
    !shouldAutoDrainV4QueueHead({
      autoDrain: head.autoDrain,
      dispatchState: head.dispatchState,
      kind: head.kind,
      sessionBusy: Boolean(record.activeAbortController) || coreForegroundBusy,
      targetStatus,
    })
  ) {
    return;
  }
  // 暂停队列恢复后，旧项只存在于投影而不在新 activeTurn 内存中；普通文本也必须
  // 和 typed /goal、/compact 一样走完整投影的队首，避免新输入越过旧暂停项。
  try {
    await state.nativeExecutor!.execute(
      {
        baseRevision: 0,
        clientId: "v4-auto-drain",
        commandId: `auto-${head.kind}-${Date.now()}-${head.queueItemId}`,
        issuedAt: Date.now(),
        payload: { queueItemId: head.queueItemId },
        sessionId: record.app.sessionId,
        type: "sendQueuedNow",
      },
      undefined,
      { autoDrainPromotion: true },
    );
  } catch (error) {
    if (error instanceof V4QueuePromotionLeaseUnavailableError) {
      // precheck 与 handler 之间可能新入队 notification；idle-only 是最终原子判据。
      scheduleAutoDrainRetry(state, record);
      return;
    }
    // 自动提升失败不能继续越过该 FIFO barrier；重新暂停并保留原项，交用户重试。
    await record.app.setQueueAutoDrain(false);
    context.logger?.warn("v4 auto-drain failed and queue was paused", {
      error: error instanceof Error ? error.message : String(error),
      queueItemId: head.queueItemId,
      sessionId: record.app.sessionId,
    });
  }
};
export const scheduleAutoDrainRetry = (
  state: BridgeState,
  record: ZCodeProtocolSessionRecord,
): void => {
  const { context, autoDrainRetryTimers } = state;
  const sessionId = record.app.sessionId;
  if (autoDrainRetryTimers.has(sessionId)) return;
  const timer = setTimeout(() => {
    autoDrainRetryTimers.delete(sessionId);
    if (context.sessions.get(sessionId) !== record) return;
    void autoDrainV4QueueIfReady(state, record).catch((error: unknown) => {
      context.logger?.warn("v4 auto-drain idle reevaluation failed", {
        error: error instanceof Error ? error.message : String(error),
        sessionId,
      });
    });
  }, 100);
  timer.unref?.();
  autoDrainRetryTimers.set(sessionId, timer);
};
