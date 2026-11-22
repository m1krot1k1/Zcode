/**
 * task-index/topicRecovery.ts: Recovery flight для одного topic (resync → ack → frame deadline)
 * и gap escalation. Каждый topic ведёт независимый flight, sibling продолжает жить.
 */
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  type TaskIndexRuntime,
  type TopicDeliveryKind,
  type TopicRecoveryHelpers,
  type TopicRecoveryState,
  type WorkspaceIngestState,
} from "./contracts.js";

const logger = createServiceLogger("zcode-task-index-syncer");

export function createTopicRecoveryHelpers(
  ctx: Pick<
    TaskIndexRuntime,
    "agentService" | "isLiveState" | "subscribeIndexTopic" | "subscribeConfigTopic"
  >,
): TopicRecoveryHelpers {
  const { agentService, isLiveState } = ctx;

  function clearRecoveryDeadline(recovery: TopicRecoveryState | null): void {
    if (!recovery?.frameDeadline) return;
    clearTimeout(recovery.frameDeadline);
    recovery.frameDeadline = null;
  }

  function discardIndexRecovery(state: WorkspaceIngestState): void {
    clearRecoveryDeadline(state.indexRecovery);
    state.indexRecovery = null;
  }

  function discardConfigRecovery(state: WorkspaceIngestState): void {
    clearRecoveryDeadline(state.configRecovery);
    state.configRecovery = null;
  }

  function settleIndexRecovery(state: WorkspaceIngestState, recovery: TopicRecoveryState): void {
    if (state.indexRecovery !== recovery || !recovery.ackReceived) return;
    if (recovery.upgradeToSnapshot) {
      discardIndexRecovery(state);
      if (recovery.forceSnapshot)
        void ctx.subscribeIndexTopic(state, "snapshot-recovery-gap", true);
      else requestIndexRecovery(state, true);
      return;
    }
    if (recovery.frameApplied) {
      const followup = recovery.postRecoveryGapPending;
      discardIndexRecovery(state);
      if (followup) requestIndexRecovery(state, false);
      return;
    }
    if (recovery.frameDeadline) return;
    recovery.frameDeadline = setTimeout(() => {
      recovery.frameDeadline = null;
      if (!isLiveState(state) || state.indexRecovery !== recovery || recovery.frameApplied) return;
      discardIndexRecovery(state);
      if (!recovery.forceSnapshot) requestIndexRecovery(state, true);
      else void ctx.subscribeIndexTopic(state, "recovery-frame-timeout", true);
    }, PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs);
    recovery.frameDeadline.unref?.();
  }

  function settleConfigRecovery(state: WorkspaceIngestState, recovery: TopicRecoveryState): void {
    if (state.configRecovery !== recovery || !recovery.ackReceived) return;
    if (recovery.upgradeToSnapshot) {
      discardConfigRecovery(state);
      if (recovery.forceSnapshot)
        void ctx.subscribeConfigTopic(state, "snapshot-recovery-gap", true);
      else requestConfigRecovery(state, true);
      return;
    }
    if (recovery.frameApplied) {
      const followup = recovery.postRecoveryGapPending;
      discardConfigRecovery(state);
      if (followup) requestConfigRecovery(state, false);
      return;
    }
    if (recovery.frameDeadline) return;
    recovery.frameDeadline = setTimeout(() => {
      recovery.frameDeadline = null;
      if (!isLiveState(state) || state.configRecovery !== recovery || recovery.frameApplied) return;
      discardConfigRecovery(state);
      if (!recovery.forceSnapshot) requestConfigRecovery(state, true);
      else void ctx.subscribeConfigTopic(state, "recovery-frame-timeout", true);
    }, PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs);
    recovery.frameDeadline.unref?.();
  }

  function completeIndexRecoveryFrame(
    state: WorkspaceIngestState,
    deliveryKind: TopicDeliveryKind,
  ): void {
    if (deliveryKind !== "recovery" || !state.indexRecovery) return;
    state.indexRecovery.frameApplied = true;
    settleIndexRecovery(state, state.indexRecovery);
  }

  function completeConfigRecoveryFrame(
    state: WorkspaceIngestState,
    deliveryKind: TopicDeliveryKind,
  ): void {
    if (deliveryKind !== "recovery" || !state.configRecovery) return;
    state.configRecovery.frameApplied = true;
    settleConfigRecovery(state, state.configRecovery);
  }

  function requestIndexRecovery(state: WorkspaceIngestState, forceSnapshot = false): void {
    const subscriptionId = state.indexSubscriptionId;
    if (!subscriptionId || !isLiveState(state)) return;
    const active = state.indexRecovery;
    if (active) {
      if (forceSnapshot && !active.forceSnapshot) {
        active.upgradeToSnapshot = true;
        settleIndexRecovery(state, active);
      }
      return;
    }
    const effectiveForceSnapshot =
      forceSnapshot || !state.indexHasAppliedBase || state.indexLogEpoch === null;
    const recovery: TopicRecoveryState = {
      generation: ++state.indexRecoveryGeneration,
      subscriptionId,
      forceSnapshot: effectiveForceSnapshot,
      ackReceived: false,
      frameApplied: false,
      upgradeToSnapshot: false,
      postRecoveryGapPending: false,
      frameDeadline: null,
    };
    state.indexRecovery = recovery;
    const base = effectiveForceSnapshot
      ? null
      : { logEpoch: state.indexLogEpoch!, seq: state.indexSeq };
    void agentService
      .resyncSessionsIndexV4({
        ...state.target,
        subscriptionId,
        base,
        runtimePolicy: "existing-only",
        ...(effectiveForceSnapshot ? { forceSnapshot: true } : {}),
      })
      .then((result) => {
        if (!isLiveState(state) || state.indexRecovery !== recovery) return;
        if (
          state.indexSubscriptionId !== subscriptionId ||
          result.ack.subscriptionId !== subscriptionId
        ) {
          discardIndexRecovery(state);
          void ctx.subscribeIndexTopic(state, "resync-ack-mismatch", true);
          return;
        }
        recovery.ackReceived = true;
        recovery.forceSnapshot ||= result.ack.mode === "snapshot";
        settleIndexRecovery(state, recovery);
      })
      .catch((error) => {
        if (!isLiveState(state) || state.indexRecovery !== recovery) return;
        discardIndexRecovery(state);
        logger.warn(
          undefined,
          `task index sessions-index resync 失败，改用新鲜订阅 workspace=${state.target.workspacePath}`,
          error,
        );
        void ctx.subscribeIndexTopic(state, "resync-failed", true);
      });
  }

  function requestConfigRecovery(state: WorkspaceIngestState, forceSnapshot = false): void {
    const subscriptionId = state.configSubscriptionId;
    if (!subscriptionId || !isLiveState(state)) return;
    const active = state.configRecovery;
    if (active) {
      if (forceSnapshot && !active.forceSnapshot) {
        active.upgradeToSnapshot = true;
        settleConfigRecovery(state, active);
      }
      return;
    }
    const effectiveForceSnapshot =
      forceSnapshot || !state.configHasAppliedBase || state.configLogEpoch === null;
    const recovery: TopicRecoveryState = {
      generation: ++state.configRecoveryGeneration,
      subscriptionId,
      forceSnapshot: effectiveForceSnapshot,
      ackReceived: false,
      frameApplied: false,
      upgradeToSnapshot: false,
      postRecoveryGapPending: false,
      frameDeadline: null,
    };
    state.configRecovery = recovery;
    const base = effectiveForceSnapshot
      ? null
      : { logEpoch: state.configLogEpoch!, seq: state.configSeq };
    void agentService
      .resyncWorkspaceConfigV4({
        ...state.target,
        subscriptionId,
        base,
        runtimePolicy: "existing-only",
        ...(effectiveForceSnapshot ? { forceSnapshot: true } : {}),
      })
      .then((result) => {
        if (!isLiveState(state) || state.configRecovery !== recovery) return;
        if (
          state.configSubscriptionId !== subscriptionId ||
          result.ack.subscriptionId !== subscriptionId
        ) {
          discardConfigRecovery(state);
          void ctx.subscribeConfigTopic(state, "resync-ack-mismatch", true);
          return;
        }
        recovery.ackReceived = true;
        recovery.forceSnapshot ||= result.ack.mode === "snapshot";
        settleConfigRecovery(state, recovery);
      })
      .catch((error) => {
        if (!isLiveState(state) || state.configRecovery !== recovery) return;
        discardConfigRecovery(state);
        logger.warn(
          undefined,
          `task index workspace-config resync 失败，改用新鲜订阅 workspace=${state.target.workspacePath}`,
          error,
        );
        void ctx.subscribeConfigTopic(state, "resync-failed", true);
      });
  }

  function handleIndexGap(state: WorkspaceIngestState, deliveryKind: TopicDeliveryKind): void {
    if (deliveryKind === "recovery") {
      const recovery = state.indexRecovery;
      if (!recovery) return;
      if (recovery.forceSnapshot) {
        // 强制 snapshot 仍断档说明当前 same-sub 流已不可证，
        // 不能继续猜测拼接，改为该 topic 的新代 snapshot 订阅。
        discardIndexRecovery(state);
        void ctx.subscribeIndexTopic(state, "force-recovery-gap", true);
      } else {
        requestIndexRecovery(state, true);
      }
      return;
    }
    requestIndexRecovery(state);
  }

  function handleConfigGap(state: WorkspaceIngestState, deliveryKind: TopicDeliveryKind): void {
    if (deliveryKind === "recovery") {
      const recovery = state.configRecovery;
      if (!recovery) return;
      if (recovery.forceSnapshot) {
        discardConfigRecovery(state);
        void ctx.subscribeConfigTopic(state, "force-recovery-gap", true);
      } else {
        requestConfigRecovery(state, true);
      }
      return;
    }
    requestConfigRecovery(state);
  }

  return {
    clearRecoveryDeadline,
    discardIndexRecovery,
    discardConfigRecovery,
    settleIndexRecovery,
    settleConfigRecovery,
    completeIndexRecoveryFrame,
    completeConfigRecoveryFrame,
    requestIndexRecovery,
    requestConfigRecovery,
    handleIndexGap,
    handleConfigGap,
  };
}
