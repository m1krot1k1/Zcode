/**
 * task-index/topicSubscribe.ts: Subscribe/activate и topic-local retry для
 * sessions-index и workspace-config. Поколения topics независимы.
 */
import { resolveWorkspaceKey } from "@zcode/shared";
import type {
  V4SessionsIndexSubscribeResult,
  V4WorkspaceConfigSubscribeResult,
} from "@zcode/shared/zcode-protocol-v4";
import {
  PROVIDER_NOT_READY_RETRY_MS,
  TASK_INDEX_SUBSCRIBER_SCOPE,
  type PendingTopicFrames,
  type TaskIndexRuntime,
  type TopicRetryKind,
  type TopicSubscribeHelpers,
  type TopicSubscribeReason,
  type WorkspaceIngestState,
} from "./contracts.js";
import type {
  SessionsIndexTopicWireCandidate,
  WorkspaceConfigTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";

export function createTopicSubscribeHelpers(
  ctx: Pick<
    TaskIndexRuntime,
    | "agentService"
    | "workspaceIngests"
    | "runtimeState"
    | "isLiveState"
    | "discardIndexRecovery"
    | "discardConfigRecovery"
    | "clearIndexPendingState"
    | "clearConfigPendingState"
    | "unsubscribeIndex"
    | "unsubscribeConfig"
    | "handleSessionsIndexWire"
    | "handleWorkspaceConfigWire"
    | "logTopicSubscribeFailure"
    | "isRuntimeUnavailableError"
    | "isProviderNotReadyError"
    | "createPendingFrames"
    | "discardPendingFrames"
  >,
): TopicSubscribeHelpers {
  const { agentService, workspaceIngests, runtimeState, isLiveState } = ctx;

  async function activateIndexSubscribe(
    state: WorkspaceIngestState,
    generation: number,
    pending: PendingTopicFrames<SessionsIndexTopicWireCandidate>,
    result: V4SessionsIndexSubscribeResult,
  ): Promise<void> {
    const stale =
      runtimeState.disposed ||
      generation !== state.indexSubscriptionGeneration ||
      pending.generation !== generation ||
      workspaceIngests.get(resolveWorkspaceKey(state.target)) !== state;
    if (stale) {
      ctx.discardPendingFrames(pending);
      // runtime 换代可能复用 subscriptionId；迟到旧 ACK 不能
      // 反向退订已由新代接管的同 id route。
      if (state.indexSubscriptionId !== result.ack.subscriptionId) {
        await ctx.unsubscribeIndex(state, result.ack.subscriptionId);
      }
      return;
    }
    if (state.indexPending === pending) state.indexPending = null;
    if (pending.recoveryNeeded) {
      ctx.discardPendingFrames(pending);
      await ctx.unsubscribeIndex(state, result.ack.subscriptionId);
      if (generation === state.indexSubscriptionGeneration && isLiveState(state)) {
        void subscribeIndexTopic(state, "pre-ack-overflow", false);
      }
      return;
    }
    state.indexSubscriptionId = result.ack.subscriptionId;
    state.indexLogEpoch = result.ack.logEpoch;
    state.indexSeq = 0;
    // subscribe ACK 的 epoch/seq0 只是 admission metadata；initial physical
    // frame 可能尚未齐片或校验失败。只有 logical snapshot/delta 原子 apply 后才有 base。
    state.indexHasAppliedBase = false;
    ctx.discardIndexRecovery(state);
    state.indexRetryAttempt = 0;
    state.indexLastWarnAt = null;
    const frames = pending.recoveryNeeded ? [] : [...pending.frames];
    ctx.discardPendingFrames(pending);
    for (const frame of frames) {
      if (frame.subscriptionId === result.ack.subscriptionId) {
        ctx.handleSessionsIndexWire(state, frame);
      }
    }
  }

  async function activateConfigSubscribe(
    state: WorkspaceIngestState,
    generation: number,
    pending: PendingTopicFrames<WorkspaceConfigTopicWireCandidate>,
    result: V4WorkspaceConfigSubscribeResult,
  ): Promise<void> {
    const stale =
      runtimeState.disposed ||
      generation !== state.configSubscriptionGeneration ||
      pending.generation !== generation ||
      workspaceIngests.get(resolveWorkspaceKey(state.target)) !== state;
    if (stale) {
      ctx.discardPendingFrames(pending);
      if (state.configSubscriptionId !== result.ack.subscriptionId) {
        await ctx.unsubscribeConfig(state, result.ack.subscriptionId);
      }
      return;
    }
    if (state.configPending === pending) state.configPending = null;
    if (pending.recoveryNeeded) {
      ctx.discardPendingFrames(pending);
      await ctx.unsubscribeConfig(state, result.ack.subscriptionId);
      if (generation === state.configSubscriptionGeneration && isLiveState(state)) {
        void subscribeConfigTopic(state, "pre-ack-overflow", false);
      }
      return;
    }
    state.configSubscriptionId = result.ack.subscriptionId;
    state.configLogEpoch = result.ack.logEpoch;
    state.configSeq = 0;
    state.configHasAppliedBase = false;
    ctx.discardConfigRecovery(state);
    state.configRetryAttempt = 0;
    state.configLastWarnAt = null;
    const frames = pending.recoveryNeeded ? [] : [...pending.frames];
    ctx.discardPendingFrames(pending);
    for (const frame of frames) {
      if (frame.subscriptionId === result.ack.subscriptionId) {
        ctx.handleWorkspaceConfigWire(state, frame);
      }
    }
  }

  function scheduleIndexRetry(state: WorkspaceIngestState, retryKind: TopicRetryKind): void {
    if (!isLiveState(state) || state.indexRetryTimer) return;
    const delay =
      retryKind === "provider-not-ready"
        ? PROVIDER_NOT_READY_RETRY_MS
        : Math.min(1_000, 25 * 2 ** Math.min(state.indexRetryAttempt, 5));
    state.indexRetryAttempt += 1;
    const timer = setTimeout(() => {
      state.indexRetryTimer = null;
      if (isLiveState(state)) {
        void subscribeIndexTopic(
          state,
          retryKind === "provider-not-ready" ? "provider-not-ready-wait" : "retry",
          false,
        );
      }
    }, delay);
    timer.unref?.();
    state.indexRetryTimer = timer;
  }

  function scheduleConfigRetry(state: WorkspaceIngestState, retryKind: TopicRetryKind): void {
    if (!isLiveState(state) || state.configRetryTimer) return;
    const delay =
      retryKind === "provider-not-ready"
        ? PROVIDER_NOT_READY_RETRY_MS
        : Math.min(1_000, 25 * 2 ** Math.min(state.configRetryAttempt, 5));
    state.configRetryAttempt += 1;
    const timer = setTimeout(() => {
      state.configRetryTimer = null;
      if (isLiveState(state)) {
        void subscribeConfigTopic(
          state,
          retryKind === "provider-not-ready" ? "provider-not-ready-wait" : "retry",
          false,
        );
      }
    }, delay);
    timer.unref?.();
    state.configRetryTimer = timer;
  }

  async function subscribeIndexTopic(
    state: WorkspaceIngestState,
    reason: TopicSubscribeReason,
    unsubscribeActive: boolean,
  ): Promise<void> {
    if (!isLiveState(state)) return;
    if (state.indexRetryTimer) clearTimeout(state.indexRetryTimer);
    state.indexRetryTimer = null;
    const generation = ++state.indexSubscriptionGeneration;
    const previousSubscriptionId = state.indexSubscriptionId;
    state.indexSubscriptionId = null;
    ctx.discardIndexRecovery(state);
    ctx.clearIndexPendingState(state);
    if (unsubscribeActive && previousSubscriptionId) {
      await ctx.unsubscribeIndex(state, previousSubscriptionId);
      if (!isLiveState(state) || generation !== state.indexSubscriptionGeneration) return;
    }
    const indexPending = ctx.createPendingFrames<SessionsIndexTopicWireCandidate>(generation);
    state.indexPending = indexPending;
    try {
      const result = await agentService.subscribeSessionsIndexV4({
        ...state.target,
        visibility: "background",
        subscriberScope: TASK_INDEX_SUBSCRIBER_SCOPE,
        runtimePolicy: "existing-only",
      });
      await activateIndexSubscribe(state, generation, indexPending, result);
    } catch (error) {
      if (isLiveState(state) && state.indexSubscriptionGeneration === generation) {
        ctx.clearIndexPendingState(state);
        if (ctx.isRuntimeUnavailableError(error)) {
          state.runtimeGeneration = null;
          return;
        }
        const retryKind = ctx.isProviderNotReadyError(error) ? "provider-not-ready" : "transient";
        ctx.logTopicSubscribeFailure(state, "sessions-index", reason, error, retryKind);
        scheduleIndexRetry(state, retryKind);
      }
    }
  }

  async function subscribeConfigTopic(
    state: WorkspaceIngestState,
    reason: TopicSubscribeReason,
    unsubscribeActive: boolean,
  ): Promise<void> {
    if (!isLiveState(state)) return;
    if (state.configRetryTimer) clearTimeout(state.configRetryTimer);
    state.configRetryTimer = null;
    const generation = ++state.configSubscriptionGeneration;
    const previousSubscriptionId = state.configSubscriptionId;
    state.configSubscriptionId = null;
    ctx.discardConfigRecovery(state);
    ctx.clearConfigPendingState(state);
    if (unsubscribeActive && previousSubscriptionId) {
      await ctx.unsubscribeConfig(state, previousSubscriptionId);
      if (!isLiveState(state) || generation !== state.configSubscriptionGeneration) return;
    }
    const configPending = ctx.createPendingFrames<WorkspaceConfigTopicWireCandidate>(generation);
    state.configPending = configPending;
    try {
      const result = await agentService.subscribeWorkspaceConfigV4({
        ...state.target,
        visibility: "background",
        subscriberScope: TASK_INDEX_SUBSCRIBER_SCOPE,
        runtimePolicy: "existing-only",
      });
      await activateConfigSubscribe(state, generation, configPending, result);
    } catch (error) {
      if (isLiveState(state) && state.configSubscriptionGeneration === generation) {
        ctx.clearConfigPendingState(state);
        if (ctx.isRuntimeUnavailableError(error)) {
          state.runtimeGeneration = null;
          return;
        }
        const retryKind = ctx.isProviderNotReadyError(error) ? "provider-not-ready" : "transient";
        ctx.logTopicSubscribeFailure(state, "workspace-config", reason, error, retryKind);
        scheduleConfigRetry(state, retryKind);
      }
    }
  }

  return {
    subscribeIndexTopic,
    subscribeConfigTopic,
    activateIndexSubscribe,
    activateConfigSubscribe,
    scheduleIndexRetry,
    scheduleConfigRetry,
  };
}
